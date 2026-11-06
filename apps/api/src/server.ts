import { randomUUID } from "node:crypto";
import { controlPool } from "@harnesslab/control-db";
import { registerProbes } from "@harnesslab/schemas/health";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { ApiError } from "./auth.ts";
import { registerRoutes, sendError } from "./routes.ts";

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
const promoter = process.env.CONTROL_PROMOTER_DSN
  ? controlPool(process.env.CONTROL_PROMOTER_DSN)
  : undefined;
const app = Fastify({
  logger: true,
  disableRequestLogging: true,
  bodyLimit: 16384,
  requestIdHeader: false,
  genReqId: () => randomUUID(),
});
app.setErrorHandler((error, request, reply) => {
  if (error instanceof ApiError)
    return sendError(reply, request, error.status, error.code);
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  )
    return sendError(reply, request, 400, "invalid_request");
  app.log.warn({ request_id: request.id }, "API request failed");
  return sendError(reply, request, 503, "service_unavailable");
});
app.setNotFoundHandler((request, reply) =>
  sendError(reply, request, 404, "not_found"),
);
promoter?.on("error", () =>
  app.log.warn("Promoter database connection unavailable"),
);
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
  await Promise.all([pool.end(), promoter?.end()]);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
await registerRoutes(app, pool, promoter);
await app.listen({ host: "0.0.0.0", port: 4000 });
