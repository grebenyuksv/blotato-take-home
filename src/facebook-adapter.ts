import type {
  PlatformAdapter,
  PublishReplyInput,
  PublishReplyResult,
} from "./platform-adapter";

type HttpClient = {
  post(
    path: string,
    body: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
};

/**
 * Facebook: POST /{comment_id}/comments
 * We name the comment being replied to; FB places the reply wherever FB places it.
 */
export function createFacebookAdapter(
  http: HttpClient,
  accessToken: string,
): PlatformAdapter {
  return {
    async publishReply(input: PublishReplyInput): Promise<PublishReplyResult> {
      try {
        const res = await http.post(`/${input.platformCommentId}/comments`, {
          message: input.text,
          access_token: accessToken,
        });

        if (res.status >= 200 && res.status < 300) {
          const id = (res.body as { id?: string }).id;
          if (!id) {
            return {
              ok: false,
              kind: "http",
              status: res.status,
              message: "success response missing id",
            };
          }
          return { ok: true, platformReplyId: id };
        }

        return {
          ok: false,
          kind: "http",
          status: res.status,
          message: String((res.body as { error?: { message?: string } })?.error?.message ?? res.body),
        };
      } catch (err) {
        if (isTimeout(err)) {
          return { ok: false, kind: "timeout", message: "request timed out" };
        }
        throw err;
      }
    },
  };
}

function isTimeout(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "ETIMEDOUT"
  );
}
