const metadata =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const cache = new Map<string, { token: string; expires: number }>();

export async function serviceIdentity(
  target: URL,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  if (process.env.HL_CLOUD_RUN_IDENTITY !== "1") return {};
  if (
    target.protocol !== "https:" ||
    !target.hostname.endsWith(".run.app") ||
    target.port ||
    target.username ||
    target.password
  )
    throw new Error("Invalid service identity audience");
  const audience = target.origin;
  const now = Date.now() / 1000;
  let identity = cache.get(audience);
  if (!identity || identity.expires <= now + 60) {
    const url = new URL(metadata);
    url.searchParams.set("audience", audience);
    const response = await fetch(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
      redirect: "error",
    });
    const token = await response.text();
    const parts = token.split(".");
    if (
      !response.ok ||
      parts.length !== 3 ||
      token.length > 8192 ||
      !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new Error("Cloud Run identity unavailable");
    const claims = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { aud?: string; exp?: number };
    if (
      claims.aud !== audience ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp! <= now + 60
    )
      throw new Error("Invalid Cloud Run identity");
    identity = { token, expires: claims.exp! };
    cache.set(audience, identity);
  }
  return { "X-Serverless-Authorization": `Bearer ${identity.token}` };
}
