import { createHash } from "node:crypto";
import type { OutboundReply } from "./types";

/** Trim + collapse internal whitespace so trivial client variance does not split intents. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Natural idempotency key: same target + same normalized text = same intent.
 * Permanent unique constraint; duplicates return the existing row (never revive).
 */
export function dedupeKey(targetCommentId: string, text: string): string {
  const payload = `${targetCommentId}\0${normalizeText(text)}`;
  return createHash("sha256").update(payload).digest("hex");
}

export type FindByDedupeKey = (
  key: string,
) => Promise<OutboundReply | null>;

/**
 * If an intent already exists, hand it back unchanged — including terminal rows.
 * Recovery is POST /outbound-replies/{id}/retry, not a side effect of create.
 */
export async function findExistingIntent(
  findByDedupeKey: FindByDedupeKey,
  targetCommentId: string,
  text: string,
): Promise<OutboundReply | null> {
  return findByDedupeKey(dedupeKey(targetCommentId, text));
}
