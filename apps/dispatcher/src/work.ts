import {
  transaction,
  type ControlClient,
  type ControlPool,
} from "@harnesslab/control-db";
import type {
  DevDiagnosis,
  OptimizeResponse,
  ExecuteTaskResponse,
  Grade,
  GradeTaskResponse,
  HarnessConfig,
  QueueReference,
  RunEnvelope,
  RunManifest,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import {
  charge,
  readPrice,
  replayTraceDigest,
  runMetrics,
  unknownUsage,
} from "./accounting.ts";
import { digest, DispatchError } from "./artifacts.ts";
import {
  advanceTrial,
  closeTrial,
  persistProposals,
  type TrialExperiment,
} from "./trials.ts";

const LEASE_MS = 15000;
type WorkKind = "execute_task" | "analyze_and_propose" | "compare_and_advance";
type WorkRow = {
  id: string;
  experiment_id: string;
  kind: WorkKind;
  work_key: string;
  run_id: string | null;
  generation: number;
  fence: number;
  attempts: number;
  effect_started: boolean;
  reservation_micros: string | null;
  graph_version: string;
  input_digest: string;
  lease_token: string;
};
type RunRow = {
  manifest: RunManifest;
  envelope: RunEnvelope | null;
  config: HarnessConfig;
};
type ExperimentRow = TrialExperiment;
export type Lease = Pick<
  WorkRow,
  "id" | "fence" | "lease_token" | "graph_version"
>;

export function safePayload(value: unknown): boolean {
  return !/postgres(?:ql)?:\/\/|\bpassword\s*=|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/i.test(
    JSON.stringify(value),
  );
}

export async function lockActive(db: ControlClient, lease: Lease) {
  const {
    rows: [item],
  } = await db.query<WorkRow>(
    `SELECT * FROM hl.work_items WHERE id=$1 AND fence=$2 AND lease_token=$3
       AND state='running' AND lease_until>clock_timestamp() FOR UPDATE`,
    [lease.id, lease.fence, lease.lease_token],
  );
  if (!item) throw new DispatchError("stale_lease");
  return item;
}

export async function experiment(db: ControlClient, item: WorkRow) {
  const {
    rows: [record],
  } = await db.query<ExperimentRow>(
    "SELECT * FROM hl.experiments WHERE id=$1 FOR UPDATE",
    [item.experiment_id],
  );
  if (!record) throw new DispatchError("invalid_experiment");
  if (["queued", "running"].includes(record.status)) {
    const expired = await db.query(
      `UPDATE hl.experiments SET status='cancelled',stage='report',completed_at=clock_timestamp()
       WHERE id=$1 AND EXISTS(SELECT 1 FROM hl.public_experiments
           WHERE experiment_id=$1 AND deadline<=clock_timestamp())`,
      [item.experiment_id],
    );
    if (expired.rowCount)
      return { ...record, status: "cancelled", stage: "report" };
  }
  return record;
}

export async function readRun(db: ControlClient | ControlPool, runId: string) {
  const {
    rows: [run],
  } = await db.query<RunRow>(
    `SELECT r.manifest,r.envelope,h.config FROM hl.task_runs r
      JOIN hl.harness_versions h ON h.id=r.harness_id WHERE r.id=$1`,
    [runId],
  );
  if (
    !run ||
    !accepts("RunManifest", run.manifest) ||
    !accepts("HarnessConfig", run.config) ||
    digest(run.config) !== run.manifest.config_hash
  )
    throw new DispatchError("invalid_manifest");
  return run;
}

export async function claim(pool: ControlPool, ref: QueueReference) {
  return transaction(pool, async (db) => {
    const {
      rows: [item],
    } = await db.query<WorkRow>(
      `UPDATE hl.work_items SET state='running',fence=fence+1,attempts=attempts+1,
           lease_token=gen_random_uuid(),lease_until=clock_timestamp()+($3::int * interval '1 ms')
         WHERE id=$1 AND generation=$2 AND state='queued' AND attempts<3
           AND next_at<=clock_timestamp() RETURNING *`,
      [ref.work_id, ref.generation, LEASE_MS],
    );
    if (!item) return null;
    const exp = await experiment(db, item);
    if (
      (exp.status === "cancelled" || exp.budget_exhausted) &&
      item.reservation_micros === null
    ) {
      await terminal(
        db,
        item,
        exp,
        null,
        null,
        exp.status === "cancelled" ? "cancelled" : "experiment_budget",
      );
      return null;
    }
    await db.query(
      `UPDATE hl.public_experiments SET deadline=clock_timestamp()+interval '120 seconds'
       WHERE experiment_id=$1 AND deadline IS NULL`,
      [item.experiment_id],
    );
    await db.query(
      "UPDATE hl.experiments SET status='running' WHERE id=$1 AND status='queued'",
      [item.experiment_id],
    );
    return item;
  });
}

export async function renew(pool: ControlPool, lease: Lease) {
  const result = await pool.query(
    `UPDATE hl.work_items SET lease_until=clock_timestamp()+($4::int * interval '1 ms')
       WHERE id=$1 AND fence=$2 AND lease_token=$3 AND state='running' AND lease_until>clock_timestamp()
       AND NOT EXISTS(SELECT 1 FROM hl.experiments e WHERE e.id=hl.work_items.experiment_id AND e.status='cancelled')
       AND NOT EXISTS(SELECT 1 FROM hl.public_experiments p WHERE p.experiment_id=hl.work_items.experiment_id
           AND p.deadline<=clock_timestamp())`,
    [lease.id, lease.fence, lease.lease_token, LEASE_MS],
  );
  return result.rowCount === 1;
}

export async function reserveAndMark(
  pool: ControlPool,
  lease: Lease,
  run: RunRow,
) {
  return transaction(pool, async (db) => {
    const item = await lockActive(db, lease);
    const exp = await experiment(db, item);
    if (
      exp.mode !== run.manifest.mode ||
      item.input_digest !== digest(run.manifest)
    )
      throw new DispatchError("invalid_manifest");
    if (exp.status === "cancelled" || exp.budget_exhausted) {
      await terminal(
        db,
        item,
        exp,
        null,
        null,
        exp.status === "cancelled" ? "cancelled" : "experiment_budget",
      );
      return false;
    }
    if (item.effect_started && exp.mode === "live")
      throw new DispatchError("ambiguous_live_effect");
    const price = readPrice(
      exp.manifest.price,
      run.manifest.price_profile_digest,
    );
    const limit =
      exp.mode === "fixture"
        ? 0n
        : charge(
            price,
            BigInt(run.config.limits.max_input_tokens),
            BigInt(run.config.limits.max_output_tokens),
          );
    if (item.reservation_micros === null) {
      const reserved = await db.query(
        `UPDATE hl.experiments SET reserved_micros=reserved_micros+$2
         WHERE id=$1 AND spent_micros+reserved_micros+$2::bigint <= max_spend_micros`,
        [item.experiment_id, limit.toString()],
      );
      if (!reserved.rowCount) {
        await db.query(
          "UPDATE hl.experiments SET budget_exhausted=true WHERE id=$1",
          [item.experiment_id],
        );
        await terminal(db, item, exp, null, null, "experiment_budget");
        return false;
      }
    }
    await db.query(
      `UPDATE hl.work_items SET reservation_micros=COALESCE(reservation_micros,$2),
           effect_started=$3,worker_deadline=COALESCE(worker_deadline, LEAST(clock_timestamp()+interval '90 seconds',
             (SELECT deadline FROM hl.public_experiments WHERE experiment_id=$4)))
           WHERE id=$1`,
      [item.id, limit.toString(), exp.mode === "live", item.experiment_id],
    );
    return true;
  });
}

function validateWorkerResult(
  item: WorkRow,
  pinned: RunManifest,
  output: ExecuteTaskResponse,
) {
  if (
    !accepts("ExecuteTaskResponse", output) ||
    !safePayload(output) ||
    digest(output.run.manifest) !== digest(pinned) ||
    output.run.trace_digest !== replayTraceDigest(output.run.events) ||
    output.graph.graph_kind !== "worker" ||
    output.graph.graph_version !== item.graph_version ||
    output.run.events.some(
      (event, seq) =>
        event.seq !== seq ||
        event.run_id !== item.run_id ||
        event.elapsed_ms > 100000 ||
        (seq > 0 &&
          event.elapsed_ms < output.run.events[seq - 1]!.elapsed_ms) ||
        event.kind === "grade",
    ) ||
    output.graph.events.some(
      (event, seq) =>
        event.seq !== seq ||
        (seq > 0 &&
          event.elapsed_ms < output.graph.events[seq - 1]!.elapsed_ms) ||
        event.elapsed_ms > 100000 ||
        (event.evidence_seq !== null &&
          event.evidence_seq >= output.run.events.length),
    )
  )
    throw new DispatchError("invalid_worker_result");
}

export async function saveEnvelope(
  pool: ControlPool,
  lease: Lease,
  output: ExecuteTaskResponse,
) {
  await transaction(pool, async (db) => {
    const item = await lockActive(db, lease);
    if (!item.run_id) throw new DispatchError("invalid_work");
    const pinned = await readRun(db, item.run_id);
    validateWorkerResult(item, pinned.manifest, output);
    const saved = await db.query(
      "UPDATE hl.task_runs SET envelope=$2 WHERE id=$1 AND envelope IS NULL AND result_status='pending'",
      [item.run_id, output.run],
    );
    if (saved.rowCount !== 1) throw new DispatchError("duplicate_envelope");
    await db.query(
      "INSERT INTO hl.graph_projections(work_id,run_id,projection) VALUES ($1,$2,$3)",
      [item.id, item.run_id, output.graph],
    );
  });
}

async function appendTrace(db: ControlClient, run: RunEnvelope, grade: Grade) {
  const last = run.events.at(-1)!;
  const events = [
    ...run.events,
    {
      run_id: run.manifest.run_id,
      seq: last.seq + 1,
      kind: "grade",
      elapsed_ms: last.elapsed_ms,
      outcome_code: grade.success ? "passed" : "failed",
      correlation_id: null,
      payload: grade,
    },
  ];
  await db.query(
    `INSERT INTO hl.trace_events(run_id,seq,kind,outcome_code,elapsed_ms,correlation_id,payload)
       SELECT $1,seq,kind,outcome_code,elapsed_ms,correlation_id,payload FROM jsonb_to_recordset($2::jsonb)
         AS e(seq integer,kind text,outcome_code text,elapsed_ms bigint,correlation_id text,payload jsonb)`,
    [run.manifest.run_id, JSON.stringify(events)],
  );
}

async function advance(db: ControlClient, item: WorkRow, exp: ExperimentRow) {
  if (exp.manifest.trial) return advanceTrial(db, item.experiment_id, exp);
  const {
    rows: [counts],
  } = await db.query<{ total: number; pending: number; infra: number }>(
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE result_status='pending')::int AS pending,
       count(*) FILTER (WHERE result_status IN ('infrastructure_error','cancelled'))::int AS infra
     FROM hl.task_runs WHERE experiment_id=$1 AND stage=$2`,
    [item.experiment_id, exp.stage],
  );
  if (!counts || counts.pending > 0) return;
  // Phase 3 runs a single diagnosis roster. Phase 4 supplies subsequent stage scheduling.
  await db.query(
    `UPDATE hl.experiments SET stage='report',completed_at=clock_timestamp(),
         status=CASE WHEN $3 OR budget_exhausted THEN 'failed' ELSE 'completed' END
      WHERE id=$1 AND stage=$2 AND status IN ('queued','running')`,
    [
      item.experiment_id,
      exp.stage,
      counts.infra > 0 || counts.total !== exp.manifest.expected_runs,
    ],
  );
}

async function terminal(
  db: ControlClient,
  item: WorkRow,
  exp: ExperimentRow,
  run: RunEnvelope | null,
  evaluation: GradeTaskResponse | null,
  failure: string | null,
) {
  const reserved = BigInt(item.reservation_micros ?? 0);
  const metrics = run
    ? runMetrics(run)
    : { input: 0n, output: 0n, safety: 0, calls: 0, latency: 0 };
  const uncertain =
    exp.mode === "live" && item.effect_started && (!run || unknownUsage(run));
  const status = uncertain
    ? "infrastructure_error"
    : failure === "cancelled"
      ? "cancelled"
      : failure === "experiment_budget"
        ? "budget_exhausted"
        : failure
          ? "infrastructure_error"
          : (run?.result ?? "infrastructure_error");
  const cost =
    exp.mode === "fixture"
      ? 0n
      : uncertain
        ? reserved
        : run
          ? charge(
              readPrice(exp.manifest.price, run.manifest.price_profile_digest),
              metrics.input,
              metrics.output,
            )
          : 0n;
  const grade: Grade =
    uncertain || !evaluation || failure
      ? {
          schema_version: 1,
          success: false,
          reasons: [
            ...new Set([
              status,
              ...(failure && failure !== status ? [failure] : []),
              ...(uncertain ? ["usage_unknown"] : []),
            ]),
          ].sort(),
        }
      : evaluation.grade;
  if (item.run_id) {
    const completed = await db.query(
      `UPDATE hl.task_runs SET result_status=$2,answer=$3,grade=$4,replay_digest=$5,trace_digest=$6,
        latency_ms=$7,input_tokens=$8,output_tokens=$9,tool_calls=$10,safety_count=$11,cost_micros=$12,
        completed_at=clock_timestamp() WHERE id=$1 AND result_status='pending'`,
      [
        item.run_id,
        status,
        run?.answer ?? null,
        grade,
        uncertain ? null : (evaluation?.replay_digest ?? null),
        run?.trace_digest ?? null,
        metrics.latency,
        metrics.input.toString(),
        metrics.output.toString(),
        metrics.calls,
        metrics.safety,
        cost.toString(),
      ],
    );
    if (completed.rowCount !== 1)
      throw new DispatchError("duplicate_terminal_result");
    if (run) await appendTrace(db, run, grade);
    else
      await db.query(
        `INSERT INTO hl.trace_events(run_id,seq,kind,outcome_code,elapsed_ms,payload)
       VALUES ($1,0,'grade','failed',0,$2)`,
        [item.run_id, grade],
      );
  }
  if (item.kind === "analyze_and_propose") {
    await db.query(
      "INSERT INTO hl.optimizer_usage(work_id,usage,cost_micros) VALUES($1,NULL,$2)",
      [item.id, cost.toString()],
    );
  }
  await db.query(
    `UPDATE hl.experiments SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3,
       budget_exhausted=budget_exhausted OR (spent_micros+$3::bigint>max_spend_micros)
       WHERE id=$1`,
    [item.experiment_id, reserved.toString(), cost.toString()],
  );
  await db.query(
    `UPDATE hl.work_items SET state=$2,result_ref=run_id,lease_until=NULL,lease_token=NULL,
       reservation_micros=NULL WHERE id=$1`,
    [item.id, status === "infrastructure_error" || failure ? "failed" : "done"],
  );
  if (item.kind === "compare_and_advance") {
    await closeTrial(
      db,
      item.experiment_id,
      exp,
      "comparison_unavailable",
      true,
    );
    return;
  }
  await advance(db, item, exp);
}

export async function finish(
  pool: ControlPool,
  lease: Lease,
  grade: GradeTaskResponse,
) {
  if (!accepts("GradeTaskResponse", grade) || !safePayload(grade))
    throw new DispatchError("invalid_grade");
  await transaction(pool, async (db) => {
    const item = await lockActive(db, lease);
    const exp = await experiment(db, item);
    if (!item.run_id) throw new DispatchError("invalid_work");
    const { envelope } = await readRun(db, item.run_id);
    if (!envelope) throw new DispatchError("missing_envelope");
    const expected = digest({
      evaluator_version: envelope.manifest.evaluator_version,
      benchmark_digest: envelope.manifest.benchmark_digest,
      trace_digest: envelope.trace_digest,
      grade: grade.grade,
    });
    if (expected !== grade.replay_digest)
      throw new DispatchError("invalid_grade_digest");
    await terminal(db, item, exp, envelope, grade, null);
  });
}

async function failOrRetry(db: ControlClient, item: WorkRow, code: string) {
  const exp = await experiment(db, item);
  const envelope = item.run_id
    ? (await readRun(db, item.run_id)).envelope
    : null;
  const ambiguous = exp.mode === "live" && item.effect_started && !envelope;
  const stopped =
    exp.status === "cancelled" ||
    (exp.budget_exhausted && item.reservation_micros === null);
  if (ambiguous || stopped || item.attempts >= 3) {
    await terminal(
      db,
      item,
      exp,
      envelope,
      null,
      ambiguous
        ? "ambiguous_live_effect"
        : exp.status === "cancelled"
          ? "cancelled"
          : code,
    );
    return;
  }
  await db.query(
    `WITH work AS (
       UPDATE hl.work_items SET state='queued',generation=generation+1,lease_until=NULL,lease_token=NULL,
          next_at=clock_timestamp()+($2::int * interval '1 second')
       WHERE id=$1 RETURNING id,generation,next_at
     ) INSERT INTO hl.outbox(work_id,generation,available_at) SELECT id,generation,next_at FROM work`,
    [item.id, 2 ** (item.attempts - 1)],
  );
}

export async function fail(pool: ControlPool, lease: Lease, code: string) {
  await transaction(pool, async (db) => {
    const item = await lockActive(db, lease);
    await failOrRetry(db, item, code);
  });
}

export async function reclaim(pool: ControlPool) {
  return transaction(pool, async (db) => {
    const {
      rows: [item],
    } = await db.query<WorkRow>(
      `SELECT * FROM hl.work_items WHERE state='running' AND lease_until<=clock_timestamp()
         ORDER BY lease_until LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (item) await failOrRetry(db, item, "lease_expired");
    return item?.id ?? null;
  });
}

export async function reserveOptimizer(pool: ControlPool, lease: Lease) {
  return transaction(pool, async (db) => {
    const item = await lockActive(db, lease);
    const exp = await experiment(db, item);
    const trial = exp.manifest.trial;
    if (
      !trial ||
      item.kind !== "analyze_and_propose" ||
      exp.stage !== "propose" ||
      item.input_digest !==
        digest({ id: item.experiment_id, stage: "propose", trial })
    )
      throw new DispatchError("invalid_proposal_work");
    if (exp.status === "cancelled" || exp.budget_exhausted) {
      await terminal(
        db,
        item,
        exp,
        null,
        null,
        exp.status === "cancelled" ? "cancelled" : "experiment_budget",
      );
      return false;
    }
    if (item.effect_started) throw new DispatchError("ambiguous_live_effect");
    const limit =
      exp.mode === "fixture"
        ? 0n
        : charge(trial.optimizer_price, 12000n, 1500n);
    if (item.reservation_micros === null) {
      const reserved = await db.query(
        `UPDATE hl.experiments SET reserved_micros=reserved_micros+$2
        WHERE id=$1 AND spent_micros+reserved_micros+$2::bigint<=max_spend_micros`,
        [item.experiment_id, limit.toString()],
      );
      if (!reserved.rowCount) {
        await db.query(
          "UPDATE hl.experiments SET budget_exhausted=true WHERE id=$1",
          [item.experiment_id],
        );
        await terminal(db, item, exp, null, null, "experiment_budget");
        return false;
      }
    }
    await db.query(
      "UPDATE hl.work_items SET reservation_micros=COALESCE(reservation_micros,$2),effect_started=$3 WHERE id=$1",
      [item.id, limit.toString(), exp.mode === "live"],
    );
    return true;
  });
}

export async function finishProposal(
  pool: ControlPool,
  lease: Lease,
  diagnosis: DevDiagnosis,
  result: OptimizeResponse,
) {
  if (
    !accepts("OptimizeResponse", result) ||
    !accepts("DevDiagnosis", diagnosis) ||
    !safePayload(result) ||
    result.graph.graph_kind !== "optimizer" ||
    result.graph.graph_version !== lease.graph_version ||
    result.graph.events.some(
      (event, index) =>
        event.seq !== index ||
        event.evidence_seq !== null ||
        (index > 0 &&
          event.elapsed_ms < result.graph.events[index - 1]!.elapsed_ms),
    ) ||
    result.dispositions.some((entry, index) => entry.ordinal !== index) ||
    result.usage.input_tokens > 12000 ||
    result.usage.output_tokens > 1500
  )
    throw new DispatchError("invalid_optimizer_result");
  return transaction(pool, async (db) => {
    const item = await lockActive(db, lease);
    const exp = await experiment(db, item);
    if (
      item.kind !== "analyze_and_propose" ||
      !exp.manifest.trial ||
      exp.stage !== "propose" ||
      item.reservation_micros === null ||
      (exp.mode === "fixture" &&
        (result.dispositions.length > 2 ||
          result.usage.input_tokens ||
          result.usage.output_tokens)) ||
      (exp.mode === "live" &&
        (!item.effect_started ||
          !result.usage.input_tokens ||
          !result.usage.output_tokens))
    )
      throw new DispatchError("invalid_proposal_work");
    const cost =
      exp.mode === "fixture"
        ? 0n
        : charge(
            exp.manifest.trial.optimizer_price,
            BigInt(result.usage.input_tokens),
            BigInt(result.usage.output_tokens),
          );
    await db.query(
      "INSERT INTO hl.optimizer_usage(work_id,usage,cost_micros) VALUES($1,$2,$3)",
      [item.id, result.usage, cost.toString()],
    );
    await db.query(
      "INSERT INTO hl.graph_projections(work_id,projection) VALUES($1,$2)",
      [item.id, result.graph],
    );
    await db.query(
      `UPDATE hl.experiments SET spent_micros=spent_micros+$2,reserved_micros=reserved_micros-$3
      WHERE id=$1`,
      [item.experiment_id, cost.toString(), item.reservation_micros],
    );
    await db.query(
      `UPDATE hl.work_items SET state='done',lease_token=NULL,lease_until=NULL,reservation_micros=NULL
      WHERE id=$1`,
      [item.id],
    );
    if (exp.status === "cancelled")
      return closeTrial(db, item.experiment_id, exp, "cancelled");
    await persistProposals(db, item.experiment_id, exp, diagnosis, result);
  });
}
