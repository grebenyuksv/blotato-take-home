import type { PlatformAdapter } from "./platform-adapter";
import {
  classifyPlatformOutcome,
  statusOnExhaustion,
} from "./platform-outcome";
import { transition } from "./reply-status";
import type { OutboundReply, OutboxRow, Platform, Post } from "./types";

export type OutboxEntry = {
  outbox: OutboxRow;
  reply: OutboundReply;
  post: Post;
  platformCommentId: string;
};

export type OutboxStore = {
  /**
   * Claim rows where reply.next_attempt_at <= now and
   * (claimed_at is null OR lease expired) and processed_at is null.
   */
  claimDue(workerId: string, limit: number, now: Date): Promise<OutboxEntry[]>;
  applyReplyUpdate(
    replyId: string,
    status: OutboundReply["status"],
    patch: Record<string, unknown>,
  ): Promise<void>;
  markOutboxProcessed(outboxId: string, now: Date): Promise<void>;
  releaseClaim(outboxId: string): Promise<void>;
};

export type AdapterRegistry = {
  get(platform: Platform): PlatformAdapter;
};

export type WorkerConfig = {
  workerId: string;
  maxAttempts: number;
  baseBackoffMs: number;
  batchSize: number;
};

/**
 * Lease outbox rows, publish via the platform adapter, update reply status.
 * processed_at is set only on a terminal outcome so a reply awaiting another
 * attempt stays claimable; a stale lease is reclaimed by another worker.
 */
export async function processOutboxBatch(
  store: OutboxStore,
  adapters: AdapterRegistry,
  config: WorkerConfig,
  now: Date = new Date(),
): Promise<void> {
  const batch = await store.claimDue(config.workerId, config.batchSize, now);

  for (const entry of batch) {
    await processOne(store, adapters, config, entry, now);
  }
}

async function processOne(
  store: OutboxStore,
  adapters: AdapterRegistry,
  config: WorkerConfig,
  entry: OutboxEntry,
  now: Date,
): Promise<void> {
  const { outbox, reply, post, platformCommentId } = entry;

  if (reply.status !== "pending") {
    await store.markOutboxProcessed(outbox.id, now);
    return;
  }

  if (now >= reply.deadlineAt || reply.retryCount >= config.maxAttempts) {
    const to = statusOnExhaustion(reply.inconclusiveAttempts);
    const event =
      to === "expired"
        ? { type: "expired" as const, lastError: reply.lastError ?? "attempt budget exhausted" }
        : { type: "failed" as const, lastError: reply.lastError ?? "attempt budget exhausted" };
    const t = transition(reply.status, event, now);
    await store.applyReplyUpdate(reply.id, t.to, t.patch);
    await store.markOutboxProcessed(outbox.id, now);
    return;
  }

  const adapter = adapters.get(post.platform);
  const result = await adapter.publishReply({
    platformCommentId,
    text: reply.text,
  });
  const outcome = classifyPlatformOutcome(result);

  if (outcome.action === "publish") {
    const t = transition(
      reply.status,
      { type: "published", platformReplyId: outcome.platformReplyId },
      now,
    );
    await store.applyReplyUpdate(reply.id, t.to, t.patch);
    await store.markOutboxProcessed(outbox.id, now);
    return;
  }

  if (outcome.action === "fail") {
    const t = transition(
      reply.status,
      { type: "failed", lastError: outcome.lastError },
      now,
    );
    await store.applyReplyUpdate(reply.id, t.to, t.patch);
    await store.markOutboxProcessed(outbox.id, now);
    return;
  }

  // retry (conclusive 429 or inconclusive 5xx/timeout)
  const retryCount = reply.retryCount + 1;
  const inconclusiveAttempts =
    reply.inconclusiveAttempts + (outcome.conclusive ? 0 : 1);
  const backoff = outcome.retryAfterMs ?? config.baseBackoffMs * 2 ** reply.retryCount;
  const nextAttemptAt = new Date(now.getTime() + backoff);

  const exhausted =
    retryCount >= config.maxAttempts || nextAttemptAt >= reply.deadlineAt;

  if (exhausted) {
    const to = statusOnExhaustion(inconclusiveAttempts);
    const event =
      to === "expired"
        ? { type: "expired" as const, lastError: outcome.lastError }
        : { type: "failed" as const, lastError: outcome.lastError };
    const t = transition(reply.status, event, now);
    await store.applyReplyUpdate(reply.id, t.to, {
      ...t.patch,
      retryCount,
      inconclusiveAttempts,
      nextAttemptAt,
    });
    await store.markOutboxProcessed(outbox.id, now);
    return;
  }

  await store.applyReplyUpdate(reply.id, "pending", {
    retryCount,
    inconclusiveAttempts,
    nextAttemptAt,
    lastError: outcome.lastError,
  });
  // Leave processed_at null so the row stays claimable after next_attempt_at.
  await store.releaseClaim(outbox.id);
}
