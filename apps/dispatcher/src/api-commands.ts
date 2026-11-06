import { timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { transaction, type ControlPool } from "@harnesslab/control-db";
import type {
  DispatchCancellation,
  DispatchSubmission,
  ExperimentAccepted,
  ModelSettings,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type Price } from "./accounting.ts";
import { digest, DispatchError } from "./artifacts.ts";
import { submitTrial, type LiveTrial } from "./trials.ts";

async function profile(path: string | undefined): Promise<unknown> {
  if (!path) throw new DispatchError("live_disabled");
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > 16384) throw new Error("Profile too large");
    return JSON.parse(await file.readFile("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

async function liveSettings(command: DispatchSubmission): Promise<LiveTrial> {
  const devDigest = process.env.HL_DEV_MANIFEST_DIGEST;
  const validationDigest = process.env.HL_VALIDATION_MANIFEST_DIGEST;
  if (
    process.env.HL_MODE !== "live" ||
    command.submission.scope !== "full_live" ||
    !command.principal.startsWith("operator:") ||
    !accepts("Digest", devDigest) ||
    !accepts("Digest", validationDigest)
  )
    throw new DispatchError("live_disabled");
  const [worker, optimizer, prices] = await Promise.all([
    profile(process.env.HL_WORKER_PROFILE_FILE),
    profile(process.env.HL_OPTIMIZER_PROFILE_FILE),
    profile(process.env.HL_PRICE_PROFILE_FILE),
  ]);
  if (
    !accepts("ModelSettings", worker) ||
    !accepts("ModelSettings", optimizer) ||
    !prices ||
    typeof prices !== "object" ||
    !("worker" in prices) ||
    !("optimizer" in prices)
  )
    throw new DispatchError("invalid_trial_profile");
  return {
    mode: "live",
    principal: command.principal,
    channel: "production",
    maxSpend: BigInt(command.submission.max_spend_microusd),
    worker: worker satisfies ModelSettings,
    optimizer,
    price: prices.worker as Price,
    optimizerPrice: prices.optimizer as Price,
    devDigest,
    validationDigest,
  };
}

async function cancel(pool: ControlPool, command: DispatchCancellation) {
  const { id, principal, idempotency_key } = command;
  return transaction(pool, async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text,'cancel',$2::text)::text,5521))",
      [principal, idempotency_key],
    );
    const {
      rows: [prior],
    } = await db.query<{ experiment_id: string; response: ExperimentAccepted }>(
      "SELECT experiment_id,response FROM hl.api_actions WHERE actor=$1 AND command='cancel' AND idempotency_key=$2",
      [principal, idempotency_key],
    );
    if (prior) {
      if (prior.experiment_id !== id)
        throw new DispatchError("idempotency_conflict");
      return prior.response;
    }
    const {
      rows: [experiment],
    } = await db.query<{ status: string }>(
      `SELECT status FROM hl.experiments WHERE id=$1 AND
         ($2::boolean OR (principal=$3 AND mode='fixture')) FOR UPDATE`,
      [id, principal.startsWith("operator:"), principal],
    );
    if (!experiment) throw new DispatchError("experiment_unavailable");
    if (!["queued", "running", "cancelled"].includes(experiment.status))
      throw new DispatchError("cancel_unavailable");
    await db.query(
      `UPDATE hl.experiments SET status='cancelled',stage='report',completed_at=clock_timestamp()
       WHERE id=$1 AND status IN ('queued','running')`,
      [id],
    );
    const response = { id, status: "cancelled" as const };
    await db.query("INSERT INTO hl.api_actions VALUES($1,'cancel',$2,$3,$4)", [
      principal,
      idempotency_key,
      id,
      response,
    ]);
    return response;
  });
}

export async function expirePublicTrials(pool: ControlPool) {
  await pool.query(
    `UPDATE hl.experiments e SET status='cancelled',stage='report',completed_at=clock_timestamp()
       FROM hl.public_experiments p WHERE e.id=p.experiment_id AND
         e.status IN ('queued','running') AND p.deadline<=clock_timestamp()`,
  );
}

const errors: Record<string, number> = {
  public_quota: 429,
  idempotency_conflict: 409,
  cancel_unavailable: 409,
  live_disabled: 403,
  public_disabled: 403,
  experiment_budget: 409,
  experiment_unavailable: 404,
};

export function registerApiCommands(
  app: FastifyInstance,
  pool: ControlPool,
  root: string,
) {
  const secret = Buffer.from(process.env.HL_API_DISPATCH_TOKEN ?? "");
  function permitted(request: FastifyRequest) {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${secret.toString()}`);
    return (
      secret.length >= 32 &&
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
    );
  }
  app.post("/internal/v1/submit-experiment", async (request, reply) => {
    if (!permitted(request))
      return reply.code(401).send({ code: "unauthorized" });
    const command = request.body;
    if (!accepts("DispatchSubmission", command))
      return reply.code(400).send({ code: "invalid_request" });
    try {
      if (
        command.principal.startsWith("public:") &&
        process.env.HL_PUBLIC_RUNS !== "1"
      )
        throw new DispatchError("public_disabled");
      if (
        command.submission.scope === "full_live" &&
        !command.principal.startsWith("operator:")
      )
        throw new DispatchError("live_disabled");
      const fingerprint = digest(command.submission);
      const {
        rows: [prior],
      } = await pool.query<ExperimentAccepted & { request_hash: string }>(
        "SELECT id,status,request_hash FROM hl.experiments WHERE principal=$1 AND idempotency_key=$2",
        [command.principal, command.idempotency_key],
      );
      if (prior) {
        if (prior.request_hash !== fingerprint)
          throw new DispatchError("idempotency_conflict");
        return reply.code(202).send({ id: prior.id, status: prior.status });
      }
      const live =
        command.submission.scope === "full_live"
          ? await liveSettings(command)
          : undefined;
      const id = await submitTrial(
        pool,
        root,
        command.idempotency_key,
        live,
        command.principal,
        fingerprint,
      );
      const {
        rows: [row],
      } = await pool.query<ExperimentAccepted>(
        "SELECT id,status FROM hl.experiments WHERE id=$1",
        [id],
      );
      if (!accepts("ExperimentAccepted", row)) throw new Error("Unavailable");
      return reply.code(202).send(row);
    } catch (error) {
      const code =
        error instanceof DispatchError && Object.hasOwn(errors, error.code)
          ? error.code
          : "service_unavailable";
      return reply.code(errors[code] ?? 503).send({ code });
    }
  });
  app.post("/internal/v1/cancel-experiment", async (request, reply) => {
    if (!permitted(request))
      return reply.code(401).send({ code: "unauthorized" });
    if (!accepts("DispatchCancellation", request.body))
      return reply.code(400).send({ code: "invalid_request" });
    try {
      return reply.code(202).send(await cancel(pool, request.body));
    } catch (error) {
      const code =
        error instanceof DispatchError && Object.hasOwn(errors, error.code)
          ? error.code
          : "service_unavailable";
      return reply.code(errors[code] ?? 503).send({ code });
    }
  });
}
