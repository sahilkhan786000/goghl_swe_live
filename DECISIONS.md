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

The current scope prioritizes the assessed inbox, reliable webhooks/replies,
and tenant isolation. Search, private notes, and billing are deliberately cut.
Level 1 passed 24/24; levels 2, 3, and 5 have not yet been verified. This is
not a claim that the full assessment is complete.
