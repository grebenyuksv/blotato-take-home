/**
 * Adapters own platform ID mapping and HTTP shape.
 * Callers pass the platform comment id of the comment being replied to;
 * where the reply lands (esp. IG collapsing onto the top-level comment)
 * is the platform's business, not ours.
 */

export type PublishReplyInput = {
  platformCommentId: string;
  text: string;
};

export type PublishReplySuccess = {
  ok: true;
  platformReplyId: string;
};

export type PublishReplyHttpError = {
  ok: false;
  kind: "http";
  status: number;
  message: string;
};

export type PublishReplyTimeout = {
  ok: false;
  kind: "timeout";
  message: string;
};

export type PublishReplyResult =
  | PublishReplySuccess
  | PublishReplyHttpError
  | PublishReplyTimeout;

export interface PlatformAdapter {
  publishReply(input: PublishReplyInput): Promise<PublishReplyResult>;
}
