import type { ReplyStatus } from "./types";

export type TerminalStatus = Extract<ReplyStatus, "failed" | "expired">;

const TERMINAL: ReadonlySet<ReplyStatus> = new Set(["failed", "expired"]);

export function isTerminal(status: ReplyStatus): status is TerminalStatus {
  return TERMINAL.has(status);
}

export type StatusEvent =
  | { type: "published"; platformReplyId: string }
  | { type: "failed"; lastError: string }
  | { type: "expired"; lastError: string }
  | { type: "retry" };

export type StatusTransition = {
  from: ReplyStatus;
  to: ReplyStatus;
  patch: {
    platformReplyId?: string;
    lastError?: string | null;
    publishedAt?: Date;
    retryCount?: number;
    inconclusiveAttempts?: number;
    nextAttemptAt?: Date;
    deadlineAt?: Date;
  };
};

/**
 * Typed transitions for the current attempt cycle.
 * pending → published | failed | expired; failed|expired → pending via /retry.
 */
export function transition(
  from: ReplyStatus,
  event: StatusEvent,
  now: Date,
  retryDefaults?: { nextAttemptAt: Date; deadlineAt: Date },
): StatusTransition {
  switch (event.type) {
    case "published":
      assertFrom(from, "pending", event.type);
      return {
        from,
        to: "published",
        patch: {
          platformReplyId: event.platformReplyId,
          lastError: null,
          publishedAt: now,
        },
      };
    case "failed":
      assertFrom(from, "pending", event.type);
      return {
        from,
        to: "failed",
        patch: { lastError: event.lastError },
      };
    case "expired":
      assertFrom(from, "pending", event.type);
      return {
        from,
        to: "expired",
        patch: { lastError: event.lastError },
      };
    case "retry":
      if (!isTerminal(from)) {
        throw new ConflictError(`cannot retry from status ${from}`);
      }
      if (!retryDefaults) {
        throw new Error("retryDefaults required for retry transition");
      }
      return {
        from,
        to: "pending",
        patch: {
          lastError: null,
          retryCount: 0,
          inconclusiveAttempts: 0,
          nextAttemptAt: retryDefaults.nextAttemptAt,
          deadlineAt: retryDefaults.deadlineAt,
        },
      };
  }
}

function assertFrom(
  from: ReplyStatus,
  expected: ReplyStatus,
  event: string,
): void {
  if (from !== expected) {
    throw new ConflictError(`cannot apply ${event} from status ${from}`);
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
