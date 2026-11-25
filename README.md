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

Each workspace's conversations and messages are stored separately by
workspace ID. MongoDB uniqueness constraints enforce provider event,
message, and reply idempotency across server instances.

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

Private notes, Elasticsearch search, and Paybox billing are not implemented.
The public checker passes 75/75 across Levels 1, 2, 3, and 5. Level 4 is the
private written-rules check and cannot be run from the supplied harness.
