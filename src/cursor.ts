/**
 * Opaque cursor for GET /comments. Sort key is (platform_created_at, id);
 * encoding the pair avoids skipping/duplicating when timestamps collide.
 */

export type CommentCursor = {
  platformCreatedAt: Date;
  id: string;
};

export function encodeCursor(cursor: CommentCursor): string {
  const payload = JSON.stringify({
    t: cursor.platformCreatedAt.toISOString(),
    id: cursor.id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string): CommentCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("cursor is not valid base64url JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { t?: unknown }).t !== "string" ||
    typeof (parsed as { id?: unknown }).id !== "string"
  ) {
    throw new InvalidCursorError("cursor payload has unexpected shape");
  }

  const t = (parsed as { t: string }).t;
  const id = (parsed as { id: string }).id;
  const platformCreatedAt = new Date(t);
  if (Number.isNaN(platformCreatedAt.getTime())) {
    throw new InvalidCursorError("cursor timestamp is invalid");
  }

  return { platformCreatedAt, id };
}

export class InvalidCursorError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}
