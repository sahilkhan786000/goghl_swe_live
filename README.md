# Switchboard

Switchboard is a multi-tenant support inbox built for the supplied live-coding
assessment. It uses Express and TypeScript, MongoDB, Redis, React, and the
provided Pigeon and OpenID Connect simulators.

## Requirements

- Node.js 22
- Docker Desktop with Docker Compose
- Git

## Run locally

From the repository root:

```sh
npm run up
npm run doctor
npm run scaffold:install
npm run scaffold:server
```

In a second terminal:

```sh
npm run scaffold:web
```

Open `http://localhost:5173` and choose a test user at the mock identity
provider. The application defaults match the supplied simulators; copy
`.env.example` to `.env` only when you need to override a setting. Do not
commit `.env`.

To stop the containers, run `npm run down`.

## Architecture

- `scaffold/server/src/auth.ts` implements authorization-code PKCE, verifies
  ID tokens against the IdP's JWKS, and stores opaque sessions in Redis.
- `scaffold/server/src/index.ts` exposes the health, inbox, webhook, and
  grader endpoints and enforces workspace membership on user APIs.
- `scaffold/server/src/store.ts` defines MongoDB indexes, durable workspace
  event sequencing, and grader reset behavior.
- `scaffold/server/src/workers.ts` processes persisted webhooks and replies.
  Replies use a MongoDB outbox, renewable worker leases, shared Redis
  workspace rate limits, and stable Pigeon idempotency keys.
- `scaffold/server/src/realtime.ts` authenticates WebSocket connections and
  replays durable per-workspace events before delivering live notifications.
- `scaffold/web/src/App.tsx` provides the agent sign-in and inbox experience.
- `scaffold/server/src/billing.ts` integrates idempotent Paybox subscriptions,
  seat changes, signed status refreshes, and send eligibility.
- `scaffold/server/src/search.ts` provides workspace-filtered Elasticsearch
  message search. Start the optional service with `npm run up:search`.
- `scaffold/server/src/notes.ts` stores only encrypted note envelopes and
  public device keys; the browser handles encryption and decryption.

Each workspace's conversations and messages are stored separately by
workspace ID. MongoDB uniqueness constraints enforce provider event,
message, and reply idempotency across server instances.

Admins can open Workspace billing in the inbox. Card details go directly from
the browser to Paybox for tokenization; only the token reaches Switchboard.
Use the simulator's test cards documented in `PAYBOX.md`.

Private notes require at least two enrolled workspace members and out-of-band
verification of each device-key fingerprint. Private keys remain in that
browser's IndexedDB; losing a browser profile means those notes cannot be
recovered. See `PROTOCOL.md` for the threat model.

## Checks

```sh
npm --prefix scaffold/server run typecheck
npm --prefix scaffold/server test
npm --prefix scaffold/web run typecheck
npm --prefix scaffold/web run build
npm run check
npm run check:full
```

The assessment checker starts the server using `switchboard.json` and deletes
application data during each run. Stop any manually started server first.
The full check writes `CHECK_REPORT.json`; commit only a report produced by
the real checker. The supplied checker uses POSIX process-group kills in its
crash test; run Levels 2 and 3 from Linux or WSL rather than native Windows.
The checked-in report was produced using Node 22 in Linux with the supplied
services on Docker Compose's network.

## Test users

The mock IdP login page lists the assessment users. For example, `u_ben` is an
agent in `ws_acme`; `u_eli` is an agent in both workspaces. Workspace access
comes from the verified identity token and is checked on every user API and
WebSocket connection.

## Assessment status and limitations

Billing, workspace-scoped message search, and encrypted private notes are
implemented. Billing was manually exercised with three concurrent
subscriptions: all returned active, with one Paybox customer and no raw card
data sent through the server. Seat-change, renewal/retry, and forged-webhook
flows have not had a full end-to-end run. Search requires the optional
Elasticsearch service, which was not started for the final checks. The
encrypted-note crypto primitive has a local round-trip/recipient test, but
browser key enrollment has not had a separate browser-level test.

The checked-in public checker report is 75/75 across Levels 1, 2, 3, and 5;
it predates these optional features. A new checker run on native Windows is
blocked because the supplied harness spawns POSIX `sh`. Level 4 is private
and cannot be run from the supplied harness.
