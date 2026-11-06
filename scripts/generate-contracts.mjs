import { readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";

const schemaFile = new URL(
  "../packages/schemas/contracts/v1.json",
  import.meta.url,
);
const destination =
  process.argv[2] ??
  new URL("../packages/schemas/generated/contracts.ts", import.meta.url);
const schema = JSON.parse(await readFile(schemaFile, "utf8"));
const output = await compile(schema, "ContractCatalog", {
  bannerComment: "// Generated from packages/schemas/contracts/v1.json.",
  strictIndexSignatures: true,
  ignoreMinAndMaxItems: true,
  unknownAny: true,
});
await writeFile(destination, output);
