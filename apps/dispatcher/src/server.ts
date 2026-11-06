import { controlPool } from "@harnesslab/control-db";
import { registerProbes } from "@harnesslab/schemas/health";
import { Queue } from "bullmq";
import Fastify from "fastify";

const dsn = process.env.CONTROL_DISPATCHER_DSN;
const redisUrl = process.env.REDIS_URL;
if (!dsn || !redisUrl)
  throw new Error("Missing dispatcher infrastructure configuration");

const redis = new URL(redisUrl);
if (redis.protocol !== "redis:" && redis.protocol !== "rediss:") {
  throw new Error("Invalid Redis protocol");
}

const pool = controlPool(dsn);
const app = Fastify({ logger: true });
pool.on("error", () => app.log.warn("Control database connection unavailable"));
const queue = new Queue("harnesslab-work-v1", {
  connection: {
    host: redis.hostname,
    port: Number(redis.port || "6379"),
    username: redis.username ? decodeURIComponent(redis.username) : undefined,
    password: redis.password ? decodeURIComponent(redis.password) : undefined,
    db: Number(redis.pathname.slice(1)),
    tls: redis.protocol === "rediss:" ? {} : undefined,
    commandTimeout: 1500,
    connectTimeout: 1500,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  },
});
queue.on("error", () =>
  app.log.warn("Dispatcher queue connection unavailable"),
);

registerProbes(app, async () => {
  const checks = await Promise.allSettled([
    pool.query("SELECT 1"),
    queue.getWaitingCount(),
  ]);
  return checks.every((check) => check.status === "fulfilled");
});
app.addHook("onClose", async () => {
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
