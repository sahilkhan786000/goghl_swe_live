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
The public checker passed 75/75: Level 1 24/24, Level 2 14/14, Level 3 22/22,
and Level 5 15/15. Level 4 is private and was not available. Windows process
group cleanup in the supplied checker is POSIX-specific, so the complete
report was generated in a Linux Node 22 container without changing the
harness. Private notes, search, billing, and the hidden Level 4 rules remain
unimplemented or unverified.
