import { createHash } from "node:crypto";
import {
  review,
  type ControlPool,
  type ReviewCommand,
} from "@harnesslab/control-db";
import type { ContractCatalog } from "@harnesslab/schemas/types";
import { serviceIdentity } from "@harnesslab/schemas/service-identity";
import { accepts } from "@harnesslab/schemas/validate";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, createAuth, requireOperator, type Caller } from "./auth.ts";
import * as read from "./reads.ts";

const messages: Record<string, string> = {
  invalid_request: "Check the request fields and try again.",
  invalid_query: "Check the pagination or graph options.",
  not_found: "The requested resource is unavailable.",
  proxy_required: "Use the same-origin HarnessLab API.",
  operator_required: "This action requires an operator.",
  origin_forbidden: "This request must come from the HarnessLab site.",
  invalid_token: "The access token could not be verified.",
  public_disabled: "Public fixture runs are disabled.",
  live_disabled: "Live experiments are disabled.",
  public_quota: "The fixture run limit has been reached.",
  idempotency_conflict:
    "This idempotency key was used with a different request.",
  stale_revision: "The active revision has changed.",
  stale_baseline:
    "The reviewed experiment no longer matches the active baseline.",
  report_ineligible: "The report is ineligible for activation.",
};

export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
) {
  reply.header("cache-control", "no-store");
  if (code === "report_integrity")
    request.log.warn(
      { event: "review_integrity_denied", request_id: request.id },
      "Review denied",
    );
  if (status === 429) reply.header("retry-after", "60");
  return reply.code(status).send({
    code,
    message: messages[code] ?? "The request could not be completed.",
    request_id: request.id,
  });
}

function respond<Name extends keyof ContractCatalog>(
  reply: FastifyReply,
  shape: Name,
  data: unknown,
  status = 200,
) {
  if (!accepts(shape, data)) throw new ApiError(503, "service_unavailable");
  return reply.code(status).send(data);
}

function parsed<Name extends keyof ContractCatalog>(
  shape: Name,
  input: unknown,
) {
  if (!accepts(shape, input)) throw new ApiError(400, "invalid_request");
  return input;
}

function parameter(
  request: FastifyRequest,
  name: string,
  shape: "Uuid" | "Digest",
) {
  const value = (request.params as Record<string, unknown>)[name];
  if (!accepts(shape, value)) throw new ApiError(400, "invalid_request");
  return value;
}

function idempotency(request: FastifyRequest) {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(key))
    throw new ApiError(400, "invalid_request");
  return key;
}

function reviewKey(command: string, key: string) {
  return createHash("sha256")
    .update(command)
    .update(":")
    .update(key)
    .digest("hex");
}

const dispatchErrors: Record<string, number> = {
  invalid_request: 400,
  experiment_unavailable: 404,
  public_disabled: 403,
  live_disabled: 403,
  idempotency_conflict: 409,
  cancel_unavailable: 409,
  experiment_budget: 409,
  public_quota: 429,
};

function dispatcher() {
  const origin = new URL(process.env.HL_DISPATCHER_INTERNAL_URL ?? "");
  const token = process.env.HL_API_DISPATCH_TOKEN ?? "";
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    token.length < 32
  )
    throw new Error("Invalid dispatcher configuration");
  return async (
    path: "submit-experiment" | "cancel-experiment",
    command: unknown,
  ) => {
    let result: Response;
    try {
      const target = new URL("/internal/v1/" + path, origin);
      const signal = AbortSignal.timeout(10000);
      result = await fetch(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(await serviceIdentity(target, signal)),
        },
        body: JSON.stringify(command),
        redirect: "error",
        signal,
      });
    } catch {
      throw new ApiError(503, "service_unavailable");
    }
    const body: unknown = await result.json().catch(() => null);
    if (!result.ok) {
      const code =
        body &&
        typeof body === "object" &&
        "code" in body &&
        typeof body.code === "string" &&
        Object.hasOwn(dispatchErrors, body.code)
          ? body.code
          : "service_unavailable";
      throw new ApiError(dispatchErrors[code] ?? 503, code);
    }
    return body;
  };
}

async function issueReview(
  promoter: ControlPool | undefined,
  command: ReviewCommand,
) {
  if (!promoter) throw new ApiError(503, "service_unavailable");
  const result = await review(promoter, command);
  if (result.code === "ok") return result;
  const status =
    result.code === "invalid_review"
      ? 400
      : result.code === "channel_forbidden"
        ? 403
        : ["channel_unavailable", "experiment_unavailable"].includes(
              result.code,
            )
          ? 404
          : 409;
  throw new ApiError(status, result.code);
}

export async function registerRoutes(
  app: FastifyInstance,
  pool: ControlPool,
  promoter?: ControlPool,
) {
  const authenticate = createAuth();
  const dispatch = dispatcher();
  const callers = new WeakMap<FastifyRequest, Caller>();
  const caller = (request: FastifyRequest) => callers.get(request)!;
  await app.register(
    async (api) => {
      api.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        callers.set(request, await authenticate(request, reply));
      });
      api.get("/experiments", async (request, reply) =>
        respond(
          reply,
          "ExperimentPage",
          await read.experiments(
            pool,
            caller(request),
            read.queryPage(request.query, "uuid"),
          ),
        ),
      );
      api.get("/experiments/:id", async (request, reply) =>
        respond(
          reply,
          "ExperimentDetail",
          await read.experimentDetail(
            pool,
            caller(request),
            parameter(request, "id", "Uuid"),
            read.detailQuery(request.query, true),
          ),
        ),
      );
      api.get("/experiments/:id/comparisons", async (request, reply) => {
        read.detailQuery(request.query);
        return respond(
          reply,
          "ExperimentComparisons",
          await read.comparisons(
            pool,
            caller(request),
            parameter(request, "id", "Uuid"),
          ),
        );
      });
      api.get("/experiments/:id/runs", async (request, reply) =>
        respond(
          reply,
          "RunPage",
          await read.runs(
            pool,
            caller(request),
            parameter(request, "id", "Uuid"),
            read.queryPage(request.query, "uuid"),
          ),
        ),
      );
      api.get("/runs/:id/trace", async (request, reply) =>
        respond(
          reply,
          "RunTracePage",
          await read.trace(
            pool,
            caller(request),
            parameter(request, "id", "Uuid"),
            read.queryPage(request.query, "seq", true),
          ),
        ),
      );
      api.get("/harnesses", async (request, reply) =>
        respond(
          reply,
          "HarnessPage",
          await read.harnesses(
            pool,
            caller(request),
            read.queryPage(request.query, "hash"),
          ),
        ),
      );
      api.get("/harnesses/:hash", async (request, reply) => {
        read.detailQuery(request.query);
        return respond(
          reply,
          "HarnessDetail",
          await read.harnessDetail(
            pool,
            caller(request),
            parameter(request, "hash", "Digest"),
          ),
        );
      });

      api.post("/experiments", async (request, reply) => {
        read.detailQuery(request.query);
        const submission = parsed("ExperimentSubmit", request.body);
        const actor = caller(request);
        if (submission.scope === "full_live") {
          requireOperator(actor);
          if (process.env.HL_MODE !== "live")
            throw new ApiError(403, "live_disabled");
        } else if (!actor.operator && process.env.HL_PUBLIC_RUNS !== "1") {
          throw new ApiError(403, "public_disabled");
        }
        const command = parsed("DispatchSubmission", {
          principal: actor.principal,
          idempotency_key: idempotency(request),
          submission,
        });
        return respond(
          reply,
          "ExperimentAccepted",
          await dispatch("submit-experiment", command),
          202,
        );
      });
      api.post("/experiments/:id/cancel", async (request, reply) => {
        read.detailQuery(request.query);
        parsed("EmptyCommand", request.body ?? {});
        const command = parsed("DispatchCancellation", {
          principal: caller(request).principal,
          idempotency_key: idempotency(request),
          id: parameter(request, "id", "Uuid"),
        });
        return respond(
          reply,
          "ExperimentAccepted",
          await dispatch("cancel-experiment", command),
          202,
        );
      });
      api.post("/experiments/:id/publish", async (request, reply) => {
        read.detailQuery(request.query);
        const actor = caller(request);
        requireOperator(actor);
        parsed("EmptyCommand", request.body ?? {});
        const id = parameter(request, "id", "Uuid");
        await read.visibleExperiment(pool, actor, id);
        const {
          rows: [row],
        } = await pool.query<{ result: unknown }>(
          "SELECT hl.publish_example($1,$2,$3) AS result",
          [id, actor.principal, idempotency(request)],
        );
        if (
          row?.result &&
          typeof row.result === "object" &&
          "code" in row.result &&
          typeof row.result.code === "string" &&
          ["idempotency_conflict", "publish_unavailable"].includes(
            row.result.code,
          )
        )
          throw new ApiError(409, row.result.code);
        return respond(reply, "PublicationAccepted", row?.result);
      });
      for (const kind of ["promote", "reject"] as const) {
        api.post(`/experiments/:id/${kind}`, async (request, reply) => {
          read.detailQuery(request.query);
          const actor = caller(request);
          requireOperator(actor);
          const body = parsed("DecisionRequest", request.body);
          if (
            body.reason.trim().length > 600 ||
            body.expected_revision > 2147483647
          )
            throw new ApiError(400, "invalid_request");
          const experimentId = parameter(request, "id", "Uuid");
          const experiment = await read.visibleExperiment(
            pool,
            actor,
            experimentId,
          );
          return respond(
            reply,
            "ReviewAccepted",
            await issueReview(promoter, {
              kind,
              channel: experiment.channel,
              experimentId,
              candidateHash: body.candidate_hash,
              reportDigest: body.report_digest,
              expectedRevision: body.expected_revision,
              reason: body.reason,
              actor: actor.principal,
              idempotencyKey: reviewKey(kind, idempotency(request)),
            }),
          );
        });
      }
      api.post("/channels/:channel/rollback", async (request, reply) => {
        read.detailQuery(request.query);
        const actor = caller(request);
        requireOperator(actor);
        const channel = (request.params as { channel: string }).channel;
        const body = parsed("RollbackRequest", request.body);
        if (
          !/^[a-z0-9-]{1,60}$/.test(channel) ||
          body.reason.trim().length > 600 ||
          body.expected_revision > 2147483647
        )
          throw new ApiError(400, "invalid_request");
        return respond(
          reply,
          "ReviewAccepted",
          await issueReview(promoter, {
            kind: "rollback",
            channel,
            expectedRevision: body.expected_revision,
            reason: body.reason,
            actor: actor.principal,
            idempotencyKey: reviewKey("rollback", idempotency(request)),
          }),
        );
      });
    },
    { prefix: "/v1" },
  );
}
