import { ConflictError, isTerminal, transition } from "./reply-status";
import type { OutboundReply, OutboxRow } from "./types";

export type RetryOutboundReplyResult = {
  statusCode: 200;
  body: OutboundReply;
};

export type RetryOutboundReplyDeps = {
  findReply(id: string): Promise<OutboundReply | null>;
  /**
   * Reset attempt cycle + insert fresh outbox row in one transaction.
   * 409 if the reply is not terminal at apply time.
   */
  resetReplyAndEnqueue(args: {
    replyId: string;
    patch: {
      status: "pending";
      lastError: null;
      retryCount: number;
      inconclusiveAttempts: number;
      nextAttemptAt: Date;
      deadlineAt: Date;
    };
    outbox: Pick<OutboxRow, "id" | "replyId" | "createdAt">;
  }): Promise<OutboundReply>;
  newId(): string;
  now(): Date;
  attemptDeadlineMs: number;
};

/**
 * POST /outbound-replies/{id}/retry — terminal only.
 * pending: nothing to retry; published: nothing to fix → 409.
 */
export async function retryOutboundReply(
  deps: RetryOutboundReplyDeps,
  replyId: string,
): Promise<RetryOutboundReplyResult> {
  const reply = await deps.findReply(replyId);
  if (!reply) {
    throw new NotFoundError(`outbound reply ${replyId} not found`);
  }

  if (!isTerminal(reply.status)) {
    throw new ConflictError(
      reply.status === "pending"
        ? "cannot retry a pending reply"
        : "cannot retry a published reply",
    );
  }

  const now = deps.now();
  const t = transition(reply.status, { type: "retry" }, now, {
    nextAttemptAt: now,
    deadlineAt: new Date(now.getTime() + deps.attemptDeadlineMs),
  });

  const updated = await deps.resetReplyAndEnqueue({
    replyId,
    patch: {
      status: "pending",
      lastError: null,
      retryCount: t.patch.retryCount!,
      inconclusiveAttempts: t.patch.inconclusiveAttempts!,
      nextAttemptAt: t.patch.nextAttemptAt!,
      deadlineAt: t.patch.deadlineAt!,
    },
    outbox: {
      id: deps.newId(),
      replyId,
      createdAt: now,
    },
  });

  return { statusCode: 200, body: updated };
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
