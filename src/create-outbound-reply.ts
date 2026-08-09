import { dedupeKey, findExistingIntent } from "./natural-idempotency";
import type { Comment, OutboundReply, OutboxRow } from "./types";

export type CreateOutboundReplyInput = {
  targetCommentId: string;
  text: string;
};

export type CreateOutboundReplyResult = {
  statusCode: 202;
  body: OutboundReply;
  /** True when we returned an existing row instead of inserting. */
  deduped: boolean;
};

export type CreateOutboundReplyDeps = {
  findComment(id: string): Promise<Comment | null>;
  findByDedupeKey(key: string): Promise<OutboundReply | null>;
  /**
   * Insert outbound_replies (pending) + outbox in one transaction.
   * Must respect UNIQUE(dedupe_key); on conflict, return the existing row.
   */
  insertReplyWithOutbox(args: {
    reply: Omit<
      OutboundReply,
      "platformReplyId" | "lastError" | "publishedAt"
    > & {
      platformReplyId: null;
      lastError: null;
      publishedAt: null;
    };
    outbox: Pick<OutboxRow, "id" | "replyId" | "createdAt">;
  }): Promise<{ reply: OutboundReply; inserted: boolean }>;
  newId(): string;
  now(): Date;
  attemptDeadlineMs: number;
};

/**
 * POST /outbound-replies — natural idempotency, then txn insert reply + outbox → 202.
 */
export async function createOutboundReply(
  deps: CreateOutboundReplyDeps,
  input: CreateOutboundReplyInput,
): Promise<CreateOutboundReplyResult> {
  const comment = await deps.findComment(input.targetCommentId);
  if (!comment) {
    throw new NotFoundError(`comment ${input.targetCommentId} not found`);
  }

  const existing = await findExistingIntent(
    deps.findByDedupeKey,
    input.targetCommentId,
    input.text,
  );
  if (existing) {
    return { statusCode: 202, body: existing, deduped: true };
  }

  const now = deps.now();
  const id = deps.newId();
  const key = dedupeKey(input.targetCommentId, input.text);

  const reply: OutboundReply = {
    id,
    postId: comment.postId,
    targetCommentId: input.targetCommentId,
    text: input.text,
    status: "pending",
    platformReplyId: null,
    dedupeKey: key,
    retryCount: 0,
    inconclusiveAttempts: 0,
    nextAttemptAt: now,
    deadlineAt: new Date(now.getTime() + deps.attemptDeadlineMs),
    lastError: null,
    createdAt: now,
    publishedAt: null,
  };

  const { reply: saved, inserted } = await deps.insertReplyWithOutbox({
    reply,
    outbox: {
      id: deps.newId(),
      replyId: id,
      createdAt: now,
    },
  });

  return { statusCode: 202, body: saved, deduped: !inserted };
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
