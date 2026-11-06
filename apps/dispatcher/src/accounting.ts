import type { RunEnvelope, TraceEvent } from "@harnesslab/schemas/types";
import { digest, DispatchError } from "./artifacts.ts";

export type Price = { input: string; output: string };

export function readPrice(price: Price, pinned: string): Price {
  if (
    !price ||
    !/^\d{1,16}$/.test(price.input) ||
    !/^\d{1,16}$/.test(price.output) ||
    digest(price) !== pinned
  )
    throw new DispatchError("invalid_price_profile");
  return price;
}

export function charge(price: Price, input: bigint, output: bigint): bigint {
  return (
    (input * BigInt(price.input) + output * BigInt(price.output) + 999999n) /
    1000000n
  );
}

export function runMetrics(run: RunEnvelope) {
  let input = 0n,
    output = 0n,
    safety = 0,
    latency = 0;
  const calls = new Set<string>();
  for (const event of run.events) {
    latency = Math.max(latency, event.elapsed_ms);
    if (event.kind === "model_usage") {
      input += BigInt(event.payload.input_tokens);
      output += BigInt(event.payload.output_tokens);
    }
    if (event.kind === "policy_decision" && event.payload.safety_violation)
      safety++;
    if (
      (event.kind === "tool_request" || event.kind === "policy_decision") &&
      event.correlation_id?.startsWith("call_")
    )
      calls.add(event.correlation_id);
  }
  return { input, output, safety, calls: calls.size, latency };
}

export function replayTraceDigest(events: TraceEvent[]) {
  return digest(
    events.map((event) => ({
      seq: event.seq,
      kind: event.kind,
      outcome_code: event.outcome_code,
      correlation_id: event.correlation_id,
      payload:
        event.kind === "model_usage"
          ? { input_tokens: 0, output_tokens: 0, request_id: null }
          : event.payload,
    })),
  );
}

export function unknownUsage(run: RunEnvelope) {
  return (
    run.manifest.mode === "live" &&
    run.events.some(
      (event) =>
        event.kind === "policy_decision" &&
        [
          "usage_mismatch",
          "model_timeout",
          "model_error",
          "task_deadline",
          "run_interrupted",
        ].includes(event.outcome_code),
    )
  );
}
