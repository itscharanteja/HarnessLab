import { timingSafeEqual } from "node:crypto";
import { transaction, type ControlPool } from "@harnesslab/control-db";
import type {
  CheckpointRequest,
  CheckpointResponse,
} from "@harnesslab/schemas/types";
import { accepts } from "@harnesslab/schemas/validate";
import type { FastifyInstance } from "fastify";
import { digest } from "./artifacts.ts";
import { safePayload } from "./work.ts";

function authorized(expected: string | undefined, actual: string | undefined) {
  if (!expected || !actual) return false;
  const a = Buffer.from(`Bearer ${expected}`);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkpointStateSafe(state: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (Array.isArray(state))
    return (
      state.length <= 500 &&
      state.every((value) => checkpointStateSafe(value, depth + 1))
    );
  if (state === null || typeof state === "boolean") return true;
  if (typeof state === "string")
    return (
      state.length <= 65536 &&
      !/\/(?:holdout)\/|(?:postgres(?:ql)?:\/\/)/i.test(state)
    );
  if (typeof state === "number") return Number.isSafeInteger(state);
  if (typeof state !== "object") return false;
  const entries = Object.entries(state);
  return (
    entries.length <= 160 &&
    entries.every(
      ([key, value]) =>
        !/(?:oracle|holdout|secret|credential|password|token$|dsn|api_key|raw_provider)/i.test(
          key,
        ) && checkpointStateSafe(value, depth + 1),
    )
  );
}

export function registerCheckpoints(app: FastifyInstance, pool: ControlPool) {
  app.post(
    "/internal/v1/checkpoint",
    { bodyLimit: 524288 },
    async (request, reply) => {
      const auth = request.headers.authorization;
      const worker = authorized(process.env.HL_WORKER_CHECKPOINT_TOKEN, auth);
      const optimizer = authorized(
        process.env.HL_OPTIMIZER_CHECKPOINT_TOKEN,
        auth,
      );
      if (worker === optimizer)
        return reply.code(401).send({ code: "unauthorized" });
      const data = request.body;
      const leaseToken = request.headers["x-hl-lease-token"];
      if (
        !accepts("CheckpointRequest", data) ||
        !accepts("Uuid", leaseToken) ||
        (data.operation === "write") !== (data.state !== null) ||
        !safePayload(data.state) ||
        !checkpointStateSafe(data.state)
      )
        return reply.code(400).send({ code: "invalid_checkpoint" });
      const requestData: CheckpointRequest = data;
      const kind = worker ? "execute_task" : "analyze_and_propose";
      return transaction(pool, async (db) => {
        const {
          rows: [item],
        } = await db.query<{
          graph_version: string;
          input_digest: string;
          experiment_id: string;
          work_key: string;
        }>(
          `SELECT graph_version,input_digest,experiment_id,work_key FROM hl.work_items WHERE
           id=$1 AND fence=$2 AND lease_token=$3 AND kind=$4 AND state='running'
           AND lease_until>clock_timestamp() FOR UPDATE`,
          [requestData.work_id, requestData.fence, leaseToken, kind],
        );
        if (!item) return reply.code(403).send({ code: "checkpoint_scope" });
        if (
          requestData.graph_version !== item.graph_version ||
          !item.input_digest
        )
          return reply.code(409).send({ code: "checkpoint_version" });
        const thread = digest({
          work_key: item.work_key,
          experiment_id: item.experiment_id,
          graph: kind,
        });
        if (requestData.operation === "write") {
          const encoded = JSON.stringify(requestData.state);
          await db.query(
            `INSERT INTO hl.graph_checkpoints(work_id,thread_id,seq,write_key,graph_version,state_version,input_digest,payload)
           SELECT $1,$2,$3,$4,$5,1,$6,$7::jsonb
           WHERE (SELECT count(*) FROM hl.graph_checkpoints WHERE work_id=$1)<120
           ON CONFLICT DO NOTHING`,
            [
              requestData.work_id,
              thread,
              requestData.seq,
              requestData.write_key,
              item.graph_version,
              item.input_digest,
              encoded,
            ],
          );
        }
        const {
          rows: [record],
        } = await db.query<{ payload: CheckpointResponse["state"] }>(
          `SELECT payload FROM hl.graph_checkpoints WHERE work_id=$1 AND seq=$2 AND write_key=$3
           AND input_digest=$4 AND graph_version=$5 AND state_version=1`,
          [
            requestData.work_id,
            requestData.seq,
            requestData.write_key,
            item.input_digest,
            item.graph_version,
          ],
        );
        const state = record?.payload ?? null;
        if (
          requestData.operation === "write" &&
          (state === null || digest(state) !== digest(requestData.state))
        )
          return reply.code(409).send({ code: "checkpoint_conflict" });
        const response: CheckpointResponse = {
          schema_version: 1,
          thread_id: thread,
          input_digest: item.input_digest,
          state,
        };
        return response;
      });
    },
  );
}
