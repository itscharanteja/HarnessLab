import { randomUUID } from "node:crypto";
import { controlPool } from "@harnesslab/control-db";
import { submitFixture } from "./artifacts.ts";

const dsn = process.env.CONTROL_DISPATCHER_DSN;
const root = process.env.HL_DISPATCHER_ARTIFACT_DIR;
if (!dsn || !root || process.env.HL_MODE !== "fixture")
  throw new Error("Fixture dispatcher environment required");
const pool = controlPool(dsn);
try {
  const key = process.argv[2] ?? randomUUID();
  console.log(await submitFixture(pool, root, key));
} catch {
  console.error("Fixture submission failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
