import pg from "pg";

export function controlPool(connectionString: string) {
  return new pg.Pool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
    options: "-c timezone=UTC",
  });
}

export type ControlPool = pg.Pool;
export type ControlClient = pg.PoolClient;

export async function transaction<T>(
  pool: ControlPool,
  operation: (db: ControlClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await operation(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}

export type ReviewCommand = {
  channel: string;
  expectedRevision: number;
  actor: string;
  reason: string;
  idempotencyKey: string;
} & (
  | { kind: "rollback" }
  | {
      kind: "promote" | "reject";
      experimentId: string;
      candidateHash: string;
      reportDigest: string;
    }
);

export type ReviewResult =
  | { code: "ok"; decision_id: string; revision: number }
  | {
      code:
        | "invalid_review"
        | "channel_forbidden"
        | "channel_unavailable"
        | "idempotency_conflict"
        | "stale_revision"
        | "stale_baseline"
        | "rollback_unavailable"
        | "experiment_unavailable"
        | "report_mismatch"
        | "report_integrity"
        | "report_ineligible";
    };

// Call with the dedicated promoter pool after authenticating the operator.
export async function review(pool: ControlPool, command: ReviewCommand) {
  const comparison = command.kind === "rollback" ? null : command;
  const { rows } = await pool.query<{ result: ReviewResult }>(
    "SELECT hl.review($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
    [
      command.kind,
      command.channel,
      comparison?.experimentId ?? null,
      comparison?.candidateHash ?? null,
      comparison?.reportDigest ?? null,
      command.expectedRevision,
      command.actor,
      command.reason,
      command.idempotencyKey,
    ],
  );
  return rows[0]!.result;
}
