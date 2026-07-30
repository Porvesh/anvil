import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { CallSite } from "./models";

const TIMEOUT_MS: Record<CallSite, number> = {
  generation: 8 * 60_000,
  generationDesign: 8 * 60_000,
  generationReview: 8 * 60_000,
  generationFallback: 8 * 60_000,
  verifyGenerated: 90_000,
  judgeReview: 90_000,
  judgeDebug: 90_000,
  judgeDesign: 120_000,
  socratic: 60_000,
  hint: 45_000,
  jdMatch: 30_000,
};

const RETRIES: Record<CallSite, number> = {
  generation: 2,
  generationDesign: 2,
  generationReview: 2,
  generationFallback: 2,
  verifyGenerated: 2,
  judgeReview: 2,
  judgeDebug: 2,
  judgeDesign: 2,
  socratic: 1,
  hint: 1,
  jdMatch: 2,
};

/** Per-call policy. The SDK retries only connection errors, 408/409/429 and 5xx. */
export function modelRequestOptions(site: CallSite, signal?: AbortSignal) {
  return { timeout: TIMEOUT_MS[site], maxRetries: RETRIES[site], signal };
}

export type ModelErrorCode = "cancelled" | "timeout" | "busy" | "configuration" | "unavailable" | "failed";

export interface ModelErrorInfo {
  code: ModelErrorCode;
  message: string;
  retryable: boolean;
  status: number;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Anthropic.APIUserAbortError ||
    error instanceof OpenAI.APIUserAbortError ||
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** Convert provider/internal failures into stable, actionable public errors. */
export function classifyModelError(error: unknown, action: "grading" | "interviewer" | "matching" = "grading"): ModelErrorInfo {
  if (isAbortError(error)) {
    return { code: "cancelled", message: "Request cancelled.", retryable: false, status: 499 };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError || error instanceof OpenAI.APIConnectionTimeoutError) {
    return {
      code: "timeout",
      message: `${action === "interviewer" ? "The interviewer" : action === "matching" ? "Job matching" : "Grading"} took too long. Your work is safe; try again.`,
      retryable: true,
      status: 504,
    };
  }

  const status =
    error instanceof Anthropic.APIError || error instanceof OpenAI.APIError ? error.status : undefined;
  if (status === 429) {
    return { code: "busy", message: "The AI service is busy right now. Your work is safe; try again shortly.", retryable: true, status: 503 };
  }
  if (status === 401 || status === 403) {
    return { code: "configuration", message: "The AI service is not configured correctly.", retryable: false, status: 503 };
  }
  if (
    error instanceof Anthropic.APIConnectionError ||
    error instanceof OpenAI.APIConnectionError ||
    (typeof status === "number" && status >= 500)
  ) {
    return {
      code: "unavailable",
      message: "The AI service is temporarily unavailable. Your work is safe; try again.",
      retryable: true,
      status: 503,
    };
  }
  return {
    code: "failed",
    message: `We couldn't complete ${action}. Your work is safe; try again.`,
    retryable: false,
    status: 500,
  };
}
