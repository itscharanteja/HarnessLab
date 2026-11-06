import { type ControlPool, transaction } from "@harnesslab/control-db";
import type {
  ExecuteTaskRequest,
  ExecuteTaskResponse,
  GradeTaskRequest,
  GradeTaskResponse,
  QueueReference,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import type { Queue } from "bullmq";
import { DispatchError, loadPinnedTask } from "./artifacts.ts";
import {
  claim,
  fail,
  finish,
  readRun,
  reclaim,
  renew,
  reserveAndMark,
  saveEnvelope,
  type Lease,
} from "./work.ts";

export const QUEUE_NAME = "harnesslab-work-v1";

export function jobId(ref: QueueReference) {
  return `hl-${ref.work_id}-${ref.generation}`;
}

type Delivery = Omit<QueueReference, "schema_version">;

export async function relay(pool: ControlPool, queue: Queue<QueueReference>) {
  const { rows } = await pool.query<Delivery>(
    `SELECT o.work_id,o.generation FROM hl.outbox o JOIN hl.work_items w ON w.id=o.work_id
       WHERE o.sent_at IS NULL AND o.available_at<=clock_timestamp() AND w.generation=o.generation
         AND w.state='queued' ORDER BY o.available_at LIMIT 25`,
  );
  for (const row of rows) {
    const ref: QueueReference = { schema_version: 1, ...row };
    await queue.add("work", ref, {
      jobId: jobId(ref),
      attempts: 1,
      removeOnComplete: { age: 86400, count: 2000 },
      removeOnFail: { age: 86400, count: 2000 },
    });
    await pool.query(
      "UPDATE hl.outbox SET sent_at=clock_timestamp() WHERE work_id=$1 AND generation=$2 AND sent_at IS NULL",
      [row.work_id, row.generation],
    );
  }
}

export async function reconcile(
  pool: ControlPool,
  queue: Queue<QueueReference>,
) {
  await reclaim(pool);
  const { rows } = await pool.query<Delivery>(
    `SELECT w.id AS work_id,w.generation FROM hl.work_items w
       LEFT JOIN hl.outbox o ON o.work_id=w.id AND o.generation=w.generation
       WHERE w.state='queued' AND w.next_at<=clock_timestamp()
         AND (o.work_id IS NULL OR o.sent_at<clock_timestamp()-interval '2 seconds')
       ORDER BY w.next_at LIMIT 25`,
  );
  for (const row of rows) {
    const job = await queue.getJob(jobId({ schema_version: 1, ...row }));
    const state = await job?.getState();
    if (state && !["unknown", "completed", "failed"].includes(state)) continue;
    await transaction(pool, async (db) => {
      await db.query(
        `WITH changed AS (
           UPDATE hl.work_items SET generation=generation+1
           WHERE id=$1 AND generation=$2 AND state='queued'
           RETURNING id,generation,next_at
         ) INSERT INTO hl.outbox(work_id,generation,available_at) SELECT id,generation,next_at FROM changed`,
        [row.work_id, row.generation],
      );
    });
  }
  await pool.query(`DELETE FROM hl.graph_checkpoints WHERE work_id IN (
    SELECT w.id FROM hl.work_items w JOIN hl.experiments e ON e.id=w.experiment_id
    WHERE w.state IN ('done','failed') AND e.completed_at<clock_timestamp()-interval '24 hours'
  )`);
}

type Endpoint = { url: URL; token: string };

export function endpoint(
  base: string | undefined,
  path: string,
  token: string | undefined,
): Endpoint {
  if (!base || !token) throw new DispatchError("service_unavailable");
  const url = new URL(path, base);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new DispatchError("service_unavailable");
  return { url, token };
}

async function postJson(
  service: Endpoint,
  body: unknown,
  signal: AbortSignal,
  lease?: Lease,
): Promise<unknown> {
  const response = await fetch(service.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.token}`,
      "content-type": "application/json",
      ...(lease
        ? {
            "x-hl-work-id": lease.id,
            "x-hl-fence": String(lease.fence),
            "x-hl-lease-token": lease.lease_token,
          }
        : {}),
    },
    body: JSON.stringify(body),
    signal,
    redirect: "error",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new DispatchError(
      response.status === 503
        ? "private_service_unavailable"
        : "private_service_error",
    );
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new DispatchError("private_result_too_large");
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
  } finally {
    await reader.cancel();
  }
}

export type Services = {
  prompts: string;
  runner: Endpoint;
  evaluator: Endpoint;
  allowLive: boolean;
};

export async function deliver(
  pool: ControlPool,
  ref: QueueReference,
  services: Services,
) {
  const item = await claim(pool, ref);
  if (!item) return;
  const controller = new AbortController();
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renew(pool, item)
      .then((ok) => {
        if (!ok) controller.abort();
      })
      .catch(() => controller.abort())
      .finally(() => {
        renewing = false;
      });
  }, 3000);
  try {
    if (item.kind !== "execute_task" || !item.run_id)
      throw new DispatchError("work_kind_unavailable");
    const run = await readRun(pool, item.run_id);
    let envelope = run.envelope;
    if (!envelope) {
      if (run.manifest.mode === "live" && !services.allowLive)
        throw new DispatchError("live_disabled");
      const input = await loadPinnedTask(services.prompts, run.manifest);
      const request: ExecuteTaskRequest = {
        schema_version: 1,
        task: input.task,
        fault: input.fault,
        harness: run.config,
        manifest: run.manifest,
        deadline: new Date(Date.now() + 90000).toISOString(),
      };
      if (!accepts("ExecuteTaskRequest", request))
        throw new DispatchError("invalid_worker_request");
      if (!(await reserveAndMark(pool, item, run))) return;
      const output = await postJson(
        services.runner,
        request,
        AbortSignal.any([controller.signal, AbortSignal.timeout(95000)]),
        item,
      );
      if (!accepts("ExecuteTaskResponse", output))
        throw new DispatchError("invalid_worker_result");
      await saveEnvelope(pool, item, output satisfies ExecuteTaskResponse);
      envelope = output.run;
    }
    const request: GradeTaskRequest = { schema_version: 1, run: envelope };
    if (!accepts("GradeTaskRequest", request))
      throw new DispatchError("invalid_grade_request");
    const response = await postJson(
      services.evaluator,
      request,
      AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    );
    if (!accepts("GradeTaskResponse", response))
      throw new DispatchError("invalid_grade");
    await finish(pool, item, response satisfies GradeTaskResponse);
  } catch (error) {
    try {
      await fail(
        pool,
        item,
        error instanceof DispatchError ? error.code : "transport_failure",
      );
    } catch (writeError) {
      if (!(
        writeError instanceof DispatchError && writeError.code === "stale_lease"
      ))
        throw writeError;
    }
  } finally {
    clearInterval(heartbeat);
  }
}
