import type { ExperimentDetail } from "@harnesslab/schemas/types";

export class RequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function api<T>(
  path: string,
  token: string,
  options: { signal?: AbortSignal; body?: unknown; key?: string } = {},
): Promise<T> {
  const headers = new Headers();
  if (token) headers.set("Authorization", "Bearer " + token);
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", options.key ?? crypto.randomUUID());
  }
  const response = await fetch("/api/v1/" + path, {
    method: options.body === undefined ? "GET" : "POST",
    headers,
    cache: "no-store",
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (result.code === "invalid_token" && typeof window !== "undefined") {
      window.localStorage.removeItem("hl_operator_token");
    }
    throw new RequestError(
      response.status,
      result.code,
      result.message ?? "Request failed.",
    );
  }
  return result as T;
}

export const active = (status: ExperimentDetail["experiment"]["status"]) =>
  status === "queued" || status === "running";
