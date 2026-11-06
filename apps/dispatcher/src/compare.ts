import { transaction, type ControlPool } from "@harnesslab/control-db";
import type {
  CompareRequest,
  ComparisonCell,
  ComparisonRun,
  EvaluationReport,
  Grade,
  RunManifest,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import {
  canonical,
  digest,
  DispatchError,
  EVALUATOR_VERSION,
} from "./artifacts.ts";
import { endpoint, postJson, type Services } from "./delivery.ts";
import {
  closeTrial,
  readArms,
  type Arm,
  type Cell,
  type Meta,
  type TrialExperiment,
} from "./trials.ts";
import { experiment, lockActive, type Lease } from "./work.ts";

type Stage = "screen" | "validate";
type StageRow = { stage: Stage; roster: Cell[]; roster_digest: string };
type Event = {
  kind: string;
  code: string;
  call: string | null;
  tool: string | null;
};
type Run = {
  id: string;
  task_key: string;
  repeat: number;
  harness_id: string;
  stage: string;
  result_status: string;
  manifest: RunManifest;
  envelope_matches: boolean;
  grade: Grade | null;
  cost_micros: string | null;
  tool_calls: number | null;
  safety_count: number | null;
  latency_ms: number | null;
  trace_digest: string | null;
  replay_digest: string | null;
  events: Event[];
};

const INVALID = new Set([
  "schema_error",
  "missing_relation",
  "syntax_error",
  "invalid_sql",
  "malformed_sql_action",
  "sql_policy",
  "sql_too_large",
]);
const SQL = "execute_readonly_sql";

function facts(row: Run, fault: boolean): ComparisonRun | null {
  if (row.result_status === "pending") return null;
  const attempts = new Set<string>();
  const invalid = new Set<string>();
  let encountered = false;
  let recovered = false;
  for (const event of row.events) {
    if (event.kind === "fault" && event.tool === SQL) encountered = true;
    if (
      event.kind === "tool_result" &&
      event.tool === SQL &&
      event.code === "ok" &&
      encountered
    )
      recovered = true;
    if (event.call && event.tool === SQL && event.kind === "tool_request")
      attempts.add(event.call);
    if (
      event.call &&
      ((event.tool === SQL && event.kind === "tool_result") ||
        (event.kind === "policy_decision" &&
          ["sql_too_large", "malformed_sql_action"].includes(event.code))) &&
      INVALID.has(event.code)
    ) {
      attempts.add(event.call);
      invalid.add(event.call);
    }
  }
  const success = row.grade?.success ?? false;
  return {
    run_id: row.id,
    trace_digest: row.trace_digest,
    complete:
      !!row.grade &&
      !!row.trace_digest &&
      !!row.replay_digest &&
      !["infrastructure_error", "cancelled"].includes(row.result_status) &&
      !row.grade.reasons.includes("usage_unknown"),
    success,
    latency_ms: row.latency_ms ?? 0,
    tool_calls: row.tool_calls ?? 0,
    worker_cost_microusd: Number(row.cost_micros ?? 0),
    invalid_sql_attempts: invalid.size,
    sql_attempts: attempts.size,
    recovered: fault && success && recovered,
    safety_violations: row.safety_count ?? 0,
  };
}

function pinned(
  row: Run,
  task: Meta,
  arm: Arm,
  exp: TrialExperiment,
  repeat: number,
  stage: Stage,
) {
  const trial = exp.manifest.trial!;
  const m = row.manifest;
  return (
    accepts("RunManifest", m) &&
    m.run_id === row.id &&
    row.task_key === task.id &&
    m.task_key === task.id &&
    row.harness_id === arm.harness_id &&
    m.config_hash === arm.hash &&
    row.repeat === repeat &&
    m.repeat === repeat &&
    m.mode === exp.mode &&
    (row.stage === stage ||
      (stage === "screen" &&
        arm.role === "baseline" &&
        row.stage === "diagnose" &&
        trial.diagnose.some((t) => t.id === task.id))) &&
    m.stage === row.stage &&
    m.benchmark_digest === task.benchmark_digest &&
    m.dataset_digest === task.dataset_digest &&
    m.task_input_hash === task.input_hash &&
    m.evaluator_version === EVALUATOR_VERSION &&
    m.worker_profile_digest === digest(trial.worker) &&
    digest(m.worker) === m.worker_profile_digest &&
    m.price_profile_digest === digest(exp.manifest.price) &&
    m.schedule_seed === trial.seed &&
    m.software_revision === "phase4-trial" &&
    row.envelope_matches &&
    row.cost_micros !== null &&
    row.safety_count !== null &&
    row.tool_calls !== null &&
    row.latency_ms !== null &&
    row.replay_digest ===
      digest({
        evaluator_version: m.evaluator_version,
        benchmark_digest: m.benchmark_digest,
        trace_digest: row.trace_digest,
        grade: row.grade,
      })
  );
}

function comparison(
  id: string,
  exp: TrialExperiment,
  stage: StageRow,
  baseline: Arm,
  candidate: Arm,
  runs: Map<string, Run>,
  devSafe: boolean,
): CompareRequest {
  const trial = exp.manifest.trial!;
  const repeats = stage.stage === "validate" ? 3 : 1;
  const tasks = trial[stage.stage];
  const byCell = new Map(
    stage.roster.map((cell) => [
      `${cell.task_key}/${cell.repeat}/${cell.harness_id}`,
      cell.run_id,
    ]),
  );
  let provenance =
    !exp.budget_exhausted &&
    digest(stage.roster) === stage.roster_digest &&
    byCell.size === stage.roster.length;
  const cells: ComparisonCell[] = [];
  for (const task of tasks) {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const recoverable_fault = task.fault_digest !== digest(null);
      const pair = [baseline, candidate].map((arm) => {
        const run = runs.get(
          byCell.get(`${task.id}/${repeat}/${arm.harness_id}`) ?? "",
        );
        if (!run || !pinned(run, task, arm, exp, repeat, stage.stage))
          provenance = false;
        return run ? facts(run, recoverable_fault) : null;
      });
      cells.push({
        task_key: task.id,
        category: task.category,
        repeat,
        recoverable_fault,
        baseline: pair[0] ?? null,
        candidate: pair[1] ?? null,
      });
    }
  }
  return {
    schema_version: 1,
    experiment_id: id,
    baseline_hash: baseline.hash,
    candidate_hash: candidate.hash,
    scope:
      stage.stage === "validate"
        ? "validation"
        : exp.mode === "fixture"
          ? "dev_fixture"
          : "dev_screen",
    mode: exp.mode,
    manifest_digest: digest(exp.manifest),
    roster_digest: stage.roster_digest,
    provenance_valid: provenance,
    candidate_dev_safe: devSafe,
    seed: trial.seed,
    cells,
  };
}

function passed(report: EvaluationReport, gate: string) {
  return report.gates.some(
    (item) => item.gate === gate && item.status === "passed",
  );
}

function difference(a: EvaluationReport, b: EvaluationReport) {
  // Validation finalists share the same baseline and number of scheduled cells.
  const quality = Number(passed(b, "quality")) - Number(passed(a, "quality"));
  const successes = b.candidate.successes - a.candidate.successes;
  const cost =
    a.candidate.worker_cost_microusd - b.candidate.worker_cost_microusd;
  return (
    quality ||
    successes ||
    cost ||
    a.candidate_hash.localeCompare(b.candidate_hash)
  );
}

export async function compareTrial(
  pool: ControlPool,
  item: Lease & { experiment_id: string },
  services: Services,
  signal: AbortSignal,
) {
  const id = item.experiment_id;
  const { exp, stages, arms, work_key } = await transaction(
    pool,
    async (db) => {
      const work = await lockActive(db, item);
      const exp = await experiment(db, work);
      if (
        !exp.manifest.trial ||
        work.input_digest !==
          digest({ id, stage: exp.stage, key: work.work_key })
      )
        throw new DispatchError("invalid_comparison_work");
      const { rows: stages } = await db.query<StageRow>(
        "SELECT stage,roster,roster_digest FROM hl.trial_stages WHERE experiment_id=$1 AND stage IN ('screen','validate') ORDER BY stage",
        [id],
      );
      return {
        exp,
        stages,
        arms: await readArms(db, id),
        work_key: work.work_key,
      };
    },
  );
  const baseline = arms.find((arm) => arm.role === "baseline");
  if (!baseline) throw new DispatchError("missing_baseline");
  const { rows } = await pool.query<Run>(
    `SELECT r.id,r.task_key,r.repeat,r.harness_id,r.stage,r.result_status,r.manifest,
      COALESCE(r.envelope->'manifest'=r.manifest AND r.envelope->>'trace_digest'=r.trace_digest,false) AS envelope_matches,
      r.grade,r.cost_micros,r.tool_calls,r.safety_count,r.latency_ms,r.trace_digest,r.replay_digest,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind,'code',outcome_code,
        'call',correlation_id,'tool',COALESCE(payload->'call'->>'name',payload->>'name',payload->>'tool')) ORDER BY seq)
        FROM hl.trace_events WHERE run_id=r.id AND kind IN ('tool_request','tool_result','fault','policy_decision')),
        '[]'::jsonb) AS events
      FROM hl.task_runs r WHERE r.experiment_id=$1 AND r.id=ANY($2::uuid[])`,
    [
      id,
      [
        ...new Set(
          stages.flatMap((stage) => stage.roster.map((cell) => cell.run_id)),
        ),
      ],
    ],
  );
  const runs = new Map(rows.map((row) => [row.id, row]));
  const comparisons: {
    request: CompareRequest;
    report: EvaluationReport;
    arm: Arm;
  }[] = [];
  const service = endpoint(
    services.evaluator.url.origin,
    "/internal/v1/compare",
    services.evaluator.token,
  );
  for (const arm of arms.filter((arm) => arm.role === "candidate")) {
    let devSafe = false;
    for (const stage of stages) {
      if (
        stage.stage === "validate" &&
        !stage.roster.some((cell) => cell.harness_id === arm.harness_id)
      )
        continue;
      const request = comparison(id, exp, stage, baseline, arm, runs, devSafe);
      if (!accepts("CompareRequest", request))
        throw new DispatchError("invalid_comparison_input");
      if (stage.stage === "screen") {
        devSafe =
          request.provenance_valid &&
          request.cells.every(
            (cell) =>
              cell.candidate?.complete &&
              cell.candidate.safety_violations === 0,
          );
      }
      const output = await postJson(
        service,
        request,
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      );
      if (!accepts("EvaluationReport", output))
        throw new DispatchError("invalid_comparison");
      const { report_digest, ...body } = output;
      if (
        report_digest !== digest(body) ||
        output.winner ||
        output.evidence_digest !== digest(request) ||
        output.manifest_digest !== request.manifest_digest ||
        output.roster_digest !== request.roster_digest ||
        output.mode !== request.mode ||
        output.scope !== request.scope ||
        output.baseline_hash !== request.baseline_hash ||
        output.candidate_hash !== request.candidate_hash ||
        output.experiment_id !== id ||
        output.policy_version !== "paired-gate-v1"
      )
        throw new DispatchError("comparison_provenance");
      comparisons.push({ report: output, request, arm });
    }
  }
  const winner = comparisons
    .map(({ report }) => report)
    .filter(
      (report) =>
        report.scope === "validation" &&
        report.mode === "live" &&
        report.complete &&
        ["provenance", "safety", "regressions"].every((gate) =>
          passed(report, gate),
        ) &&
        (passed(report, "quality") || passed(report, "efficiency")),
    )
    .sort(difference)[0];
  await transaction(pool, async (db) => {
    const work = await lockActive(db, item);
    const current = await experiment(db, work);
    if (current.status === "cancelled") {
      await db.query(
        "UPDATE hl.work_items SET state='failed',lease_until=NULL,lease_token=NULL WHERE id=$1",
        [work.id],
      );
      return;
    }
    if (
      current.stage !== exp.stage ||
      current.budget_exhausted !== exp.budget_exhausted
    )
      throw new DispatchError("comparison_state_changed");
    for (const { request, report, arm } of comparisons) {
      const { report_digest, ...comparison } = report;
      const body = { ...comparison, winner: report === winner };
      const reportDigest = body.winner ? digest(body) : report_digest;
      const {
        rows: [row],
      } = await db.query<{ id: string }>(
        `INSERT INTO hl.evaluation_reports(experiment_id,harness_id,scope,policy_version,roster_digest,
          metrics_and_gates,evidence_digest,report_digest,complete,winner,canonical_report)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          id,
          arm.harness_id,
          body.scope,
          body.policy_version,
          body.roster_digest,
          { ...body, report_digest: reportDigest },
          body.evidence_digest,
          reportDigest,
          body.complete,
          body.winner,
          Buffer.from(canonical(body)),
        ],
      );
      await db.query(
        "INSERT INTO hl.evaluation_evidence(report_id,request_bytes,manifest_bytes) VALUES($1,$2,$3)",
        [
          row!.id,
          Buffer.from(canonical(request)),
          Buffer.from(canonical(exp.manifest)),
        ],
      );
    }
    const [, reason, status] = work_key.split("/");
    const result =
      reason === "validation_compared"
        ? winner
          ? "eligible_for_review"
          : "no_qualifying_candidate"
        : reason!;
    await closeTrial(db, id, current, result, status === "failed");
    await db.query(
      "UPDATE hl.work_items SET state='done',lease_until=NULL,lease_token=NULL WHERE id=$1",
      [work.id],
    );
  });
}
