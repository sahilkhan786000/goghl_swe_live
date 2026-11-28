# Switchboard Live-Coding Assignment — Interview Preparation

This guide summarizes the assignment, the implementation in this repository,
the reasoning behind the main design choices, AI-assisted work, validation
evidence, and the remaining gaps. It is a study aid: explain the design in
your own words and be candid about features that have not had end-to-end
validation.

## 1. What the assignment asked for

Switchboard is a multi-tenant support inbox. Simulated customers send messages
through Pigeon; authenticated support agents need to receive them, work
conversations, reply, and see updates live. More than one business uses the
same deployment, so one workspace must never read another workspace's data.

The brief explicitly prioritized reliability and tenant safety over feature
count. It supplied Pigeon and OpenID Connect simulators, MongoDB, Redis, and
an optional Elasticsearch service. Paybox is a simulated payment provider
for a separate 10-point billing bonus. The detailed source contracts are
in [BRIEF.md](./BRIEF.md), [PIGEON.md](./PIGEON.md),
[PAYBOX.md](./PAYBOX.md), and [BONUS_BILLING.md](./BONUS_BILLING.md).

### Assessment levels and rubric

| Area | Points | What it exercises |
|---|---:|---|
| Level 1 | 24 | Duplicated, forged, stale, and out-of-order webhooks; provider rate limiting/outages; concurrent claims |
| Level 2 | 14 | Process crashes during webhook floods and accepted replies |
| Level 3 | 22 | Multiple server instances sharing MongoDB and Redis; rate limits and failover |
| Level 4 | 10 | Private written edge cases; not in the supplied runnable checker |
| Level 5 | 15 | OIDC login, workspace authorization, and authenticated live/replay WebSockets |
| Security review | 4 | Sessions, secrets, and encrypted notes if attempted |
| Design/code/tests | 5 | Data model, structure, code quality, targeted tests |
| Frontend/design choices | 3 | Usability and rationale for scope |
| AI workflow | 3 | Evidence in `ai-logs/` |
| Billing bonus | 10 | Paybox per-seat subscriptions and lifecycle handling |

The checked-in [CHECK_REPORT.json](./CHECK_REPORT.json) records **75/75** for
the public runnable levels (1, 2, 3, and 5). It predates the later billing,
search, and encrypted-note additions; it does not certify those additions or
Level 4.

## 2. Short project summary

The core service is a TypeScript/Express application backed by MongoDB and
Redis, with a React inbox. MongoDB is the durable source of truth for
conversations, messages, webhook receipts, worker leases, and sequenced
workspace events. Redis coordinates sessions, distributed rate limiting,
short-lived locks, and cross-instance WebSocket notifications. The app
verifies provider webhooks, persists work before acknowledging them, and uses
an outbox plus Pigeon idempotency keys so retries and restarts do not create
duplicate replies.

The implementation also includes Paybox billing, workspace-scoped
Elasticsearch search, and browser-encrypted private notes. Their current
validation limits are listed in section 8.

## 3. Architecture and data flows

### Inbound message

1. Pigeon sends `POST /webhooks/pigeon` with a timestamped HMAC signature and
   the raw JSON body.
2. The server verifies the signature against the raw bytes, using a
   constant-time comparison, and rejects signatures older than five minutes.
3. It validates the event enough to decide whether to process, ignore, or
   reject it. Unknown event types/workspaces and irrelevant statuses are
   acknowledged and ignored as required by the provider contract.
4. It inserts the webhook event into MongoDB with a unique event ID before
   returning 2xx. A duplicate delivery is harmless.
5. A worker claims stored events using a MongoDB lease, writes the inbound
   message and conversation, and publishes a sequenced workspace event.
6. WebSocket clients on any instance receive the update through Redis Pub/Sub.

The durable receipt is separate from asynchronous processing so Pigeon does
not need to wait for database-independent UI or search work. The core rule is:
**never acknowledge a valid event until it is safely stored**.

### Outbound reply

1. The authenticated API or grader endpoint validates workspace/contact/text
   and calls the same queue path.
2. The reply is inserted into the MongoDB message collection as `queued`
   before the API returns `202`.
3. A worker atomically claims queued or expired-lease messages and sends them
   to Pigeon with `client_ref` as the provider idempotency key.
4. A 429 stores the provider's `Retry-After` delay in Redis; 5xx and network
   failures are retried with bounded exponential delay.
5. Provider status webhooks update the saved message monotonically and publish
   a WebSocket event.

The timeout and lease are deliberately different: the outbound HTTP timeout
is shorter than the worker lease. If the process dies after Pigeon accepted a
request but before the response is recorded, a later retry uses the same
idempotency key. This is how the design handles an ambiguous network outcome;
it does not assume a timed-out request was rejected.

### Login and tenant isolation

The login flow uses OIDC authorization-code with PKCE. The server stores
OAuth state, verifier, and nonce in Redis with a short TTL; it validates the
returned ID-token signature, issuer, audience, expiry, and nonce. It then
stores an opaque session identifier in Redis and sends it in an HttpOnly,
SameSite=Lax cookie (Secure when the request is HTTPS).

Workspace memberships and roles come from the verified token claim. API
handlers check membership before workspace data access. Billing routes
additionally require the admin role. WebSocket upgrades perform the same
session and membership checks. See [auth.ts](./scaffold/server/src/auth.ts)
and the route setup in [index.ts](./scaffold/server/src/index.ts).

### Claims and real-time events

Conversation claims use a MongoDB conditional update that succeeds only when
the assignee is empty or already the requesting agent. The database operation
is the concurrency boundary; a client-side check would allow two agents to
win at once.

Each workspace has a durable monotonically increasing event sequence in
MongoDB. Redis Pub/Sub broadcasts new events between server instances. On
reconnect, a client supplies its last sequence; the server replays newer
MongoDB events, buffers live events while replay is happening, then drains
that buffer in sequence order. This avoids a replay/live race and lets
clients recover events missed while disconnected.

### Main data collections

| Collection | Purpose |
|---|---|
| `conversations` | Workspace/contact state, assignee, status, activity time |
| `messages` | Inbound messages and durable outbound queue/status |
| `webhook_events` | Durable, deduplicated Pigeon event receipts and worker leases |
| `workspace_events` | Durable ordered feed for WebSocket replay |
| `counters` | Per-workspace event sequence allocation |
| `workspace_billing` | Current Paybox customer/subscription state |
| `private_notes` | Note ciphertext and per-device wrapped content keys |
| `workspace_note_keys` | Public device keys only |

Unique and compound indexes encode important invariants, such as a single
conversation per workspace/contact, unique provider message IDs, unique
client references, and unique workspace event sequence numbers.

## 4. What was built and why

### Core assessment implementation

- **Pigeon webhook validation:** raw-body HMAC-SHA256, timestamp freshness,
  bounded request size, and explicit handling for malformed JSON, unknown
  event types, unknown workspaces, and unknown status references.
- **Durable inbound processing:** webhook receipt saved before ACK; workers
  use leases so another instance can reclaim work after a crash.
- **Exactly-once effect for outbound sends:** durable outbox plus stable
  provider idempotency key. The realistic guarantee is at-least-once attempts
  with idempotent provider effect, not magical exactly-once networking.
- **Out-of-order status protection:** status precedence and provider event
  timestamps prevent an older `sent` update from replacing a newer final
  status.
- **Distributed rate limiting:** Redis Lua token bucket is atomic across
  processes; a workspace-specific cooldown enforces `Retry-After`.
- **Atomic claims:** MongoDB conditional update prevents two agents from
  simultaneously becoming assignee.
- **OIDC and sessions:** PKCE/state/nonce, token verification, Redis sessions,
  role/membership checks.
- **Inbox and WebSockets:** workspace selector, open/closed views, conversation
  detail, claim, close/reopen, reply, status, reconnect, event replay, and
  mobile list/detail navigation.

### Later additions

- **Paybox:** admin-only billing UI; browser sends card data to Paybox's
  publishable-key token endpoint, and only the resulting token reaches the
  Switchboard server. A Redis workspace lock and Paybox idempotency keys guard
  concurrent subscription requests. Signed webhooks trigger a fetch of
  Paybox's current subscription state instead of trusting an old event
  snapshot. `none` is a trial; `incomplete` and `canceled` block sends;
  `past_due` remains send-enabled during Paybox's retry window.
- **Search:** optional Elasticsearch index and UI. Queries include an explicit
  workspace term filter; existing messages are backfilled on first search.
  Elasticsearch failure does not stop inbox writes and returns a search
  unavailable response.
- **Private notes:** the browser encrypts note text with a fresh AES-256-GCM
  key and wraps that key for registered device public keys using RSA-OAEP.
  Private keys stay in IndexedDB. Users must verify device fingerprints
  out-of-band. The server stores ciphertext and public keys, not plaintext or
  private keys. Full details and limitations are in [PROTOCOL.md](./PROTOCOL.md).

### Important design decisions

| Decision | Reason | Trade-off |
|---|---|---|
| MongoDB for durable data | Unique indexes and atomic updates directly support deduplication, claims, leases, and replay | More responsibility for indexes and query shape |
| Redis for coordination | Shared state across app instances for sessions, rate limits, Pub/Sub, and locks | Redis is a runtime dependency for these flows |
| Persist-before-ack | Prevents loss when Pigeon retries only a limited number of times | Adds a database write to webhook acknowledgement |
| Provider idempotency key | Handles accepted-but-timed-out provider calls safely | Depends on the provider honoring its contract |
| `past_due` grace | Keep service available while Paybox performs its scheduled retries | Must be revisited for a real commercial policy |
| Seat reductions do not evict users | Billing quantity is not an identity/authorization mechanism | Seat limits are not enforced against membership |
| Browser-side E2EE | Server should not be able to read private note contents | Lost browser key means permanent data loss; new devices cannot decrypt old notes |
| Search remains optional | Elasticsearch is optional and memory-heavy in the supplied environment | Search is unavailable until the service is started |

The written trade-offs are also recorded in [DECISIONS.md](./DECISIONS.md).

## 5. AI-assisted development: what happened

The AI coding assistant was used as an engineering tool in the VS Code
workflow. The user set the target repository, supplied the assignment
context, clarified that the starter should be analyzed first, directed
incremental GitHub commits, and supplied/exported the AI chat transcript.
The assistant helped inspect the starter and service contracts, implement the
server and frontend, run focused checks, investigate environment failures,
update documentation, and prepare the final commit.

The repository includes the exported conversation at
[ai-logs/chat.json](./ai-logs/chat.json). Do not claim that the assistant's
output was automatically correct: tests exposed issues, and the final author
is responsible for understanding and defending the code. A good interview
description is:

> “I used Copilot as a coding and investigation assistant. I directed the
> scope, reviewed the architecture and diffs, and ran the checks. I can
> explain the durable webhook/outbox design, tenant checks, and the parts
> that still need more validation. The transcript is included in the repo.”

Do not claim to have personally typed every line if that is not true. The
strongest demonstration of ownership is to explain a failure mode, locate
the relevant code, and change or debug it in the interview.

### Development milestones

The repository history records the main milestones:

- `4da13a6` — core resilient inbox implementation.
- `7709f1d` — public checker report.
- `d229092` / `bd5f0c4` — chat export and remote README merge.
- `13755ae` — authentication-boundary tests and malformed-cookie hardening.
- `5e5354b` — billing, search, encrypted notes, protocol, and status updates.

Use the live GitHub history if an interviewer asks for exact changes per
commit.

## 6. A 60-second introduction

> “I built Switchboard, a multi-tenant support inbox, around reliability
> boundaries rather than just the happy-path UI. Inbound webhooks are
> signature-checked and stored before acknowledgement. Replies are persisted
> in an outbox and sent with stable idempotency keys, with Redis coordinating
> rate limits and MongoDB leases allowing another worker to recover after a
> process crash. OIDC sessions and workspace claims guard both HTTP and
> WebSocket access, while sequenced MongoDB events support reconnect replay.
> I also added Paybox billing, workspace-filtered search, and client-encrypted
> notes. The public core checker previously passed 75/75; those later optional
> features still need end-to-end validation, and I can explain those gaps.”

Keep the pitch in your own voice. If asked, immediately qualify that the
75/75 report predates the optional features.

## 7. Likely interview questions and answer points

### “How do you prevent losing an inbound webhook?”

Verify the signature over the exact raw body, then insert the event with a
unique event ID into MongoDB before returning 2xx. A worker processes the
persisted event later. If the server is down before persistence, Pigeon gets
a non-2xx/timeout and retries; if the same event arrives again, the unique
key deduplicates it.

### “Can you guarantee exactly-once delivery?”

Not at the network layer. A process can time out after the provider accepted
the request. The app persists the outbound intent and reuses the same
`client_ref` as the provider's idempotency key. That gives repeatable
attempts with one provider-side effect, assuming Pigeon honors idempotency.

### “Why do you need both MongoDB and Redis?”

MongoDB is the durable source of truth for business records, deduplication,
leases, and replay history. Redis is used for shared, fast coordination:
sessions, rate-limit token buckets/cooldowns, Pub/Sub, and short-lived locks.
Pub/Sub is not treated as durable event history; the MongoDB sequence log is
the replay source.

### “How do workers recover after a process dies?”

Workers claim eligible records with an atomic conditional update and set an
owner plus lease expiry. A process crash does not permanently own a record;
another process can claim it after expiry. Provider idempotency protects
outbound requests that may have succeeded before the crash.

### “How do you handle provider rate limits across multiple instances?”

The Redis Lua script refills and consumes a workspace token bucket atomically.
The `Retry-After` response also creates a shared workspace cooldown. Keeping
both keyed by workspace means instances do not each get an independent quota.

### “Why store event sequence numbers in MongoDB?”

WebSockets can disconnect and Redis Pub/Sub can be missed while a client is
offline. A durable per-workspace sequence lets a reconnecting client ask for
all events after its last seen sequence. Redis is only the live notification
path; MongoDB is the replay path.

### “How is tenant isolation enforced?”

The OIDC token is verified before its workspace memberships are trusted.
Handlers authorize the requested workspace against the session; database
queries include the workspace ID; WebSocket upgrades repeat the check.
Billing adds an admin-role gate. Search queries also include a workspace
filter. Do not rely on an untrusted request parameter by itself.

### “What does PKCE protect here?”

PKCE binds the authorization-code exchange to a verifier held by the server
login transaction. The app uses a random state value to bind the callback,
and a nonce to bind the ID token. Signature, issuer, audience, expiry, and
nonce are validated before creating the session.

### “How can the server not read private notes?”

The browser encrypts note text with AES-GCM and wraps the random AES key for
each registered device using its public key. Only the matching private key
can unwrap that AES key. The server stores the ciphertext, public keys, and
wrapped keys, not the private keys. Users compare public-key fingerprints
out-of-band because a server-controlled key directory alone is not sufficient
to prevent key substitution.

### “What happens if an agent loses their device?”

There is no recovery path in this implementation. The private key is local to
the browser profile; losing it means notes encrypted for it cannot be
decrypted. A newly enrolled device receives keys for future notes, not
historical ones. A production design would need an explicit, carefully
threat-modeled recovery or multi-device key-management scheme.

### “How does billing avoid duplicate subscriptions?”

Subscription work is serialized per workspace with a short Redis lock and
provider POSTs use stable idempotency keys. The local MongoDB billing record
tracks the current customer/subscription. Webhook events are signed and cause
the app to fetch current Paybox state, which avoids applying stale snapshots.
The concurrent-subscription path was manually smoke-tested; renewal, retry,
seat-change, and forged-webhook scenarios still need a full end-to-end run.

### “Why is search allowed to fail without taking down the inbox?”

Elasticsearch is optional in the assignment. Search is a derived capability;
the durable message write must not depend on it. Search explicitly returns
unavailable when Elasticsearch is down, while webhook and inbox operations
remain independent. The optional ES integration still needs a live-service
test.

### “What would you improve next?”

First, run billing lifecycle tests against the Paybox test clock, including
renewal failures, retries, bank approval, forged webhooks, and send gating.
Second, start Elasticsearch and exercise workspace-isolated searches.
Third, browser-test key enrollment and two-agent private-note exchange.
Finally, run the full checker in Linux/WSL after these additions, because the
Windows harness cannot spawn its required POSIX `sh`.

## 8. What passed, what did not, and why

### Verified

- Previous public assessment run: **75/75** across Levels 1, 2, 3, and 5,
  recorded in `CHECK_REPORT.json`.
- Server typecheck and five focused tests passed after the later changes.
- Web typecheck and production build passed after the later changes.
- The final server started and returned healthy from `/healthz`.
- Manual Paybox concurrency smoke test: three simultaneous subscribe calls
  returned active; the provider report showed one customer and zero requests
  sent without idempotency keys or raw card data sent using the secret key.
- The WebCrypto unit test verified that a recipient can decrypt a note and an
  unrelated private key cannot.

### Pending or limited

| Item | Status | Reason |
|---|---|---|
| Level 4 | Not run | Private grader rules are not in the supplied harness |
| Full checker after optional additions | Not run | Native Windows run fails with `spawn sh ENOENT`; the checked-in report predates these additions |
| Billing lifecycle | Partial validation | Subscription concurrency was smoke-tested; seat changes, renewal/retries, approval and forged-webhook cases need end-to-end tests |
| Search | Implemented, not live-tested | Elasticsearch was not started; it is an optional Docker profile |
| Private-note UI/API | Not browser-tested | Only the cryptographic round-trip/recipient primitive was unit-tested |
| Key recovery/history for new devices | Not implemented | Device private keys are local; historical note re-encryption/key recovery is outside the current design |

The known limitations and design decisions are also recorded in
[DECISIONS.md](./DECISIONS.md) and [PROTOCOL.md](./PROTOCOL.md). Do not
describe unverified optional flows as passing the official checker.

## 9. Commands worth knowing

From the repository root:

```sh
npm run up
npm run doctor
npm run scaffold:install
npm run scaffold:server
npm run scaffold:web
npm run up:search
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/server test
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
npm run check:full
```

The checker resets application data and uses POSIX process-group behavior.
Stop the manually started app before running it; use Linux or WSL for the full
crash-level run.
