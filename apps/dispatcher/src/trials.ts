import { randomUUID } from "node:crypto";
import {
  transaction,
  type ControlClient,
  type ControlPool,
} from "@harnesslab/control-db";
import type {
  DevDiagnosis,
  HarnessConfig,
  ModelSettings,
  MutableHarness,
  OptimizeResponse,
  RunManifest,
  TaskInput,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import { charge, readPrice, type Price } from "./accounting.ts";
import {
  canonical,
  digest,
  DispatchError,
  EVALUATOR_VERSION,
  FIXTURE_PRICE,
  FIXTURE_WORKER,
  OPTIMIZER_GRAPH,
  promptBundle,
  WORKER_GRAPH,
} from "./artifacts.ts";

const SEED = 20251106;
const DIAGNOSIS_COUNTS: Record<TaskInput["category"], number> = {
  schema_discovery: 5,
  multi_step_analytics: 7,
  data_inconsistencies: 5,
  tool_failures: 5,
  ambiguous_requests: 3,
  efficiency: 5,
};
export type Stage = "diagnose" | "screen" | "validate";
export type Meta = {
  id: string;
  category: TaskInput["category"];
  split: "dev" | "validation";
  variant_id: string;
  input_hash: string;
  fault_digest: string;
  dataset_digest: string;
  benchmark_digest: string;
};
export type Arm = { harness_id: string; hash: string; role: string };
export type Cell = {
  task_key: string;
  repeat: number;
  harness_id: string;
  run_id: string;
};
type Trial = {
  seed: number;
  worker: ModelSettings;
  optimizer: ModelSettings | null;
  optimizer_price: Price;
  diagnose: Meta[];
  screen: Meta[];
  validate: Meta[];
  concurrency: 1;
};
export type TrialExperiment = {
  mode: "fixture" | "live";
  status: string;
  stage: string;
  budget_exhausted: boolean;
  manifest: { price: Price; expected_runs: number; trial?: Trial };
};
export type LiveTrial = {
  mode: "live";
  principal: string;
  channel: string;
  maxSpend: bigint;
  worker: ModelSettings;
  optimizer: ModelSettings;
  price: Price;
  optimizerPrice: Price;
  devDigest: string;
  validationDigest: string;
};

export function diagnosisRoster<
  T extends { id: string; category: TaskInput["category"] },
>(roster: T[], fixture: boolean, seed = SEED): T[] {
  const order = (items: T[]) =>
    [...items].sort(
      (a, b) =>
        digest([seed, a.id]).localeCompare(digest([seed, b.id])) ||
        a.id.localeCompare(b.id),
    );
  if (fixture)
    return (
      ["schema_discovery", "tool_failures", "efficiency"] as const
    ).flatMap((category) =>
      roster.filter((task) => task.category === category).slice(0, 2),
    );
  return Object.entries(DIAGNOSIS_COUNTS).flatMap(([category, count]) =>
    order(roster.filter((task) => task.category === category)).slice(0, count),
  );
}

export function matchedOrder<T extends { hash: string }>(
  arms: T[],
  task: string,
  repeat: number,
  seed: number,
) {
  return [...arms].sort(
    (a, b) =>
      digest([seed, task, repeat, a.hash]).localeCompare(
        digest([seed, task, repeat, b.hash]),
      ) || a.hash.localeCompare(b.hash),
  );
}

function metadata(bundle: Awaited<ReturnType<typeof promptBundle>>): Meta[] {
  return bundle.manifest.tasks.map(({ id }) => {
    const { meta, dataset } = bundle.task(id);
    return {
      ...meta,
      dataset_digest: dataset.rows_digest,
      benchmark_digest: bundle.manifest.manifest_digest,
    };
  });
}

export async function readArms(db: ControlClient, id: string) {
  const { rows } = await db.query<Arm>(
    `SELECT a.harness_id,a.role,v.content_sha256 AS hash
    FROM hl.experiment_arms a JOIN hl.harness_versions v ON v.id=a.harness_id
    WHERE a.experiment_id=$1 ORDER BY a.ordinal`,
    [id],
  );
  return rows;
}

async function enqueue(
  db: ControlClient,
  id: string,
  key: string,
  kind: string,
  run: string | null,
  version: string,
  inputDigest: string,
) {
  await db.query(
    `WITH w AS (
      INSERT INTO hl.work_items(experiment_id,work_key,kind,run_id,graph_version,input_digest)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,generation
    ) INSERT INTO hl.outbox(work_id,generation) SELECT id,generation FROM w`,
    [id, key, kind, run, version, inputDigest],
  );
}

async function stageBudget(db: ControlClient, id: string, expense: bigint) {
  const {
    rows: [row],
  } = await db.query<{ fits: boolean }>(
    `SELECT
    NOT budget_exhausted AND spent_micros+reserved_micros+$2::bigint<=max_spend_micros AS fits
    FROM hl.experiments WHERE id=$1`,
    [id, expense.toString()],
  );
  if (!row?.fits)
    await db.query(
      "UPDATE hl.experiments SET budget_exhausted=true WHERE id=$1",
      [id],
    );
  return row?.fits === true;
}

async function schedule(
  db: ControlClient,
  id: string,
  exp: TrialExperiment,
  stage: Stage,
  arms: Arm[],
  tasks: Meta[],
  reuse: Cell[] = [],
) {
  const trial = exp.manifest.trial!;
  const repeats = stage === "validate" ? 3 : 1;
  const reused = new Map(
    reuse.map((cell) => [
      `${cell.harness_id}/${cell.task_key}/${cell.repeat}`,
      cell.run_id,
    ]),
  );
  const newCount = tasks.length * arms.length * repeats - reuse.length;
  if (
    !(await stageBudget(
      db,
      id,
      charge(exp.manifest.price, 12000n, 3000n) * BigInt(newCount),
    ))
  )
    return false;
  const roster: Cell[] = [];
  for (const task of tasks) {
    await db.query(
      `INSERT INTO hl.benchmark_tasks(benchmark_digest,task_key,split,category,dataset_digest,variant_id,input_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        task.benchmark_digest,
        task.id,
        task.split,
        task.category,
        task.dataset_digest,
        task.variant_id,
        task.input_hash,
      ],
    );
    for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const arm of matchedOrder(arms, task.id, repeat, trial.seed)) {
        const prior = reused.get(`${arm.harness_id}/${task.id}/${repeat}`);
        const run_id = prior ?? randomUUID();
        roster.push({
          task_key: task.id,
          repeat,
          harness_id: arm.harness_id,
          run_id,
        });
        if (prior) continue;
        const manifest: RunManifest = {
          schema_version: 1,
          run_id,
          mode: exp.mode,
          stage,
          repeat,
          task_key: task.id,
          task_input_hash: task.input_hash,
          config_hash: arm.hash,
          dataset_digest: task.dataset_digest,
          benchmark_digest: task.benchmark_digest,
          software_revision: "phase4-trial",
          evaluator_version: EVALUATOR_VERSION,
          safety_profile: "readonly-synthetic-v1",
          worker: trial.worker,
          worker_profile_digest: digest(trial.worker),
          price_profile_digest: digest(exp.manifest.price),
          schedule_seed: trial.seed,
        };
        if (!accepts("RunManifest", manifest))
          throw new DispatchError("invalid_manifest");
        await db.query(
          `INSERT INTO hl.task_runs(id,experiment_id,harness_id,benchmark_digest,task_key,stage,repeat,manifest)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            run_id,
            id,
            arm.harness_id,
            task.benchmark_digest,
            task.id,
            stage,
            repeat,
            manifest,
          ],
        );
        await enqueue(
          db,
          id,
          `execute_task/${run_id}`,
          "execute_task",
          run_id,
          WORKER_GRAPH,
          digest(manifest),
        );
      }
    }
  }
  await db.query(
    "INSERT INTO hl.trial_stages(experiment_id,stage,roster,roster_digest) VALUES($1,$2,$3,$4)",
    [id, stage, JSON.stringify(roster), digest(roster)],
  );
  await db.query("UPDATE hl.experiments SET stage=$2 WHERE id=$1", [id, stage]);
  return true;
}

export async function submitTrial(
  pool: ControlPool,
  root: string,
  key: string,
  live?: LiveTrial,
) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
    throw new DispatchError("invalid_idempotency_key");
  if (
    live &&
    (process.env.HL_MODE !== "live" ||
      !/^[0-9]+$/.test(process.env.HL_MAX_EXPERIMENT_MICRO_USD ?? "") ||
      live.maxSpend > BigInt(process.env.HL_MAX_EXPERIMENT_MICRO_USD!))
  )
    throw new DispatchError("live_disabled");
  const mode = live?.mode ?? "fixture";
  const dev = await promptBundle(root, "dev", mode);
  const devMeta = metadata(dev);
  const diagnosis = diagnosisRoster(devMeta, !live);
  const validation = live
    ? await promptBundle(root, "validation", "live")
    : null;
  if (
    live &&
    (dev.manifest.manifest_digest !== live.devDigest ||
      validation?.manifest.manifest_digest !== live.validationDigest ||
      !accepts("ModelSettings", live.worker) ||
      !accepts("ModelSettings", live.optimizer) ||
      live.optimizer.temperature !== null ||
      live.optimizer.top_p !== null ||
      live.optimizer.reasoning_effort !== null ||
      live.maxSpend <= 0n ||
      live.maxSpend > BigInt(Number.MAX_SAFE_INTEGER) ||
      !/^gpt-.+-\d{4}-\d{2}-\d{2}$/.test(live.worker.snapshot) ||
      !/^gpt-.+-\d{4}-\d{2}-\d{2}$/.test(live.optimizer.snapshot))
  )
    throw new DispatchError("invalid_trial_profile");
  const trial: Trial = {
    seed: SEED,
    concurrency: 1,
    worker: live?.worker ?? FIXTURE_WORKER,
    optimizer: live?.optimizer ?? null,
    optimizer_price: live?.optimizerPrice ?? FIXTURE_PRICE,
    diagnose: diagnosis,
    screen: live ? devMeta : diagnosis,
    validate: validation ? metadata(validation) : [],
  };
  if (
    diagnosis.length !== (live ? 30 : 6) ||
    (live && (trial.screen.length !== 60 || trial.validate.length !== 30))
  )
    throw new DispatchError("invalid_trial_roster");
  const price = live?.price ?? FIXTURE_PRICE;
  readPrice(price, digest(price));
  readPrice(trial.optimizer_price, digest(trial.optimizer_price));
  const manifest = {
    schema_version: 1,
    worker_graph_version: WORKER_GRAPH,
    optimizer_graph_version: OPTIMIZER_GRAPH,
    expected_runs: diagnosis.length,
    price,
    trial,
  };
  const principal = live?.principal ?? "local-trial";
  const channel = live?.channel ?? "fixture";
  const requestHash = digest({
    mode,
    channel,
    manifest,
    cap: live?.maxSpend.toString() ?? "0",
  });
  return transaction(pool, async (db) => {
    const {
      rows: [baseline],
    } = await db.query<Arm & { revision: number }>(
      `SELECT
      c.active_version_id AS harness_id,c.revision,v.content_sha256 AS hash,'baseline' AS role
      FROM hl.harness_channels c JOIN hl.harness_versions v ON v.id=c.active_version_id
      WHERE c.channel=$1`,
      [channel],
    );
    if (!baseline) throw new DispatchError("baseline_unavailable");
    const {
      rows: [created],
    } = await db.query<{ id: string }>(
      `INSERT INTO hl.experiments(
      baseline_id,channel,channel_revision,principal,idempotency_key,request_hash,mode,scope,max_spend_micros,manifest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(principal,idempotency_key) DO NOTHING RETURNING id`,
      [
        baseline.harness_id,
        channel,
        baseline.revision,
        principal,
        key,
        requestHash,
        mode,
        live ? "full_live" : "demo_fixture",
        live?.maxSpend.toString() ?? "0",
        manifest,
      ],
    );
    if (!created) {
      const {
        rows: [prior],
      } = await db.query<{ id: string; request_hash: string }>(
        "SELECT id,request_hash FROM hl.experiments WHERE principal=$1 AND idempotency_key=$2",
        [principal, key],
      );
      if (!prior || prior.request_hash !== requestHash)
        throw new DispatchError("idempotency_conflict");
      return prior.id;
    }
    await db.query(
      `INSERT INTO hl.experiment_arms(experiment_id,harness_id,role,ordinal,disposition)
      VALUES($1,$2,'baseline',0,'scheduled')`,
      [created.id, baseline.harness_id],
    );
    if (
      !(await schedule(
        db,
        created.id,
        {
          mode,
          status: "queued",
          stage: "diagnose",
          budget_exhausted: false,
          manifest,
        },
        "diagnose",
        [baseline],
        diagnosis,
      ))
    )
      throw new DispatchError("experiment_budget");
    return created.id;
  });
}

type Scored = Cell & {
  result_status: string;
  grade: { success: boolean } | null;
  safety_count: number | null;
  tool_calls: number | null;
  cost_micros: string | null;
  trace_digest: string | null;
};
async function stageResults(db: ControlClient, id: string, stage: Stage) {
  const {
    rows: [saved],
  } = await db.query<{ roster: Cell[] }>(
    "SELECT roster FROM hl.trial_stages WHERE experiment_id=$1 AND stage=$2",
    [id, stage],
  );
  if (!saved) throw new DispatchError("missing_trial_roster");
  const { rows } = await db.query<Scored>(
    `SELECT id AS run_id,harness_id,task_key,repeat,result_status,grade,
    safety_count,tool_calls,cost_micros,trace_digest FROM hl.task_runs WHERE experiment_id=$1 AND id=ANY($2::uuid[])`,
    [id, saved.roster.map((cell) => cell.run_id)],
  );
  const byId = new Map(rows.map((row) => [row.run_id, row]));
  const scores = saved.roster.flatMap((cell) => {
    const row = byId.get(cell.run_id);
    return row &&
      row.harness_id === cell.harness_id &&
      row.task_key === cell.task_key &&
      row.repeat === cell.repeat
      ? [row]
      : [];
  });
  return {
    scores,
    complete:
      scores.length === saved.roster.length &&
      scores.every(
        (row) =>
          !["pending", "cancelled", "infrastructure_error"].includes(
            row.result_status,
          ),
      ),
  };
}

function totals(scores: Scored[], arm: string) {
  const rows = scores.filter((row) => row.harness_id === arm);
  return {
    attempted: rows.length,
    successes: rows.filter((row) => row.grade?.success).length,
    calls: rows.reduce((n, row) => n + (row.tool_calls ?? 0), 0),
    cost: rows.reduce((n, row) => n + BigInt(row.cost_micros ?? 0), 0n),
    safe: rows.every((row) => row.safety_count === 0),
  };
}

export function shortlist(scores: Scored[], arms: Arm[], fixture: boolean) {
  const baseline = arms.find((arm) => arm.role === "baseline")!;
  const base = totals(scores, baseline.harness_id);
  const metric = (row: ReturnType<typeof totals>) =>
    fixture ? BigInt(row.calls) : row.cost;
  return arms
    .filter((arm) => arm.role === "candidate")
    .map((arm) => ({ arm, stats: totals(scores, arm.harness_id) }))
    .filter(
      ({ stats }) =>
        stats.attempted === base.attempted &&
        stats.safe &&
        stats.successes >= base.successes &&
        (stats.successes > base.successes ||
          (base.successes > 0 &&
            metric(base) > 0n &&
            10n * metric(stats) * BigInt(base.successes) <=
              9n * metric(base) * BigInt(stats.successes))),
    )
    .sort((a, b) => {
      if (a.stats.successes !== b.stats.successes)
        return b.stats.successes - a.stats.successes;
      const left = metric(a.stats),
        right = metric(b.stats);
      return left === right
        ? a.arm.hash.localeCompare(b.arm.hash)
        : left < right
          ? -1
          : 1;
    })
    .slice(0, 2)
    .map(({ arm }) => arm);
}

export async function closeTrial(
  db: ControlClient,
  id: string,
  exp: TrialExperiment,
  reason: string,
  failed = false,
) {
  const arms = await readArms(db, id);
  const { rows: stages } = await db.query<{
    stage: Stage;
    roster_digest: string;
  }>(
    "SELECT stage,roster_digest FROM hl.trial_stages WHERE experiment_id=$1 ORDER BY stage",
    [id],
  );
  const comparisons = [];
  for (const stage of stages) {
    const { scores, complete } = await stageResults(db, id, stage.stage);
    const armsWithStats = arms.map((arm) => {
      const stats = totals(scores, arm.harness_id);
      return {
        hash: arm.hash,
        role: arm.role,
        ...stats,
        cost: stats.cost.toString(),
      };
    });
    comparisons.push({
      stage: stage.stage,
      roster_digest: stage.roster_digest,
      complete,
      arms: armsWithStats,
      cells: scores.map((row) => ({
        run_id: row.run_id,
        task_key: row.task_key,
        repeat: row.repeat,
        harness_id: row.harness_id,
        success: row.grade?.success ?? false,
        trace_digest: row.trace_digest,
      })),
    });
  }
  const report = {
    schema_version: 1,
    mode: exp.mode,
    reason,
    eligibility:
      exp.mode === "fixture"
        ? "ineligible_fixture"
        : reason === "eligible_for_review"
          ? "eligible_for_review"
          : "ineligible",
    comparisons,
  };
  await db.query(
    `INSERT INTO hl.trial_reports(experiment_id,report,report_digest)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [id, report, digest(report)],
  );
  await db.query(
    `UPDATE hl.experiments SET stage='report',status=$2,completed_at=clock_timestamp()
    WHERE id=$1 AND status IN ('queued','running')`,
    [id, failed ? "failed" : "completed"],
  );
}

async function queueComparison(
  db: ControlClient,
  id: string,
  exp: TrialExperiment,
  reason: string,
  failed = false,
) {
  const key = `compare_and_advance/${reason}/${failed ? "failed" : "completed"}`;
  await enqueue(
    db,
    id,
    key,
    "compare_and_advance",
    null,
    "paired-gate-v1",
    digest({ id, stage: exp.stage, key }),
  );
}

export async function advanceTrial(
  db: ControlClient,
  id: string,
  exp: TrialExperiment,
) {
  if (!["queued", "running"].includes(exp.status)) return;
  if (exp.stage === "propose")
    return closeTrial(db, id, exp, "proposal_work_failed", true);
  if (exp.stage === "report") return;
  const stage = exp.stage as Stage;
  const { scores, complete } = await stageResults(db, id, stage);
  if (scores.some((row) => row.result_status === "pending")) return;
  if (!complete || exp.budget_exhausted) {
    if (stage === "diagnose")
      return closeTrial(db, id, exp, "incomplete_roster", true);
    return queueComparison(db, id, exp, "incomplete_roster", true);
  }
  const trial = exp.manifest.trial!;
  if (stage === "diagnose") {
    if (
      !(await stageBudget(db, id, charge(trial.optimizer_price, 12000n, 1500n)))
    )
      return closeTrial(db, id, exp, "optimizer_budget", true);
    await enqueue(
      db,
      id,
      "analyze_and_propose",
      "analyze_and_propose",
      null,
      OPTIMIZER_GRAPH,
      digest({ id, stage: "propose", trial }),
    );
    await db.query("UPDATE hl.experiments SET stage='propose' WHERE id=$1", [
      id,
    ]);
  } else if (stage === "screen") {
    const arms = await readArms(db, id);
    const finalists = shortlist(scores, arms, exp.mode === "fixture");
    await db.query(
      `UPDATE hl.experiment_arms SET disposition=CASE WHEN harness_id=ANY($2::uuid[])
      THEN 'shortlisted' ELSE 'screened_out' END WHERE experiment_id=$1 AND role='candidate'`,
      [id, finalists.map((arm) => arm.harness_id)],
    );
    if (exp.mode === "fixture")
      return queueComparison(
        db,
        id,
        exp,
        finalists.length ? "ineligible_fixture" : "no_candidate_survived",
      );
    if (!finalists.length)
      return queueComparison(db, id, exp, "no_candidate_survived");
    if (
      !(await schedule(
        db,
        id,
        exp,
        "validate",
        [arms.find((arm) => arm.role === "baseline")!, ...finalists],
        trial.validate,
      ))
    )
      return queueComparison(db, id, exp, "validation_budget", true);
  } else {
    await queueComparison(db, id, exp, "validation_compared");
  }
}

export function mutableView(config: HarnessConfig): MutableHarness {
  return {
    prompt: config.prompt,
    workflow: config.workflow,
    context: config.context,
    limits: {
      max_tool_calls: config.limits.max_tool_calls,
      max_retries_per_tool: config.limits.max_retries_per_tool,
    },
  };
}

export async function persistProposals(
  db: ControlClient,
  id: string,
  exp: TrialExperiment,
  diagnosis: DevDiagnosis,
  result: OptimizeResponse,
) {
  const baseline = (await readArms(db, id)).find(
    (arm) => arm.role === "baseline",
  )!;
  const {
    rows: [row],
  } = await db.query<{ config: HarnessConfig }>(
    "SELECT config FROM hl.harness_versions WHERE id=$1",
    [baseline.harness_id],
  );
  if (!row || !accepts("HarnessConfig", row.config))
    throw new DispatchError("invalid_baseline");
  for (const cluster of diagnosis.clusters) {
    await db.query(
      `INSERT INTO hl.failure_patterns(experiment_id,signature,count,evidence_refs,summary)
      VALUES($1,$2,$3,$4,$5)`,
      [
        id,
        cluster.signature,
        cluster.count,
        JSON.stringify(cluster.evidence_refs),
        cluster,
      ],
    );
  }
  const refs = new Set(
    diagnosis.clusters.flatMap((c) =>
      c.evidence_refs.map((ref) => digest(ref)),
    ),
  );
  const hashes = new Set<string>();
  for (const entry of result.dispositions) {
    const proposal = entry.proposal;
    let reason = entry.reason;
    let versionId: null | string = null;
    if (proposal && !reason) {
      const candidate = structuredClone(row.config);
      const sections = candidate as unknown as Record<
        string,
        Record<string, unknown>
      >;
      const paths = new Set<string>();
      for (const operation of proposal.patch) {
        const [, section, key] = operation.path.split("/") as [
          string,
          string,
          string,
        ];
        if (
          paths.has(operation.path) ||
          sections[section]?.[key] === operation.value
        ) {
          reason = "invalid_replacement";
          break;
        }
        paths.add(operation.path);
        sections[section]![key] = operation.value;
      }
      const hash = digest(candidate);
      if (
        !accepts("HarnessConfig", candidate) ||
        digest(mutableView(candidate)) !== entry.candidate_view_digest
      )
        reason = "invalid_candidate";
      if (proposal.evidence_refs.some((ref) => !refs.has(digest(ref))))
        reason = "invalid_evidence_lineage";
      if (hashes.has(hash) || hash === baseline.hash)
        reason = "duplicate_candidate";
      if (!reason) {
        const bytes = Buffer.from(canonical(candidate));
        await db.query(
          `INSERT INTO hl.harness_versions(content_sha256,config,canonical_json,yaml_bytes,parent_id)
          VALUES($1,$2,$3,$3,$4) ON CONFLICT(content_sha256) DO NOTHING`,
          [hash, candidate, bytes, baseline.harness_id],
        );
        const {
          rows: [version],
        } = await db.query<{ id: string }>(
          "SELECT id FROM hl.harness_versions WHERE content_sha256=$1",
          [hash],
        );
        if (!version) throw new DispatchError("candidate_unavailable");
        versionId = version.id;
        hashes.add(hash);
        await db.query(
          `INSERT INTO hl.experiment_arms(experiment_id,harness_id,role,ordinal,disposition)
          VALUES($1,$2,'candidate',$3,'scheduled')`,
          [id, versionId, entry.ordinal + 1],
        );
      }
    }
    await db.query(
      `INSERT INTO hl.optimization_proposals(experiment_id,ordinal,parent_id,result_harness_id,patch,
      rejected_summary,rationale,evidence_refs,status,reason,expected_metric,direction)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        entry.ordinal,
        baseline.harness_id,
        versionId,
        versionId && proposal ? JSON.stringify(proposal.patch) : null,
        versionId ? null : "Rejected optimizer proposal",
        versionId ? proposal?.rationale : null,
        JSON.stringify(versionId ? (proposal?.evidence_refs ?? []) : []),
        versionId ? "accepted" : "rejected",
        versionId ? null : (reason ?? "malformed_proposal"),
        versionId ? proposal?.expected_metric : null,
        versionId ? proposal?.direction : null,
      ],
    );
  }
  if (!hashes.size) return closeTrial(db, id, exp, "no_valid_proposal");
  const { scores } = await stageResults(db, id, "diagnose");
  if (
    !(await schedule(
      db,
      id,
      exp,
      "screen",
      await readArms(db, id),
      exp.manifest.trial!.screen,
      scores,
    ))
  )
    return closeTrial(db, id, exp, "screen_budget", true);
}
