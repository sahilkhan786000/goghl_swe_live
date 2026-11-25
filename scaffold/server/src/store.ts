import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { getDb } from './db.js';
import { getRedis } from './redis.js';
import type { Conversation, EncryptedPrivateNote, StoredMessage, WebhookRecord, WorkspaceBilling, WorkspaceEvent, WorkspaceNoteKey } from './types.js';

export interface Collections {
  conversations: Collection<Conversation>;
  messages: Collection<StoredMessage>;
  webhooks: Collection<WebhookRecord>;
  workspaceEvents: Collection<WorkspaceEvent>;
  counters: Collection<{ _id: string; value: number }>;
  billing: Collection<WorkspaceBilling>;
  notes: Collection<EncryptedPrivateNote>;
  noteKeys: Collection<WorkspaceNoteKey>;
}

let collections: Collections | undefined;

export async function getCollections(): Promise<Collections> {
  if (!collections) {
    const db = await getDb();
    collections = {
      conversations: db.collection<Conversation>('conversations'),
      messages: db.collection<StoredMessage>('messages'),
      webhooks: db.collection<WebhookRecord>('webhook_events'),
      workspaceEvents: db.collection<WorkspaceEvent>('workspace_events'),
      counters: db.collection<{ _id: string; value: number }>('counters'),
      billing: db.collection<WorkspaceBilling>('workspace_billing'),
      notes: db.collection<EncryptedPrivateNote>('private_notes'),
      noteKeys: db.collection<WorkspaceNoteKey>('workspace_note_keys'),
    };
  }
  return collections;
}

export async function ensureIndexes(): Promise<void> {
  const c = await getCollections();
  await Promise.all([
    c.conversations.createIndex({ workspace: 1, contact: 1 }, { unique: true }),
    c.conversations.createIndex({ workspace: 1, state: 1, lastActivityAt: -1 }),
    c.messages.createIndex({ workspace: 1, contact: 1, direction: 1, occurredAt: 1 }),
    c.messages.createIndex(
      { workspace: 1, providerMessageId: 1 },
      { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } },
    ),
    c.messages.createIndex(
      { workspace: 1, clientRef: 1 },
      { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } } },
    ),
    c.messages.createIndex({ sendState: 1, nextAttemptAt: 1, leaseUntil: 1 }),
    c.webhooks.createIndex({ status: 1, leaseUntil: 1, createdAt: 1 }),
    c.workspaceEvents.createIndex({ workspace: 1, seq: 1 }, { unique: true }),
    c.workspaceEvents.createIndex({ workspace: 1, dedupeKey: 1 }, { unique: true }),
    c.billing.createIndex({ workspace: 1 }, { unique: true }),
    c.notes.createIndex({ workspace: 1, contact: 1, createdAt: -1 }),
    c.noteKeys.createIndex({ workspace: 1, userId: 1, deviceId: 1 }, { unique: true }),
  ]);
}

export function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

export async function appendWorkspaceEvent(
  event: Omit<WorkspaceEvent, 'seq' | 'createdAt'>,
): Promise<WorkspaceEvent> {
  const c = await getCollections();
  const existing = await c.workspaceEvents.findOne({
    workspace: event.workspace,
    dedupeKey: event.dedupeKey,
  });
  if (existing) return existing;

  const counter = await c.counters.findOneAndUpdate(
    { _id: `workspace-seq:${event.workspace}` },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  if (!counter) throw new Error('Could not allocate a workspace event sequence');

  const saved: WorkspaceEvent = {
    ...event,
    seq: counter.value,
    createdAt: new Date(),
  };
  try {
    await c.workspaceEvents.insertOne(saved);
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const raced = await c.workspaceEvents.findOne({
      workspace: event.workspace,
      dedupeKey: event.dedupeKey,
    });
    if (!raced) throw error;
    return raced;
  }
  return saved;
}

export async function publishWorkspaceEvent(event: WorkspaceEvent): Promise<void> {
  await getRedis().publish('switchboard:workspace-events', JSON.stringify(event));
}

export function newWorkerId(): string {
  return randomUUID();
}

export async function resetApplicationData(): Promise<void> {
  const c = await getCollections();
  await Promise.all([
    c.conversations.deleteMany({}),
    c.messages.deleteMany({}),
    c.webhooks.deleteMany({}),
    c.workspaceEvents.deleteMany({}),
    c.counters.deleteMany({}),
    c.billing.deleteMany({}),
    c.notes.deleteMany({}),
    c.noteKeys.deleteMany({}),
  ]);

  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'switchboard:*', 'COUNT', '250');
    cursor = next;
    const appKeys = keys.filter((key) => !key.startsWith('switchboard:session:'));
    if (appKeys.length) await redis.del(...appKeys);
  } while (cursor !== '0');
}

export async function pingStores(): Promise<Db> {
  const db = await getDb();
  await db.command({ ping: 1 });
  await getRedis().ping();
  return db;
}
