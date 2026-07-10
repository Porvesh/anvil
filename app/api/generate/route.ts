import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { generateAndPersist } from "@/lib/generation";
import { clientKey, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
// Generation runs Sonnet + a self-check; give it room.
export const maxDuration = 120;

const bodySchema = z.object({
  type: z.enum(["debug", "review", "any"]).default("any"),
  difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
  jd: z.string().max(4000).optional(),
});

/**
 * POST /api/generate — generate a NEW problem tailored to the pasted JD (spec
 * §4 "JD tailoring", §11 generation). This is the on-miss path: rather than
 * only serving the seeded bank, a JD produces a fresh, verified, multi-file
 * problem that then persists into the shared bank for everyone.
 *
 * Design is not live-generated (no executable oracle); the client falls back to
 * bank selection for design.
 */
export async function POST(req: Request) {
  // Generation is the expensive path — rate-limit it harder via the shared limiter.
  const limit = rateLimit(`gen:${clientKey(req)}`);
  if (!limit.ok) return NextResponse.json({ error: "Generation is rate-limited — try again shortly." }, { status: 429 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { type, difficulty, jd } = parsed.data;

  // "any" → pick a type; if a JD mentions reviewing PRs, bias to review.
  const resolvedType =
    type === "any" ? (jd && /review|pull request|\bpr\b/i.test(jd) ? "review" : "debug") : type;

  try {
    // Bound wall-clock in the request path: each attempt is a full streaming
    // generation + self-check, so cap at 2 (the offline CLI uses more).
    const result = await generateAndPersist(prisma, { type: resolvedType, difficulty, jd, maxAttempts: 2 });
    if (!result) {
      return NextResponse.json({ error: "Couldn't verify a fresh problem this time — try again." }, { status: 502 });
    }
    return NextResponse.json({ id: result.id, title: result.title, type: resolvedType });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Generation failed" }, { status: 500 });
  }
}
