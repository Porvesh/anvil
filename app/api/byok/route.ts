import Anthropic from "@anthropic-ai/sdk";
import { type NextRequest, NextResponse } from "next/server";
import {
  BYOK_COOKIE,
  BYOK_MAX_AGE_SECONDS,
  isSameOrigin,
  readByokSession,
  sealApiKey,
  secureCookieFor,
  validateAnthropicKey,
} from "@/lib/anthropic/byok";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const session = readByokSession(req);
  return NextResponse.json(
    { connected: Boolean(session), expiresAt: session?.expiresAt ?? null },
    { headers: NO_STORE },
  );
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403, headers: NO_STORE });
  }
  if (!rateLimit(`byok:${clientKey(req)}`).ok) {
    return NextResponse.json({ error: "Too many key checks. Try again shortly." }, { status: 429, headers: NO_STORE });
  }

  const body = (await req.json().catch(() => null)) as { apiKey?: unknown } | null;
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey.startsWith("sk-ant-") || apiKey.length < 24 || apiKey.length > 256 || /\s/.test(apiKey)) {
    return NextResponse.json({ error: "Enter a valid Anthropic API key." }, { status: 400, headers: NO_STORE });
  }

  let sealed;
  try {
    sealed = sealApiKey(apiKey);
  } catch {
    return NextResponse.json(
      { error: "BYOK is not configured on this deployment." },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    await validateAnthropicKey(apiKey, req.signal);
  } catch (error) {
    if (error instanceof Anthropic.APIError && (error.status === 401 || error.status === 403)) {
      return NextResponse.json({ error: "Anthropic rejected this API key." }, { status: 400, headers: NO_STORE });
    }
    return NextResponse.json(
      { error: "Anthropic could not verify the key. Try again shortly." },
      { status: 503, headers: NO_STORE },
    );
  }

  const response = NextResponse.json({ connected: true, expiresAt: sealed.expiresAt }, { headers: NO_STORE });
  response.cookies.set(BYOK_COOKIE, sealed.value, {
    httpOnly: true,
    secure: secureCookieFor(req),
    sameSite: "strict",
    path: "/",
    maxAge: BYOK_MAX_AGE_SECONDS,
    priority: "high",
  });
  return response;
}

export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403, headers: NO_STORE });
  }
  const response = NextResponse.json({ connected: false, expiresAt: null }, { headers: NO_STORE });
  response.cookies.set(BYOK_COOKIE, "", {
    httpOnly: true,
    secure: secureCookieFor(req),
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
