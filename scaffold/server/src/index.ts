import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { config } from './config.js';
import { beginLogin, finishLogin, getSession, logout, workspaceRole } from './auth.js';
import { ensureIndexes, getCollections, isDuplicateKey, resetApplicationData, pingStores, appendWorkspaceEvent, publishWorkspaceEvent } from './store.js';
import { startRealtime } from './realtime.js';
import { queueMessage, startWorkers } from './workers.js';
import { BillingError, changeSeats, getBilling, handlePayboxEvent, refreshBilling, subscribeWorkspace } from './billing.js';
import { verifyWebhookSignature } from './signatures.js';
import { resetSearchIndex, SearchUnavailableError, searchMessages } from './search.js';
import { listEncryptedNotes, listNoteKeys, NoteInputError, registerNoteKey, saveEncryptedNote } from './notes.js';
import type { Conversation, PigeonEvent, StoredMessage, UserSession } from './types.js';

const WORKSPACES = ['ws_acme', 'ws_globex'] as const;
const app = express();
const server = createServer(app);
app.set('trust proxy', 1);
app.disable('x-powered-by');

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AsyncHandler = (request: Request, response: Response) => Promise<void>;

function asyncRoute(handler: AsyncHandler): express.RequestHandler {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

function isWorkspace(value: unknown): value is (typeof WORKSPACES)[number] {
  return typeof value === 'string' && WORKSPACES.includes(value as (typeof WORKSPACES)[number]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function authenticatedSession(request: Request, response: Response): Promise<UserSession | null> {
  const session = await getSession(request);
  if (!session) response.status(401).json({ error: 'authentication_required' });
  return session;
}

function requireWorkspace(session: UserSession, workspace: unknown): asserts workspace is string {
  if (typeof workspace !== 'string' || !workspace) throw new HttpError(400, 'workspace is required');
  if (!workspaceRole(session, workspace)) throw new HttpError(403, 'workspace access denied');
}

function requireWorkspaceAdmin(session: UserSession, workspace: unknown): asserts workspace is string {
  requireWorkspace(session, workspace);
  if (workspaceRole(session, workspace)?.role !== 'admin') {
    throw new HttpError(403, 'workspace admin access required');
  }
}

async function claimConversation(
  workspace: string,
  contact: string,
  agent: string,
): Promise<boolean> {
  const c = await getCollections();
  const now = new Date();
  try {
    await c.conversations.updateOne(
      { workspace, contact },
      {
        $setOnInsert: {
          workspace,
          contact,
          assignee: null,
          state: 'open',
          createdAt: now,
          updatedAt: now,
          lastActivityAt: now,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
  }

  const claimed = await c.conversations.findOneAndUpdate(
    {
      workspace,
      contact,
      $or: [{ assignee: null }, { assignee: { $exists: false } }, { assignee: agent }],
    },
    { $set: { assignee: agent, updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!claimed) return false;
  const event = await appendWorkspaceEvent({
    workspace,
    type: 'conversation.assigned',
    contact,
    assignee: agent,
    dedupeKey: `conversation.assigned:${contact}:${agent}`,
  });
  await publishWorkspaceEvent(event);
  return true;
}

async function changeConversationState(
  workspace: string,
  contact: string,
  state: Conversation['state'],
): Promise<boolean> {
  const c = await getCollections();
  const result = await c.conversations.updateOne(
    { workspace, contact, state: { $ne: state } },
    { $set: { state, updatedAt: new Date() } },
  );
  if (result.matchedCount === 0) {
    return Boolean(await c.conversations.findOne({ workspace, contact }));
  }
  const event = await appendWorkspaceEvent({
    workspace,
    type: state === 'closed' ? 'conversation.closed' : 'conversation.reopened',
    contact,
    dedupeKey: `conversation.${state}:${contact}:${Date.now()}:${Math.random()}`,
  });
  await publishWorkspaceEvent(event);
  return true;
}

function asConversationListItem(
  conversation: Conversation,
  latestMessage: StoredMessage | null,
): Record<string, unknown> {
  return {
    contact: conversation.contact,
    assignee: conversation.assignee,
    state: conversation.state,
    lastActivityAt: conversation.lastActivityAt,
    latestMessage: latestMessage
      ? {
          text: latestMessage.text,
          direction: latestMessage.direction,
          status: latestMessage.status,
          createdAt: latestMessage.createdAt,
        }
      : null,
  };
}

app.get(
  '/healthz',
  asyncRoute(async (_request, response) => {
    await pingStores();
    response.status(200).json({ ok: true });
  }),
);

app.get('/auth/login', asyncRoute(beginLogin));
app.get('/auth/callback', asyncRoute(finishLogin));
app.post('/auth/logout', asyncRoute(logout));

app.post(
  '/webhooks/pigeon',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncRoute(async (request, response) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (!verifyWebhookSignature(request.header('x-pigeon-signature'), raw, config.pigeon.webhookSecret)) {
      response.status(401).json({ error: 'invalid_signature' });
      return;
    }

    let event: PigeonEvent;
    try {
      event = JSON.parse(raw.toString('utf8')) as PigeonEvent;
    } catch {
      response.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') {
      response.status(400).json({ error: 'invalid_event' });
      return;
    }
    if (event.type !== 'message.inbound' && event.type !== 'message.status') {
      response.status(200).end();
      return;
    }
    if (!isWorkspace(event.workspace)) {
      response.status(200).end();
      return;
    }
    if (event.type === 'message.inbound') {
      if (!event.data?.from || !event.data.message_id || typeof event.data.text !== 'string') {
        response.status(400).json({ error: 'invalid_inbound_event' });
        return;
      }
    } else {
      const clientRef = event.data?.client_ref;
      const messageId = event.data?.message_id;
      if (!clientRef && !messageId) {
        response.status(200).end();
        return;
      }
      const c = await getCollections();
      const known = await c.messages.findOne({
        workspace: event.workspace,
        direction: 'outbound',
        $or: [
          ...(clientRef ? [{ clientRef }] : []),
          ...(messageId ? [{ providerMessageId: messageId }] : []),
        ],
      });
      if (!known) {
        response.status(200).end();
        return;
      }
    }

    const c = await getCollections();
    try {
      await c.webhooks.insertOne({
        _id: event.id,
        event,
        status: 'pending',
        createdAt: new Date(),
        attempts: 0,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
    response.status(200).end();
  }),
);

app.post(
  '/webhooks/paybox',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncRoute(async (request, response) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    if (!verifyWebhookSignature(request.header('x-paybox-signature'), raw, config.paybox.webhookSecret)) {
      response.status(401).json({ error: 'invalid_signature' });
      return;
    }

    let event: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(raw.toString('utf8')) as typeof event;
    } catch {
      response.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (typeof event.id !== 'string' || typeof event.type !== 'string') {
      response.status(400).json({ error: 'invalid_event' });
      return;
    }
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted' ||
      event.type === 'invoice.paid' ||
      event.type === 'invoice.payment_failed' ||
      event.type === 'invoice.payment_action_required'
    ) {
      await handlePayboxEvent(event as { type: string; data?: { object?: Record<string, unknown> } });
    }
    response.status(200).end();
  }),
);

app.use(express.json({ limit: '1mb' }));

app.get(
  '/api/me',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    response.json({
      sub: session.sub,
      name: session.name,
      email: session.email,
      workspaces: session.workspaces,
    });
  }),
);

app.get(
  '/api/search',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace;
    requireWorkspace(session, workspace);
    const query = stringValue(request.query.q);
    if (!query || query.length < 2 || query.length > 120) {
      throw new HttpError(400, 'search query must contain 2 to 120 characters');
    }
    try {
      const items = await searchMessages(workspace, query);
      const c = await getCollections();
      const results = await Promise.all(items.map(async (item) => {
        const conversation = await c.conversations.findOne(
          { workspace, contact: item.contact },
          { projection: { state: 1 } },
        );
        return { ...item, state: conversation?.state || 'open' };
      }));
      response.json({ items: results });
    } catch (error) {
      if (error instanceof SearchUnavailableError) {
        response.status(503).json({ error: 'search_unavailable' });
        return;
      }
      throw error;
    }
  }),
);

app.get(
  '/api/notes/keys',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace;
    requireWorkspace(session, workspace);
    response.json({ keys: await listNoteKeys(workspace) });
  }),
);

app.post(
  '/api/notes/keys',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.body?.workspace;
    requireWorkspace(session, workspace);
    const key = await registerNoteKey(workspace, session, request.body?.device_id, request.body?.public_key);
    response.status(201).json({ key_id: key.keyId });
  }),
);

app.get(
  '/api/conversations/:contact/notes',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace;
    requireWorkspace(session, workspace);
    const c = await getCollections();
    const conversation = await c.conversations.findOne({ workspace, contact: request.params.contact });
    if (!conversation) throw new HttpError(404, 'conversation_not_found');
    response.json({ items: await listEncryptedNotes(workspace, request.params.contact) });
  }),
);

app.post(
  '/api/conversations/:contact/notes',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.body?.workspace;
    requireWorkspace(session, workspace);
    const c = await getCollections();
    const conversation = await c.conversations.findOne({ workspace, contact: request.params.contact });
    if (!conversation) throw new HttpError(404, 'conversation_not_found');
    response.status(201).json({
      note: await saveEncryptedNote(workspace, request.params.contact, session, request.body),
    });
  }),
);

app.get(
  '/api/billing',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace;
    requireWorkspaceAdmin(session, workspace);
    response.json(await refreshBilling(workspace));
  }),
);

app.get(
  '/api/billing/config',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace;
    requireWorkspaceAdmin(session, workspace);
    response.json({
      publishable_key: config.paybox.publishableKey,
      url: config.paybox.url,
    });
  }),
);

app.post(
  '/api/billing/subscribe',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.body?.workspace;
    requireWorkspaceAdmin(session, workspace);
    const billing = await subscribeWorkspace(
      workspace,
      Number(request.body?.seats),
      request.body?.token,
      session,
    );
    response.status(billing.status === 'active' ? 200 : 402).json(billing);
  }),
);

app.post(
  '/api/billing/seats',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.body?.workspace;
    requireWorkspaceAdmin(session, workspace);
    response.json(await changeSeats(workspace, Number(request.body?.seats)));
  }),
);

app.get(
  '/api/conversations',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace;
    requireWorkspace(session, workspace);

    const requestedLimit = Number(request.query.limit || 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    const filter: Record<string, unknown> = { workspace };
    if (request.query.state === 'open' || request.query.state === 'closed') filter.state = request.query.state;
    if (typeof request.query.before === 'string') {
      const before = new Date(request.query.before);
      if (!Number.isNaN(before.getTime())) filter.lastActivityAt = { $lt: before };
    }

    const c = await getCollections();
    const rows = await c.conversations
      .find(filter)
      .sort({ lastActivityAt: -1, contact: 1 })
      .limit(limit + 1)
      .toArray();
    const page = rows.slice(0, limit);
    const items = await Promise.all(
      page.map(async (conversation) => {
        const latestMessage = await c.messages.findOne(
          { workspace, contact: conversation.contact },
          { sort: { occurredAt: -1, createdAt: -1 } },
        );
        return asConversationListItem(conversation, latestMessage);
      }),
    );
    response.json({
      items,
      nextCursor: rows.length > limit ? page[page.length - 1]?.lastActivityAt.toISOString() : null,
    });
  }),
);

app.get(
  '/api/conversations/:contact',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace;
    requireWorkspace(session, workspace);
    const c = await getCollections();
    const conversation = await c.conversations.findOne({ workspace, contact: request.params.contact });
    if (!conversation) throw new HttpError(404, 'conversation_not_found');
    const messages = await c.messages
      .find({ workspace, contact: request.params.contact })
      .sort({ occurredAt: 1, createdAt: 1 })
      .toArray();
    response.json({ conversation, messages });
  }),
);

app.post(
  '/api/conversations/:contact/replies',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace || request.body?.workspace;
    requireWorkspace(session, workspace);
    const text = stringValue(request.body?.text);
    if (!text || text.length > 10_000) throw new HttpError(400, 'text must contain 1 to 10000 characters');
    const clientRef = stringValue(request.body?.client_ref) || undefined;
    const ref = await queueMessage(workspace, request.params.contact, text, clientRef);
    response.status(202).json({ client_ref: ref, status: 'queued' });
  }),
);

app.post(
  '/api/conversations/:contact/claim',
  asyncRoute(async (request, response) => {
    const session = await authenticatedSession(request, response);
    if (!session) return;
    const workspace = request.query.workspace || request.body?.workspace;
    requireWorkspace(session, workspace);
    const claimed = await claimConversation(workspace, request.params.contact, session.sub);
    if (!claimed) throw new HttpError(409, 'conversation_already_claimed');
    response.status(200).json({ assignee: session.sub });
  }),
);

for (const state of ['closed', 'open'] as const) {
  const path = state === 'closed' ? 'close' : 'reopen';
  app.post(
    `/api/conversations/:contact/${path}`,
    asyncRoute(async (request, response) => {
      const session = await authenticatedSession(request, response);
      if (!session) return;
      const workspace = request.query.workspace || request.body?.workspace;
      requireWorkspace(session, workspace);
      const changed = await changeConversationState(workspace, request.params.contact, state);
      if (!changed) throw new HttpError(404, 'conversation_not_found');
      response.status(200).json({ state });
    }),
  );
}

function requireGrader(request: Request): void {
  const provided = request.header('x-grader-token') || '';
  const expected = config.graderToken;
  const supplied = Buffer.from(provided);
  const required = Buffer.from(expected);
  if (supplied.length !== required.length || !timingSafeEqual(supplied, required)) {
    throw new HttpError(401, 'invalid_grader_token');
  }
}

app.post(
  '/__grader/reset',
  asyncRoute(async (request, response) => {
    requireGrader(request);
    await resetApplicationData();
    await resetSearchIndex();
    response.status(200).json({ ok: true });
  }),
);

app.get(
  '/__grader/snapshot',
  asyncRoute(async (request, response) => {
    requireGrader(request);
    const c = await getCollections();
    const workspaces: Record<string, {
      contacts: Record<string, { inbound: string[]; assignee: string | null }>;
      outbound: Record<string, string>;
      billing: { status: string; seats: number; can_send: boolean };
    }> = {};
    for (const workspace of WORKSPACES) {
      const contacts: Record<string, { inbound: string[]; assignee: string | null }> = {};
      const outbound: Record<string, string> = {};
      const conversations = await c.conversations.find({ workspace }).toArray();
      for (const conversation of conversations) {
        const inbound = await c.messages
          .find({ workspace, contact: conversation.contact, direction: 'inbound' })
          .sort({ occurredAt: 1, providerMessageId: 1 })
          .toArray();
        contacts[conversation.contact] = {
          inbound: inbound.flatMap((message) => (message.providerMessageId ? [message.providerMessageId] : [])),
          assignee: conversation.assignee || null,
        };
      }
      const replies = await c.messages.find({ workspace, direction: 'outbound' }).toArray();
      for (const reply of replies) {
        if (reply.clientRef) outbound[reply.clientRef] = reply.status || 'queued';
      }
      const billing = await getBilling(workspace);
      workspaces[workspace] = { contacts, outbound, billing: { status: billing.status, seats: billing.seats, can_send: billing.can_send } };
    }
    response.json({ workspaces });
  }),
);

app.post(
  '/__grader/reply',
  asyncRoute(async (request, response) => {
    requireGrader(request);
    const workspace = request.body?.workspace;
    const contact = stringValue(request.body?.contact);
    const text = stringValue(request.body?.text);
    const clientRef = stringValue(request.body?.client_ref);
    if (!isWorkspace(workspace)) throw new HttpError(400, 'unknown workspace');
    if (!contact || !text || text.length > 10_000 || !clientRef) {
      throw new HttpError(400, 'contact, text and client_ref are required');
    }
    await queueMessage(workspace, contact, text, clientRef);
    response.status(202).json({ client_ref: clientRef, status: 'queued' });
  }),
);

app.post(
  '/__grader/billing/subscribe',
  asyncRoute(async (request, response) => {
    requireGrader(request);
    const workspace = request.body?.workspace;
    if (!isWorkspace(workspace)) throw new HttpError(400, 'unknown workspace');
    const billing = await subscribeWorkspace(
      workspace,
      Number(request.body?.seats),
      request.body?.token,
      { sub: 'assessment-admin', name: 'Assessment Admin' },
    );
    response.status(billing.status === 'active' ? 200 : 402).json(billing);
  }),
);

app.post(
  '/__grader/billing/seats',
  asyncRoute(async (request, response) => {
    requireGrader(request);
    const workspace = request.body?.workspace;
    if (!isWorkspace(workspace)) throw new HttpError(400, 'unknown workspace');
    response.json(await changeSeats(workspace, Number(request.body?.seats)));
  }),
);

app.post(
  '/__grader/claim',
  asyncRoute(async (request, response) => {
    requireGrader(request);
    const workspace = request.body?.workspace;
    const contact = stringValue(request.body?.contact);
    const agent = stringValue(request.body?.agent);
    if (!isWorkspace(workspace)) throw new HttpError(400, 'unknown workspace');
    if (!contact || !agent) throw new HttpError(400, 'contact and agent are required');
    const claimed = await claimConversation(workspace, contact, agent);
    if (!claimed) throw new HttpError(409, 'conversation_already_claimed');
    response.status(200).json({ assignee: agent });
  }),
);

app.use(((error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    response.status(400).json({ error: 'invalid_json' });
    return;
  }
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof BillingError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof NoteInputError) {
    response.status(400).json({ error: error.message });
    return;
  }
  console.error('Request failed', error);
  response.status(500).json({ error: 'internal_error' });
}) as ErrorRequestHandler);

async function start(): Promise<void> {
  await pingStores();
  await ensureIndexes();
  await startRealtime(server);
  startWorkers();
  server.listen(config.port, () => {
    console.log(`Switchboard server listening on :${config.port}`);
  });
}

void start().catch((error: unknown) => {
  console.error('Could not start Switchboard', error);
  process.exitCode = 1;
});
