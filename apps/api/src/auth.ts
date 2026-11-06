import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { accepts } from "@harnesslab/schemas/validate";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function secretEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type Caller = {
  principal: string;
  authenticated: boolean;
  operator: boolean;
};
const SESSION_AGE = 7 * 24 * 60 * 60;

export function createAuth(env: NodeJS.ProcessEnv = process.env) {
  const publicUrl = new URL(env.HL_PUBLIC_ORIGIN ?? "");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(
    publicUrl.hostname,
  );
  const mode = env.HL_AUTH_MODE ?? "supabase";
  const fixture = mode === "fixture";
  const secure = publicUrl.protocol === "https:";
  if (
    publicUrl.origin !== env.HL_PUBLIC_ORIGIN ||
    (!secure && !(local && publicUrl.protocol === "http:")) ||
    (mode !== "supabase" && !fixture) ||
    (fixture && (!local || env.HL_MODE !== "fixture"))
  )
    throw new Error("Invalid API identity configuration");
  const proxyToken = env.HL_PROXY_TOKEN ?? "";
  const sessionKey = env.HL_SESSION_SIGNING_KEY ?? "";
  const fixtureToken = env.HL_FIXTURE_OPERATOR_TOKEN ?? "";
  const operators = new Set(
    (env.HL_OPERATOR_SUBJECTS ?? "").split(",").filter(Boolean),
  );
  if (
    proxyToken.length < 32 ||
    sessionKey.length < 32 ||
    [...operators].some((subject) => !accepts("Uuid", subject)) ||
    (fixture &&
      (fixtureToken.length < 32 ||
        !accepts("Uuid", env.HL_FIXTURE_OPERATOR_SUBJECT)))
  )
    throw new Error("Invalid API credentials");
  const issuer = env.HL_SUPABASE_ISSUER ?? "";
  const audience = env.HL_SUPABASE_AUDIENCE ?? "";
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  if (!fixture) {
    const issuerUrl = new URL(issuer);
    const url = new URL(
      env.HL_SUPABASE_JWKS_URL || issuer + "/.well-known/jwks.json",
    );
    if (
      issuerUrl.protocol !== "https:" ||
      url.protocol !== "https:" ||
      url.origin !== issuerUrl.origin ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      issuerUrl.username ||
      issuerUrl.password ||
      issuerUrl.hash ||
      issuerUrl.search ||
      !audience
    )
      throw new Error("Invalid Supabase JWKS configuration");
    jwks = createRemoteJWKSet(url, {
      timeoutDuration: 2500,
      cacheMaxAge: 300000,
    });
  }
  const cookieName = secure ? "__Host-hl_session" : "hl_session";
  const sign = (value: string) =>
    createHmac("sha256", sessionKey).update(value).digest("base64url");
  const now = () => Math.floor(Date.now() / 1000);

  function session(request: FastifyRequest, reply: FastifyReply) {
    const cookies = (request.headers.cookie ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(cookieName + "="));
    const candidate =
      cookies.length === 1 ? cookies[0]!.slice(cookieName.length + 1) : "";
    const [id, expiry, mac, extra] = candidate.split(".");
    if (
      extra === undefined &&
      accepts("Uuid", id) &&
      expiry &&
      /^\d{10}$/.test(expiry) &&
      Number(expiry) > now() &&
      Number(expiry) <= now() + SESSION_AGE &&
      mac &&
      secretEqual(mac, sign(`${id}.${expiry}`))
    )
      return `public:${id}`;
    const next = randomUUID();
    const payload = `${next}.${now() + SESSION_AGE}`;
    reply.header(
      "set-cookie",
      `${cookieName}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_AGE}${secure ? "; Secure" : ""}`,
    );
    return `public:${next}`;
  }

  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Caller> {
    const proxy = request.headers["x-hl-proxy-token"];
    if (typeof proxy !== "string" || !secretEqual(proxy, proxyToken))
      throw new ApiError(401, "proxy_required");
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== publicUrl.origin
    )
      throw new ApiError(403, "origin_forbidden");
    const auth = request.headers.authorization;
    if (auth !== undefined) {
      const token = /^Bearer ([^\s]{1,8192})$/.exec(auth)?.[1];
      if (!token) throw new ApiError(401, "invalid_token");
      let subject: string;
      try {
        if (fixture) {
          if (!secretEqual(token, fixtureToken))
            throw new Error("Invalid token");
          subject = env.HL_FIXTURE_OPERATOR_SUBJECT!;
        } else {
          const { payload } = await jwtVerify(token, jwks!, {
            issuer,
            audience,
            algorithms: ["ES256", "RS256"],
            requiredClaims: ["exp", "sub"],
          });
          if (!accepts("Uuid", payload.sub)) throw new Error("Invalid subject");
          subject = payload.sub;
        }
      } catch {
        throw new ApiError(401, "invalid_token");
      }
      if (operators.has(subject))
        return {
          principal: `operator:${subject}`,
          authenticated: true,
          operator: true,
        };
      return {
        principal: session(request, reply),
        authenticated: true,
        operator: false,
      };
    }
    return {
      principal: session(request, reply),
      authenticated: false,
      operator: false,
    };
  }
  return authenticate;
}

export function requireOperator(caller: Caller) {
  if (!caller.operator)
    throw new ApiError(caller.authenticated ? 403 : 401, "operator_required");
}
