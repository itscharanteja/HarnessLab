import { registerProbes } from "../../packages/schemas/src/health.ts";
import Fastify from "fastify";
import { expect, test } from "vitest";

test("liveness stays available while a dependency is unavailable", async () => {
  const app = Fastify();
  registerProbes(app, async () => false);
  try {
    expect((await app.inject("/healthz")).json()).toEqual({ status: "ok" });
    const readiness = await app.inject("/readyz");
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toEqual({ status: "unavailable" });
  } finally {
    await app.close();
  }
});
