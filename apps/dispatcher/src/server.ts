import { controlPool } from "@harnesslab/control-db";
import { registerProbes } from "@harnesslab/schemas/health";
import type { QueueReference } from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import { Queue, Worker } from "bullmq";
import Fastify from "fastify";
import { registerCheckpoints } from "./checkpoints.ts";
import {
  deliver,
  endpoint,
  jobId,
  QUEUE_NAME,
  reconcile,
  relay,
} from "./delivery.ts";

const dsn = process.env.CONTROL_DISPATCHER_DSN;
const redisUrl = process.env.REDIS_URL;
const prompts = process.env.HL_DISPATCHER_ARTIFACT_DIR;
if (!dsn || !redisUrl || !prompts)
  throw new Error("Missing dispatcher infrastructure configuration");

const redis = new URL(redisUrl);
if (redis.protocol !== "redis:" && redis.protocol !== "rediss:") {
  throw new Error("Invalid Redis protocol");
}
const connection = {
  host: redis.hostname,
  port: Number(redis.port || "6379"),
  username: redis.username ? decodeURIComponent(redis.username) : undefined,
  password: redis.password ? decodeURIComponent(redis.password) : undefined,
  db: Number(redis.pathname.slice(1)),
  tls: redis.protocol === "rediss:" ? {} : undefined,
  connectTimeout: 1500,
};
const services = {
  prompts,
  allowLive: process.env.HL_MODE === "live",
  runner: endpoint(
    process.env.RUNNER_URL,
    "/internal/v1/execute-task",
    process.env.HL_RUNNER_TOKEN,
  ),
  evaluator: endpoint(
    process.env.EVALUATOR_URL,
    "/internal/v1/grade-task",
    process.env.HL_EVALUATOR_TOKEN,
  ),
};
const pool = controlPool(dsn);
const app = Fastify({ logger: true });
const queue = new Queue<QueueReference>(QUEUE_NAME, {
  connection: {
    ...connection,
    commandTimeout: 1500,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  },
});
const worker = new Worker<QueueReference>(
  QUEUE_NAME,
  async (job) => {
    if (
      job.name !== "work" ||
      !accepts("QueueReference", job.data) ||
      jobId(job.data) !== job.id
    )
      throw new Error("Invalid work reference");
    await deliver(pool, job.data, services);
  },
  {
    connection: { ...connection, maxRetriesPerRequest: null },
    concurrency: 1,
    autorun: false,
  },
);
pool.on("error", () => app.log.warn("Control database connection unavailable"));
queue.on("error", () =>
  app.log.warn("Dispatcher queue connection unavailable"),
);
worker.on("error", () =>
  app.log.warn("Dispatcher worker connection unavailable"),
);
await queue.waitUntilReady();
await queue.setGlobalConcurrency(1);
void worker.run().catch(() => app.log.error("Dispatcher worker stopped"));

let polling: Promise<void> | undefined;
let warned = false;
const poll = setInterval(() => {
  if (polling) return;
  polling = (async () => {
    await reconcile(pool, queue);
    await relay(pool, queue);
    warned = false;
  })()
    .catch(() => {
      if (!warned) app.log.warn("Dispatcher relay unavailable");
      warned = true;
    })
    .finally(() => {
      polling = undefined;
    });
}, 250);

registerProbes(app, async () => {
  const checks = await Promise.allSettled([
    pool.query("SELECT 1"),
    queue.getWaitingCount(),
  ]);
  return checks.every((check) => check.status === "fulfilled");
});
registerCheckpoints(app, pool);
app.addHook("onClose", async () => {
  clearInterval(poll);
  await polling;
  await worker.close();
  await Promise.all([queue.close(), pool.end()]);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
await app.listen({ host: "0.0.0.0", port: 4001 });
