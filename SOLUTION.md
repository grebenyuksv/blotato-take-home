# Scope
The solution supports FB and IG because that's what Blotato actually supports.

# Out of Scope
1. Data Ingestion;
2. Staleness checks;
3. Concurrent operators (not irrelevant per se, but I'm trying to minimize the scope of the take-home).

# Somewhat Interesting Edge Cases
1. The threading models are different for each platform: FB has replies-to-replies, unlike IG.
1. External comment reply APIs (FB and IG) don't support idempotency.
1. Expecting idempotency keys from users (e.g. n8n users) is bad UX (honestly, I'm not familiar with the domain enough to judge, but AI says so).
1. Comments might get edited/deleted/moderated/etc. at any time since we ingest them.

# Standard Edge Cases
1. External APIs might not be available/return errors/be rate limited/etc.

# Solutions
1. Comment retrieval returns data from *our* storage without making external API calls. Ingestion is out of scope, but we assume it's in place.
1. Unify the threading models focusing on our actual use cases rather than squeezing in things like infinite depth. See [Unify Threading Models](#unify-threading-models) for more details.
1. De-dup user intent using natural idempotency without requiring idempotency keys from users. See [De-dup User Intent](#de-dup-user-intent) for more details.
1. Deliver-at-least-once when posting. See [Deliver-at-least-once](#deliver-at-least-once) for more details.
1. Do not proactively handle cases when the comment we reply to has been edited/deleted/moderated/etc., at least within the scope of the take-home. See [Do Not Proactively Handle Edited/Deleted/Moderated Comments](#do-not-proactively-handle-edited-comments) for more details.

## <a id="unify-threading-models">Unify Threading Models</a>
This one is hard, so we must be strategic here. FB has replies-to-replies with infinite depth; on X, comments are posts; who knows what else is there in the wild.

My instinct is to store and present the data adapted to our actual use cases rather than precisely mirroring the original. When thinking about future support for other social media, my instinct is to invest in figuring out what is actually foreseeable, code for that, and drop the rest. Different social media, have their own adapters to our model. If, in the future, our adapter interface appears not flexible enough, we will redesign.

In production, I would take more time to explore what actually exists in the wild than the scope of the take-home allows, and document the unsupported models explicitly.

The assumed actual use cases to optimise for (I assume this should work well for both human and machine clients):
1. Show feed, supporting filtering for top-level comments only;
1. Lazy-load threads *flattened* (at least to see our own replies).

### Suggested Approach
`GET /comments?postId=<ID>&parentCommentId=<PARENT_COMMENT_ID>&cursor=<PREVIOUS_COMMENT_ID>`

Nullish `parentCommentId` means it's a top-level comment, non-nullish IDs point to top-level comments. Unwrap the recursion at ingestion.

TODO: POST by parentCommentId, translate in adapters e.g. IG would probably tag/quote/reply somehow

TODO: Decide on API schema without blocking worker.

TODO: Decide how to expose our pending replies.

TODO: DB schema.

### Alternative

### Discarded Alternative
Expose FB's infinite depth in the API and somehow figure our how to paginate.

## <a id="de-dup-user-intent">De-dup User Intent</a>

TODO: Answer with some simple definition of natural idempotency

## <a id="deliver-at-least-once">Deliver-at-least-once</a>
TODO: Answer with transaction outbox without handling potential duplicates in inconclusive cases.

It's clear what to do when posting to the external API clearly succeeds or fails:

| Status | Action |
|--------|--------|
| Success | Persist success. |
TODO: Split non-transient errors separate rows and provide 1 example for each.
| non-transient errors | Fix and retry / Re-try with back-off / DLQ. |

What requires judgment is what to do in inconclusive cases like 5xx errors or timeouts.

### Suggested Approach: Just Re-Try With Exponential Back-Off
It must be for a reason that the third party APIs do not have idempotency keys. Duplicate responses are probably just not a big deal.

### Possible Alternative: Read Before Posting When Re-Trying
We could probably find a way to check whether our reply has already been posted in one API request before re-posting if external APIs support somewhat sophisticated filtering like `author=me&comment_id=<ID>&text=<TEXT>`. If choosing this approach, we must wait before re-trying because external APIs are eventually consistent (it seems so).

### Possible Alternative: Check Ingested Data Before Posting When Re-Trying
We could query our ingested data to see if the reply has already been posted. If choosing this approach, we must wait for the ingestion lag.

## <a id="edited-comments">Do Not Proactively Handle Edited/Deleted/Moderated Comments</a>

TODO:
Suggested: Do not solve edited because it shouldn't be a big deal. Deleted and alike will fail naturally.
Possible alternative: Re-read from our storage before posting a reply. If choosing this approach, we must wait for the ingestion lag.
Discarded: All sorts of read-before-write. It's hard, and it doesn't solve the case when they edit the same moment we're posting.
Discarded: All sorts of reconciliation. It's hard, it consumes API quotas, and it might confuse users even more.