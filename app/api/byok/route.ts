import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { type NextRequest, NextResponse } from "next/server";
import { validateUserKey, type AiProvider } from "@/lib/ai/client";
import { BYOK_COOKIE, byokCookieOptions, readByokSession, sealApiKey } from "@/lib/anthropic/byok";
import { isSameOrigin } from "@/lib/http/origin";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  const session = readByokSession(req);
  return NextResponse.json(
    { connected: Boolean(session), provider: session?.provider ?? null, expiresAt: session?.expiresAt ?? null },
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

  const body = (await req.json().catch(() => null)) as { provider?: unknown; apiKey?: unknown } | null;
  const provider = body?.provider === "anthropic" || body?.provider === "openai" ? body.provider : null;
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const validPrefix = provider === "anthropic" ? apiKey.startsWith("sk-ant-") : apiKey.startsWith("sk-");
  if (!provider || !validPrefix || apiKey.length < 24 || apiKey.length > 512 || /\s/.test(apiKey)) {
    return NextResponse.json({ error: "Enter a valid API key for the selected provider." }, { status: 400, headers: NO_STORE });
  }

  let sealed;
  try {
    sealed = sealApiKey(provider, apiKey);
  } catch {
    return NextResponse.json(
      { error: "BYOK is not configured on this deployment." },
      { status: 503, headers: NO_STORE },
    );
  }

  try {
    await validateUserKey(provider, apiKey, req.signal);
  } catch (error) {
    const status =
      error instanceof Anthropic.APIError || error instanceof OpenAI.APIError ? error.status : undefined;
    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} rejected this API key.` },
        { status: 400, headers: NO_STORE },
      );
    }
    return NextResponse.json(
      { error: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} could not verify the key. Try again shortly.` },
      { status: 503, headers: NO_STORE },
    );
  }

  const response = NextResponse.json({ connected: true, provider, expiresAt: sealed.expiresAt }, { headers: NO_STORE });
  response.cookies.set(BYOK_COOKIE, sealed.value, byokCookieOptions(req));
  return response;
}

export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403, headers: NO_STORE });
  }
  const response = NextResponse.json({ connected: false, provider: null, expiresAt: null }, { headers: NO_STORE });
  response.cookies.set(BYOK_COOKIE, "", byokCookieOptions(req, 0));
  return response;
}
