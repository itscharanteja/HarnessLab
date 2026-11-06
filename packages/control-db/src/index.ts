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
