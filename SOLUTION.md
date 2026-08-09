# Scope
The solution supports FB and IG because that's what Blotato actually supports.

# Out of Scope
1. Data Ingestion;
1. Staleness checks;
1. Concurrent operators (not irrelevant per se, but I'm trying to minimize the scope of the take-home).
1. Authorization and authentication (not the most interesting aspect compared to the rest, again, just minimizing the scope).

# Somewhat Interesting Edge Cases
1. The threading models are different for each platform: FB threads nest deeper than one level, unlike IG.
1. External comment reply APIs (FB and IG) don't support idempotency.
1. Expecting idempotency keys from users (e.g. n8n users) is bad UX (honestly, I'm not familiar with the domain enough to judge, but AI says so).
1. Comments might get edited/deleted/moderated/etc. at any time since we ingest them.

# Standard Edge Cases
1. External APIs might not be available/return errors/be rate limited/etc.

# Solutions
1. Comment retrieval returns data from *our* storage without making external API calls. Ingestion is out of scope, but we assume it's in place.
1. Unify the threading models focusing on our actual use cases rather than squeezing in things like arbitrary nesting depth. See [Unify Threading Models](#unify-threading-models) for more details.
1. De-dup user intent using natural idempotency without requiring idempotency keys from users. See [De-dup User Intent](#de-dup-user-intent) for more details.
1. Deliver-at-least-once when posting. See [Deliver-at-least-once](#deliver-at-least-once) for more details.
1. Do not proactively handle cases when the comment we reply to has been edited/deleted/moderated/etc., at least within the scope of the take-home. See [Do Not Proactively Handle Edited/Deleted/Moderated Comments](#edited-comments) for more details.

## <a id="unify-threading-models">Unify Threading Models</a>
This one is hard, so we must be strategic here. FB's UI nests reply chains more than one level deep; on X, comments are posts; who knows what else is there in the wild.

The biggest reason we sacrifice depth is simply that our user experience does not need it. Our users are answering their audience, not reading a Reddit thread: they want to see what was said and reply to it. Nothing in the use cases below asks "who replied to whom, three levels down". Depth is real data we are choosing not to model because modelling it would cost us a recursive schema, recursive pagination, and a recursive adapter contract, and buy our users nothing.

The platforms make that easy to accept. IG documents a single level outright: you can only reply to a top-level comment, and a reply aimed at a reply gets attached to the top-level comment anyway. FB is harder to pin down. Its reads clearly nest, but whether a reply posted against a nested comment reliably lands where you aimed it is not something I could establish with confidence — the documentation does not say, and what evidence exists is old and unconfirmed. I would rather not put a behaviour I cannot verify underneath our schema, particularly one we do not need.

So we flatten to two levels at ingestion: top-level comments, and everything beneath them collapsed onto their top-level ancestor. Depth on FB reads is the whole of what we give up.

My instinct is to store and present the data adapted to our actual use cases rather than precisely mirroring the original. When thinking about future support for other social media, my instinct is to invest in figuring out what is actually foreseeable, code for that, and drop the rest. Different social media have their own adapters to our model. If, in the future, our adapter interface appears not flexible enough, we will redesign.

In production, I would take more time to explore what actually exists in the wild than the scope of the take-home allows, and document the unsupported models explicitly.

The assumed actual use cases to optimise for (I assume this should work well for both human and machine clients):
1. Show feed, supporting filtering for top-level comments only;
1. Lazy-load threads *flattened* (platform comments only);
1. Create/list/poll/retry *our* reply jobs (with statuses), separately from the feed.

### Suggested Approach
Two root collections, deliberately not nested in each other: `/comments` is what the platform told us, `/outbound-replies` is what we are trying to tell the platform. They have different lifecycles, different freshness guarantees, and only one of them has a status.

**Reading comments.** `GET /comments?postId=<ID>&parentCommentId=<ID>&cursor=<CURSOR>`

Omitting `parentCommentId` returns top-level comments only; passing one returns that comment's flattened thread. There is no "every comment on the post, flat" mode — we don't have a use case for it, and leaving it out keeps the parameter's meaning unambiguous in a query string, where "absent" and "explicitly null" are otherwise indistinguishable. `parentCommentId` always names a top-level comment, because ingestion unwraps deeper FB chains onto their top-level ancestor.

**Replying.** `POST /outbound-replies` with `{ "targetCommentId": "<ID>", "text": "..." }`

`targetCommentId` is any comment we hold, at either level. It is deliberately not called `parentCommentId`: on `/comments` that parameter names a thread, whereas here we are naming the comment being replied to, and tree position is irrelevant to the operation.

Adapters translate the target into the platform call: both FB (`POST /{comment_id}/comments`) and IG (`POST /{ig_comment_id}/replies`) take the platform id of the comment being replied to. Depth is not our concern on the write path — we name a comment, and the adapter owns what that means on its platform. IG attaches the reply to the top-level comment by documented design; FB places it wherever FB places it. Either way the platform decides where the reply lands, we do not model it, and if that behaviour differs between platforms or changes later, nothing about our schema or API moves. That is the whole point of having adapters.

Code: [`src/platform-adapter.ts`](src/platform-adapter.ts), [`src/facebook-adapter.ts`](src/facebook-adapter.ts), [`src/instagram-adapter.ts`](src/instagram-adapter.ts) (shared shapes in [`src/types.ts`](src/types.ts)).

API IDs are ours; adapters map to platform IDs at publish time.

Replying is async: `202 Accepted` with `{ "id", "status": "pending", ... }`. A worker publishes via the outbox (see below).

**Tracking replies.** `GET /outbound-replies/{id}` to poll one, `GET /outbound-replies?postId=<ID>` to list them. Status is one of `pending`, `published`, `failed` or `expired`. Transitions: [`src/reply-status.ts`](src/reply-status.ts).

**Retrying.** `POST /outbound-replies/{id}/retry` puts a terminal reply back to `pending`, clearing `last_error` and resetting the attempt cycle (`retry_count`, `inconclusive_attempts`, `next_attempt_at`, `deadline_at`) and inserting a fresh outbox row, all in one transaction. `409 Conflict` if the reply is not terminal: `pending` has nothing to retry and `published` has nothing to fix. Code: [`src/retry-outbound-reply.ts`](src/retry-outbound-reply.ts), transitions in [`src/reply-status.ts`](src/reply-status.ts).

Our replies never appear in `GET /comments`. Once published, a reply comes back through ingestion as an ordinary platform comment, so merging the two collections server-side would mean either double-showing it or writing a suppression rule keyed on `platform_reply_id`. A client that wants to show its reply before ingestion catches up already holds the `id` from the `202`, so it renders and polls that one reply on its own; it does not need the two collections to be queryable along the same axis. The benefit is that `/comments` keeps a single, honest meaning and a reply job stays a job.

### DB Schema
```
posts(id, platform, platform_post_id)
  -- UNIQUE(platform, platform_post_id)

comments(id, post_id, platform_comment_id, parent_comment_id, body, author,
         platform_created_at, ingested_at)
  -- parent_comment_id NULL = top-level; non-null always points to a top-level comment
  -- UNIQUE(post_id, platform_comment_id) so re-ingesting a comment is idempotent
  -- INDEX(post_id, parent_comment_id, platform_created_at, id) to serve the feed query
  -- platform_created_at, not ingested_at, is the sort key: ingestion order is not
  --   comment order, and a backfill would otherwise scramble the feed

outbound_replies(id, post_id, target_comment_id, text, status, platform_reply_id,
                 dedupe_key UNIQUE, retry_count, inconclusive_attempts,
                 next_attempt_at, deadline_at, last_error, created_at, published_at)
  -- status: pending | published | failed | expired
  -- next_attempt_at makes exponential backoff schedulable;
  --   deadline_at bounds the whole cycle in wall-clock time
  -- inconclusive_attempts decides failed vs expired on exhaustion: a cycle that
  --   spent its whole budget on conclusive errors created nothing
  -- retry_count, inconclusive_attempts, next_attempt_at, deadline_at and last_error
  --   describe the *current* attempt cycle; /retry resets them
  -- target_comment_id is the comment we are replying to, at either level; where the
  --   reply actually lands is the platform's business, not ours
  -- post_id is denormalized off target_comment_id purely to serve the list filter

outbox(id, reply_id, created_at, claimed_at, claimed_by, processed_at)
  -- a claim older than the lease window is reclaimable, so a worker that dies
  --   mid-flight doesn't wedge the reply in pending forever
```

Cursor pagination sorts on `(platform_created_at, id)`; the opaque `cursor` encodes that pair rather than a bare comment id, since `platform_created_at` is not unique. Code: [`src/cursor.ts`](src/cursor.ts).

### Discarded Alternative
Expose FB's full nesting depth in the API and somehow figure out how to paginate it. Discarded first because no use case of ours reads that depth, and only second because we could not write into it anyway.

## <a id="de-dup-user-intent">De-dup User Intent</a>

**Natural idempotency**: derive `dedupe_key = hash(target_comment_id, normalized_text)` server-side. Unique constraint on `dedupe_key`; a duplicate POST returns the existing reply (same `id`, current `status`) instead of creating a new row. Automation clients can retry on timeout without supplying headers. The target comment determines the post, so `post_id` would add nothing to the hash. Code: [`src/natural-idempotency.ts`](src/natural-idempotency.ts); create path in [`src/create-outbound-reply.ts`](src/create-outbound-reply.ts).

Keying on the target rather than on its thread is what keeps two genuinely different intents apart: "Thanks!" aimed at one commenter and "Thanks!" aimed at another are two replies even on IG, where both will surface under the same top-level comment.

Multiple distinct replies to the same comment are allowed when the text differs. The deliberate trade-off is the reverse case: the same text can never be sent to the same comment twice. That is the behaviour we want — a retrying n8n workflow is far more likely than someone genuinely wanting to say "Thanks!" twice under one comment.

The constraint is permanent, not windowed, which means a POST can never revive a reply that ended `failed` or `expired` — it just hands back the old row. Recovery is therefore an explicit `POST /outbound-replies/{id}/retry` rather than an overloaded POST. One intent stays one resource with one id and one history, which is exactly what a permanent dedupe key is asserting, and the state transition is a named action instead of a surprising side effect of a create call.

### Discarded Alternative
Let a duplicate POST revive a terminal row. Tempting, because clients that blindly re-send would self-heal with no new endpoint. Discarded because POST would then sometimes create and sometimes mutate depending on invisible server state, and a client looping on a permanently doomed reply would silently re-queue it forever.

## <a id="deliver-at-least-once">Deliver-at-least-once</a>

On `POST`, insert `outbound_replies` (`pending`) + `outbox` row in one transaction; return `202` immediately. A worker leases outbox rows whose `next_attempt_at` has passed, calls the platform adapter, and updates the reply's status. The outbox row is marked `processed_at` only on a terminal outcome, so a reply awaiting another attempt stays claimable, and a lease that goes stale is reclaimed by another worker. Code: [`src/create-outbound-reply.ts`](src/create-outbound-reply.ts), [`src/outbox-worker.ts`](src/outbox-worker.ts), [`src/reply-status.ts`](src/reply-status.ts).

`pending` must never be permanent, or clients poll forever. Two independent things can make it permanent, and both are closed off: a worker dying mid-flight (handled by the lease expiring) and retrying without end (handled by the budget below).

The axis that matters is not transient vs non-transient but whether the outcome is *conclusive* — i.e. whether we know if the reply was created:

| Outcome | Example | Conclusive? | Action |
|---------|---------|-------------|--------|
| Success | 200 + platform reply id | Yes | `published`, store `platform_reply_id` |
| Rate limited | 429 | Yes — the reply was not created | Retry after backoff, no duplicate risk |
| Non-transient | 404 comment not found or deleted | Yes | `failed`, no automatic retry |
| Non-transient | 403 insufficient permissions | Yes | `failed`, no automatic retry |
| Non-transient | 400 text too long, or replying to a hidden IG comment | Yes | `failed`, no automatic retry |
| Inconclusive | 5xx, timeout | No — the reply may or may not exist | See below |

Classifier: [`src/platform-outcome.ts`](src/platform-outcome.ts).

Everything above except the last row is mechanical. What requires judgment is the inconclusive row.

### Suggested Approach: Just Re-Try With Exponential Back-Off
Retry, and accept that the platform may end up with a duplicate reply. It must be for a reason that the third party APIs do not have idempotency keys — duplicate replies are probably just not a big deal, and they are certainly less bad than a reply that silently never appears.

Retrying is bounded twice, by attempt count and by `deadline_at` in wall clock, whichever comes first. Wall clock matters on its own because a reply that lands three days late is arguably worse than one that never lands.

On exhaustion the reply becomes `expired` if any attempt in the cycle was inconclusive, and `failed` otherwise. The two carry different information: `failed` means nothing was created, while `expired` means we never got a conclusive answer and a reply *may* exist on the platform. That is the one thing a human needs in order to decide whether to go and look before hitting `/retry`, which is why exhaustion on its own must not decide it — a reply that burned its whole budget on 429s was never created, and marking it `expired` would send someone hunting for a reply that cannot be there. Hence `inconclusive_attempts` on the row.

The table above covers what the platform told us, not what happened to the worker. A worker that dies after the platform accepted the reply but before it writes `published` is a third inconclusive path, and as specified it is invisible: the lease expires, another worker retries, the second call succeeds, and the reply ends `published` with a duplicate on the platform that nothing recorded. I assumed that is acceptable, for the same reason as the duplicates above. If the business needs a stricter guarantee, write an in-flight marker before the platform call so a reclaimed row is known to have been mid-call and counts as an inconclusive attempt. It costs one extra write per attempt and converts silent duplicates into `expired` replies a human can check.

### Possible Alternative: Read Before Posting When Re-Trying
We could probably find a way to check whether our reply has already been posted in one API request before re-posting if external APIs support somewhat sophisticated filtering like `author=me&comment_id=<ID>&text=<TEXT>`. If choosing this approach, we must wait before re-trying because external APIs are eventually consistent (it seems so).

### Possible Alternative: Check Ingested Data Before Posting When Re-Trying
We could query our ingested data to see if the reply has already been posted. If choosing this approach, we must wait for the ingestion lag.

## <a id="edited-comments">Do Not Proactively Handle Edited/Deleted/Moderated Comments</a>

Attempt publish as-is; no pre-flight sync with the platform or our storage. Edited comment text on the platform is irrelevant to our reply. Deleted and hidden comments fail at the platform with a conclusive error, so the reply is marked `failed` with `last_error` surfaced to the client — IG documents that replying to a hidden comment is rejected, and a deleted comment 404s on both platforms. In other words, the platform is already the authority we would otherwise be trying to duplicate.

Possible alternative: Re-read from our storage before posting a reply. If choosing this approach, we must wait for the ingestion lag.

Discarded: All sorts of read-before-write against the platform. It's hard, and it doesn't solve the case when they edit the same moment we're posting.

Discarded: All sorts of reconciliation. It's hard, it consumes API quotas, and it might confuse users even more.
