import { afterEach, expect, test, vi } from "vitest";
import { serviceIdentity } from "../../packages/schemas/src/service-identity.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("local private requests skip Cloud Run metadata", async () => {
  vi.stubEnv("HL_CLOUD_RUN_IDENTITY", "0");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    serviceIdentity(
      new URL("http://runner:8000/internal/v1/execute-task"),
      AbortSignal.timeout(1000),
    ),
  ).resolves.toEqual({});
  expect(fetch).not.toHaveBeenCalled();
});

test("hosted requests obtain and reuse identity for the receiving service origin", async () => {
  vi.stubEnv("HL_CLOUD_RUN_IDENTITY", "1");
  const audience = "https://fixture-dispatcher.a.run.app";
  const part = Buffer.from(
    JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 300 }),
  ).toString("base64url");
  const token = `eyJ9.${part}.signature`;
  const fetch = vi.fn(async (url: URL, options: RequestInit) => {
    expect(url.hostname).toBe("metadata.google.internal");
    expect(url.searchParams.get("audience")).toBe(audience);
    expect(options.headers).toEqual({ "Metadata-Flavor": "Google" });
    return new Response(token);
  });
  vi.stubGlobal("fetch", fetch);
  for (const path of [
    "/internal/v1/checkpoint",
    "/internal/v1/submit-experiment",
  ]) {
    await expect(
      serviceIdentity(new URL(audience + path), AbortSignal.timeout(1000)),
    ).resolves.toEqual({ "X-Serverless-Authorization": `Bearer ${token}` });
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(
    serviceIdentity(
      new URL("https://outside.example/"),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow("audience");
});
