import type { PublishReplyResult } from "./platform-adapter";

/**
 * Conclusive = we know whether the reply was created on the platform.
 * That axis (not transient vs non-transient) drives retry / fail / expire.
 */
export type ClassifiedOutcome =
  | { action: "publish"; platformReplyId: string }
  | { action: "retry"; conclusive: true; lastError: string; retryAfterMs?: number }
  | { action: "fail"; lastError: string }
  | { action: "retry"; conclusive: false; lastError: string };

export function classifyPlatformOutcome(
  result: PublishReplyResult,
): ClassifiedOutcome {
  if (result.ok) {
    return { action: "publish", platformReplyId: result.platformReplyId };
  }

  if (result.kind === "timeout") {
    return {
      action: "retry",
      conclusive: false,
      lastError: result.message,
    };
  }

  const { status, message } = result;

  if (status === 429) {
    // Conclusive: reply was not created; safe to retry without duplicate risk.
    return {
      action: "retry",
      conclusive: true,
      lastError: message,
      retryAfterMs: undefined,
    };
  }

  if (status >= 500) {
    return {
      action: "retry",
      conclusive: false,
      lastError: message,
    };
  }

  // 400 / 403 / 404 and other non-transient client errors: conclusive failure.
  if (status >= 400 && status < 500) {
    return { action: "fail", lastError: message };
  }

  // Unexpected status: treat as inconclusive rather than inventing certainty.
  return {
    action: "retry",
    conclusive: false,
    lastError: message,
  };
}

export type ExhaustionStatus = "failed" | "expired";

/**
 * On budget exhaustion: expired if any attempt was inconclusive (reply may exist);
 * failed otherwise (nothing was created — e.g. only 429s).
 */
export function statusOnExhaustion(inconclusiveAttempts: number): ExhaustionStatus {
  return inconclusiveAttempts > 0 ? "expired" : "failed";
}
