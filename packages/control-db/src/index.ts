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
