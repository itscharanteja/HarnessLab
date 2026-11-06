import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import schema from "../contracts/v1.json" with { type: "json" };
import type { ContractCatalog } from "../generated/contracts.ts";

const ajv = new Ajv2020({ allErrors: true });
formats.default(ajv);
ajv.addSchema(schema);

export function accepts<Name extends keyof ContractCatalog>(
  name: Name,
  input: unknown,
): input is ContractCatalog[Name] {
  const validate = ajv.getSchema<ContractCatalog[Name]>(
    `${schema.$id}#/$defs/${name}`,
  );
  if (!validate) throw new Error(`Unknown v1 contract ${name}`);
  return validate(input) === true;
}
