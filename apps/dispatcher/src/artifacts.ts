import { createHash, randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { transaction, type ControlPool } from "@harnesslab/control-db";
import type {
  FaultFixture,
  TaskInput,
  RunManifest,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";

export const WORKER_GRAPH = "worker_v1";
export const OPTIMIZER_GRAPH = "optimizer_v1";
export const EVALUATOR_VERSION = "phase3-eval-v1";
export const FIXTURE_WORKER = {
  snapshot: "fixture-worker-v1",
  timeout_ms: 5000,
  reasoning_effort: null,
  temperature: null,
  top_p: null,
} as const;
export const FIXTURE_PRICE = { input: "0", output: "0" };

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new Error("Noncanonical JSON");
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export class DispatchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

type ManifestTask = {
  id: string;
  category: TaskInput["category"];
  input_hash: string;
  fault_digest: string;
  variant_id: string;
  split: "dev" | "validation";
};
type BundleManifest = {
  manifest_digest: string;
  fixture: boolean;
  split: "dev" | "validation";
  prompt_bundle_digest: string;
  tasks: ManifestTask[];
  variants: { id: string; rows_digest: string }[];
};

async function readJson(path: string): Promise<unknown> {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > 2 * 1024 * 1024)
      throw new Error("Artifact too large");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

export async function promptBundle(
  root: string,
  split: "dev" | "validation",
  mode: "live" | "fixture",
) {
  try {
    const directory = join(root, split);
    const manifest = (await readJson(
      join(directory, "manifest.json"),
    )) as BundleManifest;
    const prompts = (await readJson(join(directory, "prompts.json"))) as {
      task: unknown;
      fault: unknown;
    }[];
    const { manifest_digest, ...snapshot } = manifest;
    if (
      digest(snapshot) !== manifest_digest ||
      manifest.split !== split ||
      manifest.fixture !== (mode === "fixture") ||
      digest(prompts) !== manifest.prompt_bundle_digest
    )
      throw new Error("Artifact provenance mismatch");
    return {
      manifest,
      task(taskKey: string) {
        const meta = manifest.tasks.find((item) => item.id === taskKey);
        const entry = prompts.find(
          (item) =>
            accepts("TaskInput", item.task) && item.task.task_key === taskKey,
        );
        if (
          !meta ||
          !entry ||
          !accepts("TaskInput", entry.task) ||
          (entry.fault !== null && !accepts("FaultFixture", entry.fault))
        )
          throw new DispatchError("artifact_unavailable");
        const task: TaskInput = entry.task;
        const fault: FaultFixture | null = entry.fault;
        const dataset = manifest.variants.find(
          (variant) => variant.id === task.variant_id,
        );
        if (
          !dataset ||
          task.split !== split ||
          task.variant_id !== meta.variant_id ||
          task.category !== meta.category ||
          meta.split !== split ||
          digest(task) !== meta.input_hash ||
          digest(fault) !== meta.fault_digest
        )
          throw new DispatchError("artifact_mismatch");
        return { task, fault, meta, dataset };
      },
    };
  } catch {
    throw new DispatchError("artifact_unavailable");
  }
}

export async function loadPinnedTask(root: string, run: RunManifest) {
  const split = run.task_key.split("/")[1];
  if (split !== "dev" && split !== "validation")
    throw new DispatchError("artifact_mismatch");
  const bundle = await promptBundle(root, split, run.mode);
  const found = bundle.task(run.task_key);
  if (
    bundle.manifest.manifest_digest !== run.benchmark_digest ||
    found.meta.input_hash !== run.task_input_hash ||
    found.dataset.rows_digest !== run.dataset_digest
  )
    throw new DispatchError("artifact_mismatch");
  return found;
}

export async function submitFixture(
  pool: ControlPool,
  root: string,
  key: string,
) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key))
    throw new DispatchError("invalid_idempotency_key");
  const bundle = await promptBundle(root, "dev", "fixture");
  const selected = bundle.manifest.tasks.find(
    (task) => task.category === "efficiency",
  );
  if (!selected) throw new DispatchError("artifact_unavailable");
  const { task, meta, dataset } = bundle.task(selected.id);
  const benchmark = bundle.manifest.manifest_digest;
  const requestHash = digest({
    scope: "demo_fixture",
    task_key: task.task_key,
    benchmark,
  });
  return transaction(pool, async (db) => {
    const {
      rows: [baseline],
    } = await db.query<{
      active_version_id: string;
      revision: number;
      content_sha256: string;
    }>(`SELECT c.active_version_id,c.revision,v.content_sha256 FROM hl.harness_channels c
        JOIN hl.harness_versions v ON v.id=c.active_version_id WHERE c.channel='fixture'`);
    if (!baseline) throw new DispatchError("baseline_unavailable");
    const experiment = {
      schema_version: 1,
      worker_graph_version: WORKER_GRAPH,
      optimizer_graph_version: OPTIMIZER_GRAPH,
      expected_runs: 1,
      price: FIXTURE_PRICE,
    };
    const {
      rows: [created],
    } = await db.query<{ id: string }>(
      `INSERT INTO hl.experiments(baseline_id,channel,channel_revision,principal,idempotency_key,
          request_hash,mode,scope,max_spend_micros,manifest)
       VALUES ($1,'fixture',$2,'local-fixture',$3,$4,'fixture','demo_fixture',0,$5)
       ON CONFLICT (principal,idempotency_key) DO NOTHING RETURNING id`,
      [
        baseline.active_version_id,
        baseline.revision,
        key,
        requestHash,
        experiment,
      ],
    );
    if (!created) {
      const {
        rows: [prior],
      } = await db.query<{ id: string; request_hash: string }>(
        "SELECT id,request_hash FROM hl.experiments WHERE principal='local-fixture' AND idempotency_key=$1",
        [key],
      );
      if (!prior || prior.request_hash !== requestHash)
        throw new DispatchError("idempotency_conflict");
      return prior.id;
    }

    await db.query(
      `INSERT INTO hl.benchmark_tasks(benchmark_digest,task_key,split,category,dataset_digest,variant_id,input_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        benchmark,
        task.task_key,
        task.split,
        task.category,
        dataset.rows_digest,
        task.variant_id,
        meta.input_hash,
      ],
    );
    await db.query(
      `INSERT INTO hl.experiment_arms(experiment_id,harness_id,role,ordinal,disposition)
       VALUES ($1,$2,'baseline',0,'scheduled')`,
      [created.id, baseline.active_version_id],
    );
    const run: RunManifest = {
      schema_version: 1,
      run_id: randomUUID(),
      mode: "fixture",
      stage: "diagnose",
      repeat: 1,
      task_key: task.task_key,
      task_input_hash: meta.input_hash,
      config_hash: baseline.content_sha256,
      dataset_digest: dataset.rows_digest,
      benchmark_digest: benchmark,
      software_revision: "phase3-fixture",
      evaluator_version: EVALUATOR_VERSION,
      safety_profile: "readonly-synthetic-v1",
      worker: FIXTURE_WORKER,
      worker_profile_digest: digest(FIXTURE_WORKER),
      price_profile_digest: digest(FIXTURE_PRICE),
      schedule_seed: 20251106,
    };
    if (!accepts("RunManifest", run))
      throw new DispatchError("invalid_manifest");
    await db.query(
      `INSERT INTO hl.task_runs(id,experiment_id,harness_id,benchmark_digest,task_key,stage,repeat,manifest)
       VALUES ($1,$2,$3,$4,$5,'diagnose',1,$6)`,
      [
        run.run_id,
        created.id,
        baseline.active_version_id,
        benchmark,
        task.task_key,
        run,
      ],
    );
    await db.query(
      `WITH work AS (
         INSERT INTO hl.work_items(experiment_id,work_key,kind,run_id,graph_version,input_digest)
         VALUES ($1,$2,'execute_task',$3,$4,$5) RETURNING id,generation
       ) INSERT INTO hl.outbox(work_id,generation) SELECT id,generation FROM work`,
      [
        created.id,
        `execute_task/${run.run_id}`,
        run.run_id,
        WORKER_GRAPH,
        digest(run),
      ],
    );
    return created.id;
  });
}
