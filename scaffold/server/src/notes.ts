import { randomUUID } from 'node:crypto';
import { getCollections } from './store.js';
import type { EncryptedPrivateNote, NotePublicKey, UserSession, WorkspaceNoteKey } from './types.js';

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];

export class NoteInputError extends Error {}

function publicKeyValue(value: unknown): NotePublicKey {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NoteInputError('an RSA public key is required');
  }
  const key = value as Record<string, unknown>;
  if (
    key.kty !== 'RSA' ||
    key.alg !== 'RSA-OAEP-256' ||
    key.ext !== true ||
    !Array.isArray(key.key_ops) ||
    key.key_ops.length !== 1 ||
    key.key_ops[0] !== 'encrypt' ||
    typeof key.n !== 'string' ||
    key.n.length < 250 ||
    key.n.length > 1024 ||
    typeof key.e !== 'string' ||
    key.e.length > 16 ||
    PRIVATE_JWK_FIELDS.some((field) => field in key)
  ) {
    throw new NoteInputError('invalid RSA-OAEP public key');
  }
  return {
    kty: 'RSA',
    n: key.n,
    e: key.e,
    alg: 'RSA-OAEP-256',
    ext: true,
    key_ops: ['encrypt'],
  };
}

function validBase64(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes * 4 / 3) + 4) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length >= minBytes && decoded.length <= maxBytes && decoded.toString('base64') === value;
}

function keyId(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

export async function registerNoteKey(
  workspace: string,
  session: UserSession,
  deviceId: unknown,
  value: unknown,
): Promise<WorkspaceNoteKey> {
  if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(deviceId)) {
    throw new NoteInputError('invalid encryption device id');
  }
  const publicKey = publicKeyValue(value);
  const record: WorkspaceNoteKey = {
    workspace,
    userId: session.sub,
    deviceId,
    keyId: keyId(session.sub, deviceId),
    publicKey,
    updatedAt: new Date(),
  };
  await (await getCollections()).noteKeys.updateOne(
    { workspace, userId: session.sub, deviceId },
    { $set: record },
    { upsert: true },
  );
  return record;
}

export async function listNoteKeys(workspace: string): Promise<Array<Pick<WorkspaceNoteKey, 'keyId' | 'userId' | 'publicKey'>>> {
  const keys = await (await getCollections()).noteKeys
    .find({ workspace })
    .sort({ updatedAt: 1 })
    .toArray();
  return keys.map(({ keyId: id, userId, publicKey }) => ({ keyId: id, userId, publicKey }));
}

export async function saveEncryptedNote(
  workspace: string,
  contact: string,
  session: UserSession,
  value: unknown,
): Promise<EncryptedPrivateNote> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NoteInputError('encrypted note payload is required');
  }
  const input = value as Record<string, unknown>;
  if (!validBase64(input.iv, 12, 12) || !validBase64(input.ciphertext, 17, 50_000)) {
    throw new NoteInputError('invalid encrypted note payload');
  }
  if (typeof input.wrappedKeys !== 'object' || input.wrappedKeys === null || Array.isArray(input.wrappedKeys)) {
    throw new NoteInputError('recipient encryption keys are required');
  }
  const wrappedKeys = input.wrappedKeys as Record<string, unknown>;
  const c = await getCollections();
  const registeredKeys = await c.noteKeys.find({ workspace }).project({ keyId: 1 }).toArray();
  const registeredIds = registeredKeys.map((key) => key.keyId).sort();
  const suppliedIds = Object.keys(wrappedKeys).sort();
  if (
    new Set(registeredKeys.map((key) => key.userId)).size < 2 ||
    !registeredKeys.some((key) => key.keyId.startsWith(`${session.sub}:`)) ||
    registeredIds.join('\0') !== suppliedIds.join('\0')
  ) {
    throw new NoteInputError('at least two workspace members must enroll; encrypt for every registered device');
  }
  const safeWrappedKeys: Record<string, string> = {};
  for (const id of registeredIds) {
    const wrapped = wrappedKeys[id];
    if (!validBase64(wrapped, 128, 1024)) throw new NoteInputError('invalid wrapped note key');
    safeWrappedKeys[id] = wrapped;
  }

  const note: EncryptedPrivateNote = {
    id: randomUUID(),
    workspace,
    contact,
    author: session.sub,
    iv: input.iv,
    ciphertext: input.ciphertext,
    wrappedKeys: safeWrappedKeys,
    createdAt: new Date(),
  };
  await c.notes.insertOne(note);
  return note;
}

export async function listEncryptedNotes(workspace: string, contact: string): Promise<EncryptedPrivateNote[]> {
  return (await getCollections()).notes
    .find({ workspace, contact })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
}
