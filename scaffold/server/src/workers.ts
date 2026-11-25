import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { BillingError, workspaceCanSend } from './billing.js';
import { indexMessage } from './search.js';
import { getRedis } from './redis.js';
import {
  appendWorkspaceEvent,
  getCollections,
  isDuplicateKey,
  newWorkerId,
  publishWorkspaceEvent,
} from './store.js';
import type { MessageStatus, PigeonEvent, StoredMessage, WebhookRecord } from './types.js';

const LEASE_MS = 20_000;
const SEND_TIMEOUT_MS = 15_000;
const RATE_LIMIT_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = 8
local tokens = tonumber(redis.call('HGET', key, 'tokens')) or capacity
local at = tonumber(redis.call('HGET', key, 'at')) or now
tokens = math.min(capacity, tokens + math.max(0, now - at) * 4 / 1000)
if tokens < 1 then
  local wait = math.ceil((1 - tokens) * 250)
  redis.call('HSET', key, 'tokens', tokens, 'at', now)
  redis.call('PEXPIRE', key, 60000)
  return wait
end
redis.call('HSET', key, 'tokens', tokens - 1, 'at', now)
redis.call('PEXPIRE', key, 60000)
return 0
`;
const workerId = newWorkerId();

function isValidWorkspace(value: string | undefined): value is 'ws_acme' | 'ws_globex' {
  return value === 'ws_acme' || value === 'ws_globex';
}

function dateFrom(value: string | undefined): Date {
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function validStatus(value: string | undefined): value is Exclude<MessageStatus, 'queued'> {
  return value === 'sent' || value === 'delivered' || value === 'failed';
}

function statusPriority(status: MessageStatus): number {
  if (status === 'queued') return 0;
  if (status === 'sent') return 1;
  return 2;
}

async function processInbound(event: PigeonEvent): Promise<void> {
  const workspace = event.workspace;
  const contact = event.data?.from;
  const providerMessageId = event.data?.message_id;
  const text = event.data?.text;
  if (!isValidWorkspace(workspace) || !contact || !providerMessageId || typeof text !== 'string') return;

  const c = await getCollections();
  const occurredAt = dateFrom(event.occurred_at);
  const now = new Date();
  const inboundMessage: StoredMessage = {
    workspace,
    contact,
    providerMessageId,
    direction: 'inbound',
    text,
    createdAt: now,
    occurredAt,
  };
  let messageToIndex = inboundMessage;
  try {
    await c.messages.insertOne(inboundMessage);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const stored = await c.messages.findOne({ workspace, providerMessageId });
    if (!stored) throw error;
    messageToIndex = stored;
  }
  void indexMessage(messageToIndex).catch((error: unknown) => {
    console.error('Could not index inbound message for search', error);
  });

  await c.conversations.updateOne(
    { workspace, contact },
    {
      $set: { state: 'open', updatedAt: now },
      $setOnInsert: { workspace, contact, assignee: null, createdAt: now },
      $max: { lastActivityAt: occurredAt },
    },
    { upsert: true },
  );
  const saved = await appendWorkspaceEvent({
    workspace,
    type: 'message.inbound',
    contact,
    message_id: providerMessageId,
    dedupeKey: `message.inbound:${providerMessageId}`,
  });
  await publishWorkspaceEvent(saved);
}

async function processStatus(event: PigeonEvent): Promise<void> {
  const workspace = event.workspace;
  const data = event.data;
  if (!isValidWorkspace(workspace) || !data || !validStatus(data.status)) return;
  const filter = data.client_ref
    ? { workspace, direction: 'outbound' as const, clientRef: data.client_ref }
    : data.message_id
      ? { workspace, direction: 'outbound' as const, providerMessageId: data.message_id }
      : null;
  if (!filter) return;

  const c = await getCollections();
  const incomingAt = dateFrom(event.occurred_at);
  for (let attempt = 0; attempt < 4; attempt++) {
    const message = await c.messages.findOne(filter);
    if (!message) return;
    const currentStatus = message.status || 'queued';
    const currentAt = message.providerStatusAt;
    if (
      statusPriority(data.status) < statusPriority(currentStatus) ||
      (currentAt && incomingAt < currentAt) ||
      (currentAt &&
        incomingAt.getTime() === currentAt.getTime() &&
        statusPriority(data.status) <= statusPriority(currentStatus))
    ) {
      return;
    }

    const concurrencyFilter = currentAt
      ? { ...filter, providerStatusAt: currentAt }
      : { ...filter, providerStatusAt: { $exists: false } };
    const result = await c.messages.updateOne(
      concurrencyFilter,
      { $set: { status: data.status, providerStatusAt: incomingAt } },
    );
    if (result.modifiedCount === 0) continue;

    const contact = message.contact;
    const saved = await appendWorkspaceEvent({
      workspace,
      type: 'message.status',
      contact,
      client_ref: message.clientRef || data.client_ref,
      status: data.status,
      dedupeKey: `message.status:${event.id}`,
    });
    await publishWorkspaceEvent(saved);
    return;
  }
  throw new Error(`Could not apply Pigeon status event ${event.id} after concurrent updates`);
}

async function claimWebhook(): Promise<WebhookRecord | null> {
  const c = await getCollections();
  const now = new Date();
  return c.webhooks.findOneAndUpdate(
    {
      $or: [
        { status: 'pending' },
        { status: 'processing', leaseUntil: { $lte: now } },
        { status: 'processing', leaseUntil: { $exists: false } },
      ],
    },
    {
      $set: {
        status: 'processing',
        leaseOwner: workerId,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
}

async function processOneWebhook(): Promise<boolean> {
  const record = await claimWebhook();
  if (!record) return false;
  try {
    if (record.event.type === 'message.inbound') await processInbound(record.event);
    else if (record.event.type === 'message.status') await processStatus(record.event);
    await (await getCollections()).webhooks.updateOne(
      { _id: record._id, leaseOwner: workerId },
      { $set: { status: 'done' }, $unset: { leaseOwner: '', leaseUntil: '' } },
    );
  } catch (error) {
    await (await getCollections()).webhooks.updateOne(
      { _id: record._id, leaseOwner: workerId },
      {
        $set: { status: 'pending' },
        $unset: { leaseOwner: '', leaseUntil: '' },
      },
    );
    throw error;
  }
  return true;
}

async function claimOutboxMessage(): Promise<StoredMessage | null> {
  const c = await getCollections();
  const now = new Date();
  return c.messages.findOneAndUpdate(
    {
      direction: 'outbound',
      sendState: { $in: ['queued', 'sending'] },
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: { $exists: false } }],
    },
    {
      $set: {
        sendState: 'sending',
        leaseOwner: workerId,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
}

async function deferMessage(message: StoredMessage, delayMs: number, error?: string): Promise<void> {
  const c = await getCollections();
  const set: Partial<StoredMessage> = { sendState: 'queued', nextAttemptAt: new Date(Date.now() + delayMs) };
  if (error) set.lastError = error.slice(0, 300);
  await c.messages.updateOne(
    { workspace: message.workspace, clientRef: message.clientRef, leaseOwner: workerId },
    { $set: set, $unset: { leaseOwner: '', leaseUntil: '' } },
  );
}

async function finishMessage(message: StoredMessage, status: MessageStatus, providerId?: string): Promise<void> {
  const c = await getCollections();
  const set: Partial<StoredMessage> = { sendState: 'sent' };
  if (providerId) set.providerMessageId = providerId;
  await c.messages.updateOne(
    {
      workspace: message.workspace,
      clientRef: message.clientRef,
      leaseOwner: workerId,
    },
    {
      $set: set,
      $unset: { leaseOwner: '', leaseUntil: '', lastError: '' },
    },
  );
  if (status === 'failed') {
    await c.messages.updateOne(
      { workspace: message.workspace, clientRef: message.clientRef, status: 'queued' },
      { $set: { status: 'failed', providerStatusAt: new Date() } },
    );
  } else if (status === 'sent') {
    await c.messages.updateOne(
      { workspace: message.workspace, clientRef: message.clientRef, status: 'queued' },
      { $set: { status: 'sent' } },
    );
  }
}

async function getRateLimitWait(workspace: string): Promise<number> {
  const redis = getRedis();
  const coolOffUntil = Number(await redis.get(`switchboard:pigeon-cooloff:${workspace}`) || 0);
  const remaining = coolOffUntil - Date.now();
  if (remaining > 0) return remaining;
  return Number(
    await redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      `switchboard:pigeon-bucket:${workspace}`,
      Date.now(),
    ),
  );
}

async function sendOneMessage(): Promise<boolean> {
  const message = await claimOutboxMessage();
  if (!message) return false;
  const workspace = message.workspace;
  if (!isValidWorkspace(workspace) || !message.clientRef) {
    await finishMessage(message, 'failed');
    return true;
  }
  if (!(await workspaceCanSend(workspace))) {
    await deferMessage(message, 60_000, 'Workspace subscription is not active');
    return true;
  }
  const wait = await getRateLimitWait(workspace);
  if (wait > 0) {
    await deferMessage(message, wait);
    return true;
  }

  try {
    const response = await fetch(`${config.pigeon.url.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.pigeon.apiKeys[workspace]}`,
        'content-type': 'application/json',
        'idempotency-key': message.clientRef,
      },
      body: JSON.stringify({
        to: message.contact,
        text: message.text,
        client_ref: message.clientRef,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') || 1);
      const delay = Math.max(250, retryAfter * 1000);
      await getRedis().set(`switchboard:pigeon-cooloff:${workspace}`, String(Date.now() + delay), 'PX', delay);
      await deferMessage(message, delay, 'Pigeon rate limited the workspace');
      return true;
    }

    if (response.status >= 500) {
      await deferMessage(message, Math.min(10_000, 500 * 2 ** Math.min(message.attempts || 0, 4)), `Pigeon returned ${response.status}`);
      return true;
    }
    if (!response.ok) {
      await finishMessage(message, 'failed');
      return true;
    }

    const body = (await response.json()) as { id?: string };
    await finishMessage(message, 'sent', body.id);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Pigeon request failed';
    await deferMessage(message, Math.min(10_000, 500 * 2 ** Math.min(message.attempts || 0, 4)), messageText);
  }
  return true;
}

export async function enqueueReply(
  workspace: string,
  contact: string,
  text: string,
  clientRef: string,
): Promise<void> {
  const c = await getCollections();
  const now = new Date();
  const outboundMessage: StoredMessage = {
    workspace,
    contact,
    direction: 'outbound',
    clientRef,
    text,
    status: 'queued',
    sendState: 'queued',
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    occurredAt: now,
  };
  let messageToIndex = outboundMessage;
  try {
    await c.messages.insertOne(outboundMessage);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const stored = await c.messages.findOne({ workspace, clientRef });
    if (!stored) throw error;
    messageToIndex = stored;
  }
  void indexMessage(messageToIndex).catch((error: unknown) => {
    console.error('Could not index outbound message for search', error);
  });
  await c.conversations.updateOne(
    { workspace, contact },
    {
      $set: { updatedAt: now },
      $setOnInsert: { workspace, contact, assignee: null, state: 'open', createdAt: now },
      $max: { lastActivityAt: now },
    },
    { upsert: true },
  );
}

export function startWorkers(): void {
  const safeRun = async (label: string, operation: () => Promise<boolean>) => {
    try {
      await operation();
    } catch (error) {
      console.error(`${label} worker failed`, error);
    }
  };
  setInterval(() => {
    void safeRun('webhook', processOneWebhook);
    void safeRun('outbox', sendOneMessage);
  }, 100);
}

export async function queueMessage(
  workspace: string,
  contact: string,
  text: string,
  clientRef?: string,
): Promise<string> {
  if (!(await workspaceCanSend(workspace))) {
    throw new BillingError(402, 'workspace subscription does not allow sending');
  }
  const ref = clientRef || randomUUID();
  await enqueueReply(workspace, contact, text, ref);
  return ref;
}
