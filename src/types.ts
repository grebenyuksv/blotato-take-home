export type Platform = "facebook" | "instagram";

export type ReplyStatus = "pending" | "published" | "failed" | "expired";

export type Comment = {
  id: string;
  postId: string;
  platformCommentId: string;
  /** Null = top-level; non-null always points to a top-level comment. */
  parentCommentId: string | null;
  body: string;
  author: string;
  platformCreatedAt: Date;
  ingestedAt: Date;
};

export type OutboundReply = {
  id: string;
  postId: string;
  targetCommentId: string;
  text: string;
  status: ReplyStatus;
  platformReplyId: string | null;
  dedupeKey: string;
  retryCount: number;
  inconclusiveAttempts: number;
  nextAttemptAt: Date;
  deadlineAt: Date;
  lastError: string | null;
  createdAt: Date;
  publishedAt: Date | null;
};

export type OutboxRow = {
  id: string;
  replyId: string;
  createdAt: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  processedAt: Date | null;
};

export type Post = {
  id: string;
  platform: Platform;
  platformPostId: string;
};
