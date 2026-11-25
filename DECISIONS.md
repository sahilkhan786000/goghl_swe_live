# Decisions

Switchboard keeps MongoDB as the durable source of truth. Webhook deliveries
are inserted before acknowledgement and processed by lease-based workers;
replies are stored in the messages collection before sending, with Pigeon
idempotency keys reused for every retry. A Redis token bucket and workspace
cool-off coordinate sends across server instances. Workspace event history is
persisted with monotonic sequence numbers, while Redis Pub/Sub carries live
notifications. Reconnecting clients replay MongoDB history.

OIDC uses authorization-code PKCE, validates the ID token signature, issuer,
audience, expiry, and nonce, and stores sessions in Redis. Workspace IDs are
never treated as authorization by themselves; user access is checked against
the verified `workspaces` claim. New inbound activity reopens a closed
conversation. A new customer message starts unassigned.

Billing uses a Redis workspace lock and provider idempotency keys to prevent
duplicate customer/subscription creation. A `none` workspace is on trial and
may send; `incomplete` and `canceled` workspaces cannot send. `past_due` may
send during Paybox's retry window; the webhook refreshes current provider state
instead of trusting an event snapshot. Reducing seats does not remove agents;
Paybox applies the unused value as next-invoice credit. Seat limits are not
enforced against workspace membership.

Search indexes messages in optional Elasticsearch, with workspace filtering
applied in every query and existing messages backfilled on first search. An
unavailable search service returns 503 without affecting inbox delivery.
Private notes use a random AES-GCM key per note, wrapped to every registered
device using RSA-OAEP. The browser's non-extractable private key stays in
IndexedDB. Users must verify other devices' key fingerprints out-of-band;
unregistered devices cannot read earlier notes.

Focused server tests cover malformed session cookies, workspace-claim
allowlisting/authorization, raw-body webhook signature verification, and
encrypted-note recipient isolation. A malformed cookie is treated as an
unauthenticated request rather than causing an error response.
The public checker passed 75/75: Level 1 24/24, Level 2 14/14, Level 3 22/22,
and Level 5 15/15. Level 4 is private and was not available. Windows process
group cleanup in the supplied checker is POSIX-specific, so the complete
report was generated in a Linux Node 22 container without changing the
harness. The report predates billing, search, and private-note work; those
optional features have not been evaluated by the official grader. In
particular, billing renewal/retry and seat-change flows, browser key
enrollment, and Elasticsearch integration still need end-to-end validation.
The optional Elasticsearch service was not running for these checks. Level 4
remains unavailable, and native Windows cannot spawn the harness's required
POSIX `sh`.
