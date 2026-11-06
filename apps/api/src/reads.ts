import type { ControlPool } from "@harnesslab/control-db";
import type {
  ExperimentSummary,
  Grade,
  HarnessConfig,
  PatchOperation,
  TaskRunSummary,
  TraceEvent,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import { ApiError, type Caller } from "./auth.ts";

const SCOPED =
  "(e.published OR ($1::boolean OR (e.mode='fixture' AND e.principal=$2)))";
type Experiment = Omit<ExperimentSummary, "created_at" | "completed_at"> & {
  created_at: Date;
  completed_at: Date | null;
  published: boolean;
  channel: string;
  channel_revision: number;
  active_revision: number;
};
type Harness = {
  id: string;
  hash: string;
  parent_hash: string | null;
  config: HarnessConfig;
  active: boolean;
};
type Page = { cursor: string | null; limit: number; graph: boolean };

const gradeReasons = new Set([
  "unsafe",
  "unable",
  "budget_exhausted",
  "cancelled",
  "infrastructure_error",
  "wrong_outcome",
  "wrong_clarification_fields",
  "sql_before_clarification",
  "wrong_finding_keys",
  "wrong_unit",
  "wrong_value",
  "unsupported_evidence",
]);
const privateContent =
  /postgres(?:ql)?:\/\/|\bpassword\s*=|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/i;

function gradeView(grade: Grade | null): Grade | null {
  if (!grade) return null;
  return {
    ...grade,
    reasons: [
      ...new Set(
        grade.reasons.map((r) =>
          gradeReasons.has(r) ? r : "infrastructure_error",
        ),
      ),
    ],
  };
}

export function queryPage(
  query: unknown,
  cursorType: "uuid" | "hash" | "seq",
  graph = false,
): Page {
  if (!query || typeof query !== "object")
    throw new ApiError(400, "invalid_query");
  const values = query as Record<string, unknown>;
  if (
    Object.keys(values).some(
      (key) =>
        key !== "cursor" && key !== "limit" && (!graph || key !== "graph"),
    ) ||
    (values.graph !== undefined && values.graph !== "1") ||
    (values.limit !== undefined &&
      (typeof values.limit !== "string" || !/^\d{1,3}$/.test(values.limit)))
  )
    throw new ApiError(400, "invalid_query");
  const input = {
    ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
  };
  if (
    !accepts("PageQuery", input) ||
    (input.cursor !== undefined &&
      !(cursorType === "uuid"
        ? accepts("Uuid", input.cursor)
        : cursorType === "hash"
          ? accepts("Digest", input.cursor)
          : /^\d{1,5}$/.test(input.cursor) && Number(input.cursor) <= 10000))
  )
    throw new ApiError(400, "invalid_query");
  return {
    cursor: input.cursor ?? null,
    limit: input.limit ?? 20,
    graph: values.graph === "1",
  };
}

export function detailQuery(query: unknown, graph = false) {
  if (
    !query ||
    typeof query !== "object" ||
    Object.keys(query).some((key) => !graph || key !== "graph") ||
    ("graph" in query && query.graph !== "1")
  )
    throw new ApiError(400, "invalid_query");
  return "graph" in query;
}

function scope(caller: Caller): [boolean, string] {
  return [caller.operator, caller.principal];
}

function summary(e: Experiment): ExperimentSummary {
  return {
    id: e.id,
    status: e.status,
    stage: e.stage,
    scope: e.scope,
    mode: e.mode,
    baseline_hash: e.baseline_hash,
    created_at: e.created_at.toISOString(),
    completed_at: e.completed_at?.toISOString() ?? null,
    scheduled_runs: e.scheduled_runs,
    terminal_runs: e.terminal_runs,
  };
}

function pageOf<T>(rows: T[], limit: number, cursor: (row: T) => string) {
  const items = rows.slice(0, limit);
  return {
    items,
    next_cursor: rows.length > limit ? cursor(items.at(-1)!) : null,
  };
}

function runView(row: TaskRunSummary) {
  return { ...row, grade: gradeView(row.grade) };
}

export async function experiments(
  pool: ControlPool,
  caller: Caller,
  page: Page,
) {
  const { rows } = await pool.query<Experiment>(
    `SELECT e.* FROM hl.api_experiments e WHERE ${SCOPED}
      AND ($3::uuid IS NULL OR (e.created_at,e.id) <
        (SELECT e.created_at,e.id FROM hl.api_experiments e WHERE e.id=$3 AND ${SCOPED}))
      ORDER BY e.created_at DESC,e.id DESC LIMIT $4`,
    [...scope(caller), page.cursor, page.limit + 1],
  );
  return pageOf(rows.map(summary), page.limit, (row) => row.id);
}

export async function visibleExperiment(
  pool: ControlPool,
  caller: Caller,
  id: string,
) {
  const {
    rows: [row],
  } = await pool.query<Experiment>(
    `SELECT e.* FROM hl.api_experiments e WHERE e.id=$3 AND ${SCOPED}`,
    [...scope(caller), id],
  );
  if (!row) throw new ApiError(404, "not_found");
  return row;
}

async function projection(
  pool: ControlPool,
  id: string,
  kind: "worker" | "optimizer",
) {
  const column = kind === "worker" ? "run_id" : "experiment_id";
  const {
    rows: [row],
  } = await pool.query<{ projection: unknown }>(
    `SELECT projection FROM hl.api_graphs WHERE ${column}=$1 AND projection->>'graph_kind'=$2 LIMIT 1`,
    [id, kind],
  );
  return accepts("GraphProjection", row?.projection) ? row.projection : null;
}

export async function experimentDetail(
  pool: ControlPool,
  caller: Caller,
  id: string,
  graph: boolean,
) {
  const e = await visibleExperiment(pool, caller, id);
  const [arms, proposals, decisions, optimizerGraph, clusters] =
    await Promise.all([
      pool.query(
        "SELECT hash,role,ordinal,disposition FROM hl.api_arms WHERE experiment_id=$1 ORDER BY ordinal",
        [id],
      ),
      pool.query(
        `SELECT ordinal,patch,rationale,evidence_refs,status,reason,expected_metric,direction,candidate_hash
       FROM hl.api_proposals WHERE experiment_id=$1 ORDER BY ordinal`,
        [id],
      ),
      caller.operator
        ? pool.query<{
            created_at: Date;
            kind: string;
            current_revision: number;
            from_hash: string;
            to_hash: string;
            actor: string;
            reason: string;
          }>(
            `SELECT kind,current_revision,created_at,from_hash,to_hash,actor,reason FROM hl.api_decisions
           WHERE experiment_id=$1 ORDER BY created_at DESC LIMIT 30`,
            [id],
          )
        : Promise.resolve({ rows: [] }),
      graph ? projection(pool, id, "optimizer") : Promise.resolve(null),
      graph
        ? pool.query(
            "SELECT signature,count,evidence_refs FROM hl.api_clusters WHERE experiment_id=$1 ORDER BY count DESC,signature LIMIT 5",
            [id],
          )
        : Promise.resolve({ rows: [] }),
    ]);
  return {
    experiment: summary(e),
    published: e.published,
    channel_revision: e.channel_revision,
    arms: arms.rows,
    proposals: proposals.rows.filter(
      (row) => !privateContent.test(JSON.stringify(row)),
    ),
    decisions: decisions.rows.map((row) => ({
      ...row,
      reason: privateContent.test(row.reason) ? "Redacted" : row.reason,
      created_at: row.created_at.toISOString(),
    })),
    ...(caller.operator
      ? { active_revision: e.active_revision, channel: e.channel }
      : {}),
    ...(graph
      ? {
          optimizer_graph: optimizerGraph,
          clusters: clusters.rows.filter((row) =>
            accepts("FailureCluster", row),
          ),
        }
      : {}),
  };
}

export async function comparisons(
  pool: ControlPool,
  caller: Caller,
  id: string,
) {
  await visibleExperiment(pool, caller, id);
  const { rows } = await pool.query<{ report: unknown }>(
    "SELECT report FROM hl.api_reports WHERE experiment_id=$1 ORDER BY scope,harness_id LIMIT 6",
    [id],
  );
  return {
    items: rows
      .map((row) => row.report)
      .filter((value) => accepts("EvaluationReport", value)),
  };
}

export async function runs(
  pool: ControlPool,
  caller: Caller,
  id: string,
  page: Page,
) {
  await visibleExperiment(pool, caller, id);
  const { rows } = await pool.query<TaskRunSummary>(
    `SELECT run_id,task_key,stage,repeat,harness_hash,result,grade FROM hl.api_runs
     WHERE experiment_id=$1 AND ($2::boolean OR (stage<>'validate' AND split_part(task_key,'/',2)='dev'))
       AND ($3::uuid IS NULL OR run_id>$3)
     ORDER BY run_id LIMIT $4`,
    [id, caller.operator, page.cursor, page.limit + 1],
  );
  return pageOf(rows.map(runView), page.limit, (row) => row.run_id);
}

export async function trace(
  pool: ControlPool,
  caller: Caller,
  id: string,
  page: Page,
) {
  const {
    rows: [run],
  } = await pool.query<TaskRunSummary>(
    `SELECT r.run_id,r.task_key,r.stage,r.repeat,r.harness_hash,r.result,r.grade
     FROM hl.api_runs r JOIN hl.api_experiments e ON e.id=r.experiment_id
     WHERE r.run_id=$3 AND ${SCOPED}
       AND ($1::boolean OR (r.stage<>'validate' AND split_part(r.task_key,'/',2)='dev'))`,
    [...scope(caller), id],
  );
  if (!run) throw new ApiError(404, "not_found");
  const [events, workerGraph] = await Promise.all([
    pool.query<TraceEvent>(
      `SELECT run_id,seq,kind,outcome_code,elapsed_ms,correlation_id,payload
       FROM hl.api_trace WHERE run_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`,
      [id, page.cursor === null ? -1 : Number(page.cursor), page.limit + 1],
    ),
    page.graph ? projection(pool, id, "worker") : Promise.resolve(null),
  ]);
  const items: TraceEvent[] = [];
  let size = 0,
    scanned = 0;
  for (const event of events.rows.slice(0, page.limit)) {
    const view =
      event.kind === "model_usage"
        ? { ...event, payload: { ...event.payload, request_id: null } }
        : event.kind === "grade"
          ? { ...event, payload: gradeView(event.payload) }
          : event;
    const serialized = JSON.stringify(view);
    const bytes = Buffer.byteLength(serialized);
    if (size + bytes > 262144 && bytes <= 131072) break;
    scanned++;
    if (
      bytes > 131072 ||
      privateContent.test(serialized) ||
      !accepts("TraceEvent", view)
    )
      continue;
    items.push(view);
    size += bytes;
  }
  return {
    run: runView(run),
    items,
    next_cursor:
      scanned < events.rows.length
        ? String(events.rows[scanned - 1]!.seq)
        : null,
    ...(page.graph ? { worker_graph: workerGraph } : {}),
  };
}

const visibleHarness = `($1::boolean OR EXISTS(SELECT 1 FROM hl.api_arms a JOIN hl.api_experiments e
  ON e.id=a.experiment_id WHERE a.harness_id=h.id AND ${SCOPED}))`;
async function selectHarnesses(
  pool: ControlPool,
  caller: Caller,
  cursor: string | null,
  hash: string | null,
  limit: number,
) {
  const { rows } = await pool.query<Harness>(
    `SELECT h.id,h.hash,h.config,CASE WHEN p.hash IS NOT NULL AND
       ($1::boolean OR EXISTS(SELECT 1 FROM hl.api_arms a JOIN hl.api_experiments e
        ON e.id=a.experiment_id WHERE a.harness_id=p.id AND ${SCOPED}))
        THEN p.hash ELSE NULL END AS parent_hash,
       CASE WHEN $1::boolean THEN h.production_active OR h.fixture_active ELSE h.fixture_active END AS active
     FROM hl.api_harnesses h LEFT JOIN hl.api_harnesses p ON p.hash=h.parent_hash
     WHERE ${visibleHarness} AND ($3::text IS NULL OR h.hash>$3) AND ($4::text IS NULL OR h.hash=$4)
     ORDER BY h.hash LIMIT $5`,
    [...scope(caller), cursor, hash, limit],
  );
  return rows.map(({ hash, parent_hash, config, active }) => ({
    hash,
    parent_hash,
    config,
    active,
  }));
}

export async function harnesses(pool: ControlPool, caller: Caller, page: Page) {
  return pageOf(
    await selectHarnesses(pool, caller, page.cursor, null, page.limit + 1),
    page.limit,
    (row) => row.hash,
  );
}

function diff(parent: HarnessConfig, candidate: HarnessConfig) {
  const changes = [
    [
      "/prompt/task_guidance",
      parent.prompt.task_guidance,
      candidate.prompt.task_guidance,
    ],
    [
      "/workflow/schema_inspection",
      parent.workflow.schema_inspection,
      candidate.workflow.schema_inspection,
    ],
    [
      "/workflow/verify_numeric_answers",
      parent.workflow.verify_numeric_answers,
      candidate.workflow.verify_numeric_answers,
    ],
    [
      "/workflow/retry_policy",
      parent.workflow.retry_policy,
      candidate.workflow.retry_policy,
    ],
    [
      "/context/recent_tool_results",
      parent.context.recent_tool_results,
      candidate.context.recent_tool_results,
    ],
    [
      "/limits/max_tool_calls",
      parent.limits.max_tool_calls,
      candidate.limits.max_tool_calls,
    ],
    [
      "/limits/max_retries_per_tool",
      parent.limits.max_retries_per_tool,
      candidate.limits.max_retries_per_tool,
    ],
  ];
  return changes.flatMap(([path, before, value]) => {
    const change = { op: "replace", path, value };
    return before !== value && accepts("PatchOperation", change)
      ? [change satisfies PatchOperation]
      : [];
  });
}

export async function harnessDetail(
  pool: ControlPool,
  caller: Caller,
  hash: string,
) {
  const [row] = await selectHarnesses(pool, caller, null, hash, 1);
  if (!row) throw new ApiError(404, "not_found");
  const [parent] = row.parent_hash
    ? await selectHarnesses(pool, caller, null, row.parent_hash, 1)
    : [];
  const { rows: modes } = await pool.query<{ mode: string }>(
    `SELECT DISTINCT e.mode FROM hl.api_experiments e JOIN hl.api_arms a ON a.experiment_id=e.id
      WHERE a.hash=$3 AND ${SCOPED} ORDER BY e.mode`,
    [...scope(caller), hash],
  );
  return {
    harness: row,
    diff: parent ? diff(parent.config, row.config) : null,
    modes: modes.map(({ mode }) => mode),
  };
}
