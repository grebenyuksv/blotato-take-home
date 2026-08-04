# Somewhat Interesting Edge Cases
1. The threading models are different for each platform: FB/IG differ on whether users reply to a comment or to the post.
1. External comment reply APIs (FB and IG) don't support idempotency.
1. Expecting idempotency keys from users (e.g. n8n users) is bad UX (honestly, I'm not familiar with the domain enough to judge, but AI says so).
1. Comments might get edited/deleted/moderated/etc. at any time since we ingest them.

# Standard Edge Cases
1. External APIs might not be available/return errors/be rate limited/etc.
1. Multiple "operators" might be trying to reply to the same comment at the same time.

# Solutions
1. Comment retrieval returns data from *our* storage without making external API calls. Ingestion is out of scope, but we assume this is how it's done. 3rd-party API rate limits are one reason why.
1. Unify the threading models. TODO link section explaining more.
1. Do not proactively handle cases when the comment we reply to has been edited/deleted/moderated/etc., at least within the scope of the take-home. TODO link section explaining more.
1. De-dup user intent using an internal idempotency definition without requiring idempotency keys from users. TODO link section explaining more.
1. Deliver-at-least-once when posting. TODO link section explaining more.