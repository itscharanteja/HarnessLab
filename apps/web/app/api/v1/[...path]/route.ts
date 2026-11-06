import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_BODY = 16384;

function failure(status: number, code: string) {
  return Response.json(
    {
      code,
      message: "The request could not be completed.",
      request_id: randomUUID(),
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function forward(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  if (!path.length || path.some((part) => !/^[A-Za-z0-9_-]{1,100}$/.test(part)))
    return failure(404, "not_found");
  const base = process.env.HL_API_INTERNAL_URL;
  const token = process.env.HL_PROXY_TOKEN;
  if (!base || !token) return failure(503, "service_unavailable");
  const target = new URL(`/v1/${path.join("/")}`, base);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  )
    return failure(503, "service_unavailable");
  target.search = new URL(request.url).search;
  const headers = new Headers({ "x-hl-proxy-token": token });
  for (const name of [
    "authorization",
    "origin",
    "content-type",
    "idempotency-key",
  ]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const cookies = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => /^(?:__Host-)?hl_session=/.test(value));
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  let body: string | undefined;
  if (request.method === "POST") {
    if (request.headers.get("origin") !== process.env.HL_PUBLIC_ORIGIN)
      return failure(403, "origin_forbidden");
    if (request.body) {
      const reader = request.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY) return failure(400, "invalid_request");
          parts.push(value);
        }
        body = Buffer.concat(parts).toString("utf8");
      } catch {
        return failure(400, "invalid_request");
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }
  }
  try {
    const result = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    });
    const outgoing = new Headers({ "cache-control": "no-store" });
    for (const name of ["content-type", "retry-after"]) {
      const value = result.headers.get(name);
      if (value) outgoing.set(name, value);
    }
    for (const cookie of result.headers.getSetCookie())
      outgoing.append("set-cookie", cookie);
    return new Response(result.body, {
      status: result.status,
      headers: outgoing,
    });
  } catch {
    return failure(503, "service_unavailable");
  }
}

export const GET = forward;
export const POST = forward;
