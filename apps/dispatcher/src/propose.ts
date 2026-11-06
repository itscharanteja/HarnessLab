import type { ControlPool } from "@harnesslab/control-db";
import type {
  AnalyzeDevRequest,
  DiagnosisEvent,
  HarnessConfig,
  OptimizeRequest,
  ToolName,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import { digest, DispatchError } from "./artifacts.ts";
import { endpoint, postJson, type Services } from "./delivery.ts";
import { mutableView, type TrialExperiment } from "./trials.ts";
import { finishProposal, reserveOptimizer, type Lease } from "./work.ts";

const KINDS = new Set([
  "tool_request",
  "tool_result",
  "policy_decision",
  "fault",
  "recovery",
]);
export async function propose(
  pool: ControlPool,
  item: Lease & { experiment_id: string },
  services: Services,
  signal: AbortSignal,
) {
  const {
    rows: [experiment],
  } = await pool.query<TrialExperiment & { config: HarnessConfig }>(
    `SELECT e.mode,e.manifest,v.config
    FROM hl.experiments e JOIN hl.harness_versions v ON v.id=e.baseline_id WHERE e.id=$1`,
    [item.experiment_id],
  );
  if (
    !experiment?.manifest.trial ||
    !accepts("HarnessConfig", experiment.config) ||
    (experiment.mode === "live" && !services.allowLive) ||
    !services.optimizer
  )
    throw new DispatchError("optimizer_unavailable");
  const trial = experiment.manifest.trial;
  const { rows } = await pool.query<{
    run_id: string;
    task_key: string;
    grade: { success: boolean; reasons: string[] };
    tool_calls: number;
    cost_micros: string;
    events: {
      seq: number;
      kind: string;
      outcome_code: string;
      payload: { call?: { name?: ToolName }; name?: ToolName; tool?: ToolName };
    }[];
  }>(
    `SELECT r.id AS run_id,r.task_key,r.grade,r.tool_calls,r.cost_micros,
     COALESCE(jsonb_agg(jsonb_build_object('seq',t.seq,'kind',t.kind,'outcome_code',t.outcome_code,
       'payload',jsonb_build_object('tool',COALESCE(t.payload->'call'->>'name',t.payload->>'name',t.payload->>'tool')))
       ORDER BY t.seq) FILTER (WHERE t.seq IS NOT NULL),'[]'::jsonb) AS events
    FROM hl.task_runs r JOIN hl.experiments e ON e.id=r.experiment_id AND e.baseline_id=r.harness_id
    LEFT JOIN hl.trace_events t ON t.run_id=r.id
    WHERE r.experiment_id=$1 AND r.stage='diagnose' AND r.result_status NOT IN ('pending','infrastructure_error','cancelled')
    GROUP BY r.id ORDER BY r.task_key`,
    [item.experiment_id],
  );
  const request: AnalyzeDevRequest = {
    schema_version: 1,
    runs: rows.map((row) => ({
      run_id: row.run_id,
      task_key: row.task_key,
      success: row.grade.success,
      tool_calls: row.tool_calls,
      cost_micros: Number(row.cost_micros),
      reasons: row.grade.reasons,
      events: row.events
        .filter((event) => KINDS.has(event.kind))
        .map((event) => ({
          seq: event.seq,
          kind: event.kind as DiagnosisEvent["kind"],
          code: event.outcome_code,
          tool: event.payload.tool ?? null,
        })),
    })),
  };
  const tasks = new Set(trial.diagnose.map((task) => task.id));
  if (
    !accepts("AnalyzeDevRequest", request) ||
    rows.length !== tasks.size ||
    rows.some(
      (row) => !tasks.has(row.task_key) || row.task_key.split("/")[1] !== "dev",
    )
  )
    throw new DispatchError("invalid_diagnosis_sample");
  const analysis = await postJson(
    endpoint(
      services.evaluator.url.origin,
      "/internal/v1/analyze-dev",
      services.evaluator.token,
    ),
    request,
    AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  );
  const allowed = new Set(
    request.runs.flatMap((row) =>
      row.events.map((event) => digest({ run_id: row.run_id, seq: event.seq })),
    ),
  );
  if (
    !accepts("DevDiagnosis", analysis) ||
    analysis.metrics.scheduled !== tasks.size ||
    [
      ...analysis.counterexamples,
      ...analysis.clusters.flatMap((cluster) => cluster.evidence_refs),
    ].some((ref) => !allowed.has(digest(ref)))
  )
    throw new DispatchError("invalid_diagnosis");
  const payload: OptimizeRequest = {
    schema_version: 1,
    mode: experiment.mode,
    parent: mutableView(experiment.config),
    diagnosis: analysis,
    model: trial.optimizer,
  };
  if (!accepts("OptimizeRequest", payload))
    throw new DispatchError("invalid_optimizer_input");
  if (!(await reserveOptimizer(pool, item))) return;
  const result = await postJson(
    services.optimizer,
    payload,
    AbortSignal.any([
      signal,
      AbortSignal.timeout((trial.optimizer?.timeout_ms ?? 5000) + 5000),
    ]),
    item,
  );
  if (!accepts("OptimizeResponse", result))
    throw new DispatchError("invalid_optimizer_result");
  await finishProposal(pool, item, analysis, result);
}
