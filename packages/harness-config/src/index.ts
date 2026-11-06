import { accepts } from "@harnesslab/schemas/validate";
import type { HarnessConfig } from "@harnesslab/schemas/types";

export function isHarnessConfig(value: unknown): value is HarnessConfig {
  return accepts("HarnessConfig", value);
}
