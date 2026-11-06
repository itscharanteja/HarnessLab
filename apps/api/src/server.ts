import { controlPool } from "@harnesslab/control-db";
import { registerProbes } from "@harnesslab/schemas/health";
import Fastify from "fastify";
import { Redis } from "ioredis";

const dsn = process.env.CONTROL_API_DSN;
const redisUrl = process.env.REDIS_URL;
if (!dsn || !redisUrl)
  throw new Error("Missing API infrastructure configuration");

const pool = controlPool(dsn);
const redis = new Redis(redisUrl, {
  commandTimeout: 1500,
  connectTimeout: 1500,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
});
const app = Fastify({ logger: true });
pool.on("error", () => app.log.warn("Control database connection unavailable"));
redis.on("error", () => app.log.warn("Queue probe connection unavailable"));

registerProbes(app, async () => {
  const checks = await Promise.allSettled([
    pool.query("SELECT 1"),
    redis.ping(),
  ]);
  return checks.every((check) => check.status === "fulfilled");
});
app.addHook("onClose", async () => {
  redis.disconnect();
  await pool.end();
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
await app.listen({ host: "0.0.0.0", port: 4000 });
