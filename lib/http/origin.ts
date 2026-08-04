/**
 * Where a request really came from, behind a proxy.
 *
 * Every deployment target for Anvil terminates TLS somewhere in front of Node,
 * so `new URL(req.url).protocol` is `http:` in production and the raw host is
 * wrong. Three things depend on getting this right — the CSRF origin check, the
 * `Secure` cookie flag, and the absolute URL baked into a sign-in email — so the
 * forwarding logic is written once here.
 */

/** The forwarded scheme, when a proxy set one. */
function forwardedProto(req: Request): string | undefined {
  return req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
}

/** Prevent another origin from setting or clearing a credential cookie. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  return origin === requestOrigin(req);
}

/** True when the request arrived over HTTPS, directly or through a proxy. */
export function secureCookieFor(req: Request): boolean {
  const proto = forwardedProto(req);
  return proto ? proto === "https" : new URL(req.url).protocol === "https:";
}

/** The origin this request believes it is serving, e.g. `https://anvil.example`. */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("host");
  if (!host) return url.origin;
  return `${forwardedProto(req) || url.protocol.slice(0, -1)}://${host}`;
}

/**
 * The origin to put in outbound links (sign-in emails).
 *
 * Prefers the configured `AUTH_BASE_URL`, because a link is durable and a
 * `Host` header is attacker-controllable: without the override, a request
 * carrying a forged `Host` could mint an email pointing at someone else's
 * domain. Falls back to the request's own origin, which is correct locally.
 */
export function appOrigin(req: Request): string {
  const configured = process.env.AUTH_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return requestOrigin(req);
}
