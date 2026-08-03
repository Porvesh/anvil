import { type NextRequest, NextResponse } from "next/server";
import { byokRequiredResponse, isSameOrigin, userModelFromRequest } from "@/lib/anthropic/byok";
import { classifyModelError, isAbortError } from "@/lib/anthropic/reliability";
import { SSE_HEADERS } from "@/lib/anthropic/stream";
import {
  SANITIZATION_VERSION,
  analyzeContribution,
  contributionModel,
  findDuplicate,
  generationTopic,
  rejectionMessage,
  shortlistCandidates,
} from "@/lib/contribution/intake";
import { prisma } from "@/lib/db";
import { generateAndPersist } from "@/lib/generation";
import { clientKey, dailyLimit, rateLimit } from "@/lib/ratelimit";
import { parseTags } from "@/lib/tags";
import type { Difficulty, ProblemType } from "@/lib/types";
import { contributionBodySchema } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 800;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Review and transform a real interview prompt without retaining its source.
 * The request body is deliberately never passed to Prisma, logs, or a queue.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "Cross-origin request rejected" }, { status: 403, headers: NO_STORE });
  }
  if (!rateLimit(`contribution:${clientKey(req)}`).ok) {
    return NextResponse.json({ error: "Too many contribution requests. Try again shortly." }, { status: 429, headers: NO_STORE });
  }

  const client = userModelFromRequest(req);
  if (!client) return byokRequiredResponse();

  const parsed = contributionBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid contribution", details: parsed.error.flatten() }, { status: 400, headers: NO_STORE });
  }
  const budget = dailyLimit(`contribution:${parsed.data.sessionId}`);
  if (!budget.ok) {
    return NextResponse.json(
      { error: `You've reviewed ${budget.limit} contributions today. Try again tomorrow.` },
      { status: 429, headers: NO_STORE },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      let receiptId: string | null = null;

      try {
        send({ type: "phase", phase: "analyzing", note: "Extracting the reusable engineering signal" });
        const decision = await analyzeContribution(client, parsed.data, req.signal);
        const { intake } = decision;

        if (decision.rejectionCode) {
          const receipt = await prisma.contribution.create({
            data: {
              sessionId: parsed.data.sessionId,
              status: "rejected",
              type: intake.type,
              difficulty: intake.difficulty,
              seniority: intake.seniority,
              tags: intake.tags,
              qualityScore: intake.qualityScore,
              rejectionCode: decision.rejectionCode,
              provider: client.provider,
              model: decision.rejectionCode === "unsafe_input" ? null : contributionModel(client),
            },
            select: { id: true },
          });
          send({
            type: "done",
            outcome: "rejected",
            receiptId: receipt.id,
            reasonCode: decision.rejectionCode,
            message: rejectionMessage(decision.rejectionCode),
          });
          return;
        }

        send({ type: "phase", phase: "comparing", note: "Checking for an equivalent verified problem" });
        const rows = await prisma.problem.findMany({
          where: { retired: false, type: intake.type },
          select: { id: true, title: true, prompt: true, type: true, difficulty: true, tags: true },
        });
        const candidates = shortlistCandidates(
          intake.tags,
          rows.map((row) => ({
            id: row.id,
            title: row.title,
            prompt: row.prompt,
            type: row.type as ProblemType,
            difficulty: row.difficulty as Difficulty,
            tags: parseTags(row.tags),
          })),
        );
        const duplicate = await findDuplicate(client, intake, candidates, req.signal);

        if (duplicate.problemId) {
          const existing = candidates.find((candidate) => candidate.id === duplicate.problemId)!;
          const receipt = await prisma.contribution.create({
            data: {
              sessionId: parsed.data.sessionId,
              status: "duplicate",
              type: intake.type,
              difficulty: intake.difficulty,
              seniority: intake.seniority,
              tags: intake.tags,
              qualityScore: intake.qualityScore,
              duplicateProblemId: existing.id,
              provider: client.provider,
              model: contributionModel(client),
            },
            select: { id: true },
          });
          send({
            type: "done",
            outcome: "duplicate",
            receiptId: receipt.id,
            problemId: existing.id,
            title: existing.title,
            similarity: duplicate.similarity,
          });
          return;
        }

        const receipt = await prisma.contribution.create({
          data: {
            sessionId: parsed.data.sessionId,
            status: "generating",
            type: intake.type,
            difficulty: intake.difficulty,
            seniority: intake.seniority,
            tags: intake.tags,
            qualityScore: intake.qualityScore,
            provider: client.provider,
            model: contributionModel(client),
          },
          select: { id: true },
        });
        receiptId = receipt.id;

        send({ type: "phase", phase: "authoring", note: "Authoring an original exercise from the sanitized skill brief" });
        const generated = await generateAndPersist(prisma, {
          client,
          type: intake.type,
          difficulty: intake.difficulty,
          topic: generationTopic(intake),
          maxAttempts: 2,
          signal: req.signal,
          source: "community",
          sourceContributionId: receipt.id,
          intakeQualityScore: intake.qualityScore,
          sanitizationVersion: SANITIZATION_VERSION,
          onProgress: (note) => send({ type: "phase", phase: "verifying", note }),
        });

        if (!generated) {
          await prisma.contribution.update({
            where: { id: receipt.id },
            data: { status: "rejected", rejectionCode: "generation_quality_gate" },
          });
          send({
            type: "done",
            outcome: "rejected",
            receiptId: receipt.id,
            reasonCode: "generation_quality_gate",
            message: "The idea was useful, but the generated exercise did not pass Anvil's verification checks. Nothing was added.",
          });
          return;
        }

        await prisma.contribution.update({
          where: { id: receipt.id },
          data: { status: "accepted", problemId: generated.id },
        });
        send({
          type: "done",
          outcome: "accepted",
          receiptId: receipt.id,
          problemId: generated.id,
          title: generated.title,
          problemType: intake.type,
        });
      } catch (error) {
        if (receiptId) {
          await prisma.contribution
            .update({
              where: { id: receiptId },
              data: { status: "rejected", rejectionCode: req.signal.aborted ? "cancelled" : "processing_failed" },
            })
            .catch(() => {});
        }
        if (req.signal.aborted || isAbortError(error)) return;
        const failure = classifyModelError(error, "contribution");
        send({ type: "error", message: failure.message, code: failure.code });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: { ...SSE_HEADERS, ...NO_STORE } });
}
