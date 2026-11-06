import { expect, test } from "vitest";
import examples from "../../packages/schemas/contracts/examples.json";
import type { ContractCatalog } from "../../packages/schemas/generated/contracts.ts";
import { accepts } from "../../packages/schemas/src/validate.ts";

test.each(examples)("$contract $label", ({ contract, payload, valid }) => {
  expect(accepts(contract as keyof ContractCatalog, payload)).toBe(valid);
});
