import { timingSafeEqual } from "node:crypto";
import type { ControlPool } from "@harnesslab/control-db";
import type { FastifyInstance } from "fastify";

export function registerOps(app: FastifyInstance, pool: ControlPool) {
  const token = process.env.HL_OPS_TOKEN ?? "";
  const expected = Buffer.from("Bearer " + token);
  app.get("/internal/v1/metrics", async (request, reply) => {
    const received = Buffer.from(request.headers.authorization ?? "");
    if (
      token.length < 32 ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    )
      return reply.code(401).send({ code: "unauthorized" });
    reply.header("cache-control", "no-store");
    try {
      const {
        rows: [metrics],
      } = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM hl.work_items WHERE state='queued') AS queue_depth,
           COALESCE((SELECT GREATEST(0,extract(epoch FROM clock_timestamp()-min(next_at))*1000)::bigint
             FROM hl.work_items WHERE state='queued'),'0')::text AS oldest_queue_ms,
           (SELECT count(*)::int FROM hl.work_items WHERE state='running' AND lease_until<=clock_timestamp())
             AS expired_leases,
           (SELECT count(*)::int FROM hl.experiments WHERE budget_exhausted AND created_at>now()-interval '1 hour')
             AS budget_exhaustions_1h,
           (SELECT COALESCE(sum(spent_micros),0)::text FROM hl.experiments
             WHERE created_at>now()-interval '1 hour') AS spend_on_recent_experiments_microusd`,
      );
      return { schema_version: 1, ...metrics };
    } catch {
      return reply.code(503).send({ code: "service_unavailable" });
    }
  });
}
