# Somewhat Interesting Edge Cases
1. The threading models are different for each platform: FB/IG differ on whether users reply to a comment or to the post.
1. External comment reply APIs (FB and IG) don't support idempotency.
1. Expecting idempotency keys from users (e.g. n8n users) is bad UX (honestly, I'm not familiar with the domain enough to judge, but AI says so).
1. Comments might get edited/deleted/moderated/etc. at any time since we ingest them.

# Standard Edge Cases
1. External APIs might not be available/return errors/be rate limited/etc.
1. Multiple "operators" might be trying to reply to the same comment at the same time.

# Solutions
1. Comment retrieval returns data from *our* storage without making external API calls. Ingestion is out of scope, but we assume it's in place.
1. Unify the threading models. See [Unify Threading Models](#unify-threading-models) for more details.
1. De-dup user intent using an internal idempotency definition without requiring idempotency keys from users. See [De-dup User Intent](#de-dup-user-intent) for more details.
1. Deliver-at-least-once when posting. See [Deliver-at-least-once](#deliver-at-least-once) for more details.
1. Do not proactively handle cases when the comment we reply to has been edited/deleted/moderated/etc., at least within the scope of the take-home. See [Do Not Proactively Handle Edited/Deleted/Moderated Comments](#do-not-proactively-handle-edited-comments) for more details.

## <a id="unify-threading-models">Unify Threading Models</a>

## <a id="de-dup-user-intent">De-dup User Intent</a>

## <a id="deliver-at-least-once">Deliver-at-least-once</a>
It's clear what to do when posting to the external API clearly succeeds or fails:

| Status | Action |
|--------|--------|
| Success | Persist success. |
AI: Split 4xx errors separate rows and provide 1 example for each.
| 4xx errors | Fix and retry / Re-try with back-off / DLQ. |

What requires judgment is what to do in inconclusive cases like 5xx errors or timeouts.

### Suggested Approach: Just Re-Try
It must be for a reason that the third party APIs do not have idempotency keys. Duplicate responses are probably just not a big deal.

### Alternative: Read Before Re-Try
We could probably find a way to check whether our reply has already been posted in one API request before re-posting if external APIs support somewhat sophisticated filtering like `author=me&comment_id=<ID>&text=<TEXT>`. If choosing this approach, we must wait before re-trying because external APIs are eventually consistent (it seems so).

### Alternative: Check Ingested Data Before Re-Try
We could query our ingested data to see if the reply has already been posted. If choosing this approach, we must wait for the ingestion lag.

## <a id="edited-comments">Do Not Proactively Handle Edited/Deleted/Moderated Comments</a>