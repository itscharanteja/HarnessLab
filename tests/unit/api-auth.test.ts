import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { createAuth, requireOperator } from "../../apps/api/src/auth.ts";

const issuer = "https://example.supabase.co/auth/v1";
const subject = "67cf8d62-a69d-440e-aee0-3451430099cd";
const origin = "https://app.example.com";
const secret = "api-test-secret-for-proxy-00000001";
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "main",
  alg: "ES256",
  use: "sig",
};

function jwt(claims: Record<string, unknown> = {}, key = pair.privateKey) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = encode({
    iss: issuer,
    aud: "authenticated",
    sub: subject,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...claims,
  });
  const input =
    encode({ alg: "ES256", typ: "JWT", kid: "main" }) + "." + payload;
  return (
    input +
    "." +
    sign("sha256", Buffer.from(input), {
      key,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url")
  );
}

function setup() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      expect(String(url)).toBe(issuer + "/.well-known/jwks.json");
      return Response.json({ keys: [jwk] });
    }),
  );
  const authenticate = createAuth({
    HL_PUBLIC_ORIGIN: origin,
    HL_PROXY_TOKEN: secret,
    HL_SESSION_SIGNING_KEY: "api-test-secret-for-cookie-0000001",
    HL_SUPABASE_ISSUER: issuer,
    HL_SUPABASE_AUDIENCE: "authenticated",
    HL_OPERATOR_SUBJECTS: subject,
  });
  const invoke = (token: string, sent = secret) =>
    authenticate(
      {
        headers: {
          authorization: "Bearer " + token,
          "x-hl-proxy-token": sent,
          origin,
        },
        method: "POST",
      } as Parameters<typeof authenticate>[0],
      { header: vi.fn() } as unknown as Parameters<typeof authenticate>[1],
    );
  return invoke;
}

afterEach(() => vi.unstubAllGlobals());

test("verifies Supabase issuer, audience, expiry, and asymmetric signature", async () => {
  const auth = setup();
  await expect(auth(jwt())).resolves.toEqual({
    principal: "operator:" + subject,
    operator: true,
    authenticated: true,
  });
  for (const token of [
    jwt({ iss: "https://other.example" }),
    jwt({ aud: "anon" }),
    jwt({ exp: 1 }),
    jwt({ nbf: Math.floor(Date.now() / 1000) + 60 }),
    jwt({}, other.privateKey),
  ]) {
    await expect(auth(token)).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });
  }
  await expect(auth(jwt(), "forged")).rejects.toMatchObject({
    status: 401,
    code: "proxy_required",
  });
});

test("operator claims do not override the server allowlist", async () => {
  const auth = setup();
  const caller = await auth(
    jwt({ sub: "2c7cadf5-e3a9-4bb4-a090-c51c0bcb7698", role: "operator" }),
  );
  expect(caller.operator).toBe(false);
  expect(caller.principal).toMatch(/^public:/);
  expect(() => requireOperator(caller)).toThrow("operator_required");
});
