import type { FastifyInstance } from "fastify";
import type { HealthResponse } from "../generated/contracts.ts";

export function registerProbes(
  app: FastifyInstance,
  isReady: () => Promise<boolean>,
) {
  app.get("/healthz", (): HealthResponse => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply): Promise<HealthResponse> => {
    if (await isReady()) return { status: "ok" };

    reply.code(503);
    return { status: "unavailable" };
  });
}
