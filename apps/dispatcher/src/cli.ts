import { randomUUID } from "node:crypto";
import { controlPool } from "@harnesslab/control-db";
import { submitFixture } from "./artifacts.ts";
import { submitTrial } from "./trials.ts";

const dsn = process.env.CONTROL_DISPATCHER_DSN;
const root = process.env.HL_DISPATCHER_ARTIFACT_DIR;
if (!dsn || !root || process.env.HL_MODE !== "fixture")
  throw new Error("Fixture dispatcher environment required");
const pool = controlPool(dsn);
try {
  const trial = process.argv[2] === "--trial";
  const key = process.argv[trial ? 3 : 2] ?? randomUUID();
  const id = await (trial ? submitTrial : submitFixture)(pool, root, key);
  console.log(id);
  if (trial) {
    // This operator CLI can wait for a slow local container to finish its stored trial.
    const end = Date.now() + 300000;
    for (;;) {
      const row = await pool
        .query<{ status: string; report: unknown }>(
          `SELECT e.status,r.report
          FROM hl.experiments e LEFT JOIN hl.trial_reports r ON r.experiment_id=e.id WHERE e.id=$1`,
          [id],
        )
        .then(({ rows }) => rows[0])
        .catch((error: unknown) => {
          const transient =
            error instanceof Error &&
            ([
              "Query read timeout",
              "timeout exceeded when trying to connect",
            ].includes(error.message) ||
              ("code" in error &&
                ["57014", "ETIMEDOUT", "ECONNRESET"].includes(
                  String(error.code),
                )));
          if (!transient) throw error;
          return undefined;
        });
      if (row && ["completed", "failed", "cancelled"].includes(row.status)) {
        console.log(JSON.stringify(row.report));
        process.exitCode = row.status === "completed" ? 0 : 1;
        break;
      }
      if (Date.now() > end) {
        console.error(`Fixture trial is still running. Retry with key ${key}.`);
        process.exitCode = 1;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
} catch {
  console.error("Fixture submission failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
