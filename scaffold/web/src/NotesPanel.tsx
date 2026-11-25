import { useEffect, useState } from 'react';
import { decryptNote, encryptNote, fingerprintKey, generateNoteKeys, type EncryptedNoteRecord, type NoteRecipient } from './notes-crypto';

interface LocalIdentity {
  privateKey: CryptoKey;
  publicKey: JsonWebKey;
}

interface WorkspaceKey {
  key_id: string;
  userId: string;
  publicKey: JsonWebKey;
}

interface TrustedRecipient extends NoteRecipient {
  userId: string;
  fingerprint: string;
  trusted: boolean;
}

interface DisplayNote extends EncryptedNoteRecord {
  clearText: string;
}

const DATABASE = 'switchboard-e2ee';

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('keys');
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error || new Error('Could not open local key storage'));
  });
}

function identityStorageKey(workspace: string, userId: string, deviceId: string): string {
  return `${workspace}:${userId}:${deviceId}`;
}

async function readIdentity(key: string): Promise<LocalIdentity | undefined> {
  const database = await openKeyDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('keys', 'readonly');
    const request = transaction.objectStore('keys').get(key) as IDBRequest<LocalIdentity | undefined>;
    request.onsuccess = () => {
      database.close();
      resolve(request.result);
    };
    request.onerror = () => {
      database.close();
      reject(request.error || new Error('Could not read the local encryption key'));
    };
  });
}

async function storeIdentity(key: string, identity: LocalIdentity): Promise<void> {
  const database = await openKeyDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('keys', 'readwrite');
    transaction.objectStore('keys').put(identity, key);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error('Could not save the local encryption key'));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error('Local encryption-key storage was aborted'));
    };
  });
}

async function responseJson<T>(response: Response): Promise<T & { error?: string }> {
  return response.json() as Promise<T & { error?: string }>;
}

export function NotesPanel({
  workspace,
  contact,
  userId,
}: {
  workspace: string;
  contact: string;
  userId: string;
}) {
  const [deviceId, setDeviceId] = useState('');
  const [identity, setIdentity] = useState<LocalIdentity>();
  const [recipients, setRecipients] = useState<NoteRecipient[]>([]);
  const [trustedRecipients, setTrustedRecipients] = useState<TrustedRecipient[]>([]);
  const [notes, setNotes] = useState<DisplayNote[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [keyRefresh, setKeyRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      const localStorageKey = `switchboard-note-device:${workspace}:${userId}`;
      const storedId = localStorage.getItem(localStorageKey);
      const currentDeviceId = storedId || crypto.randomUUID().replace(/-/g, '');
      if (!storedId) localStorage.setItem(localStorageKey, currentDeviceId);
      const localKey = await readIdentity(identityStorageKey(workspace, userId, currentDeviceId));
      if (!active) return;
      setDeviceId(currentDeviceId);
      setIdentity(localKey);
      setLoading(false);
    })().catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : 'Could not load local encryption keys');
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [workspace, userId]);

  useEffect(() => {
    if (!identity || !deviceId) return;
    let active = true;
    setLoading(true);
    setError('');
    void (async () => {
      const keyResponse = await fetch('/api/notes/keys', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace,
          device_id: deviceId,
          public_key: identity.publicKey,
        }),
      });
      const registered = await responseJson<{ key_id: string }>(keyResponse);
      if (!keyResponse.ok) throw new Error(registered.error || 'Could not register this device key');
      const keysResponse = await fetch(`/api/notes/keys?workspace=${encodeURIComponent(workspace)}`, {
        credentials: 'same-origin',
      });
      const keyList = await responseJson<{ keys: WorkspaceKey[] }>(keysResponse);
      if (!keysResponse.ok) throw new Error(keyList.error || 'Could not load workspace encryption keys');
      const localFingerprint = await fingerprintKey(identity.publicKey);
      const availableRecipients = await Promise.all(keyList.keys.map(async (key) => {
        const fingerprint = await fingerprintKey(key.publicKey);
        const isLocalKey = key.key_id === registered.key_id;
        if (isLocalKey && fingerprint !== localFingerprint) {
          throw new Error('The server returned a different public key for this device.');
        }
        const trustKey = `switchboard-note-fingerprint:${workspace}:${key.key_id}`;
        const pinned = localStorage.getItem(trustKey);
        if (isLocalKey && !pinned) localStorage.setItem(trustKey, fingerprint);
        return {
          key_id: key.key_id,
          public_key: key.publicKey,
          userId: key.userId,
          fingerprint,
          trusted: isLocalKey || pinned === fingerprint,
        };
      }));
      const notesResponse = await fetch(
        `/api/conversations/${encodeURIComponent(contact)}/notes?workspace=${encodeURIComponent(workspace)}`,
        { credentials: 'same-origin' },
      );
      const noteList = await responseJson<{ items: EncryptedNoteRecord[] }>(notesResponse);
      if (!notesResponse.ok) throw new Error(noteList.error || 'Could not load private notes');
      const decrypted = await Promise.all(noteList.items.map(async (note) => {
        const clearText = await decryptNote(note, registered.key_id, identity.privateKey);
        return {
          ...note,
          clearText: clearText ?? 'This note was not encrypted for this device.',
        };
      }));
      if (!active) return;
      setRecipients(availableRecipients);
      setTrustedRecipients(availableRecipients);
      setNotes(decrypted);
    })().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Could not load private notes');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [workspace, contact, deviceId, identity, keyRefresh]);

  const trustRecipient = (recipient: TrustedRecipient) => {
    localStorage.setItem(
      `switchboard-note-fingerprint:${workspace}:${recipient.key_id}`,
      recipient.fingerprint,
    );
    setTrustedRecipients((current) => current.map((item) =>
      item.key_id === recipient.key_id ? { ...item, trusted: true } : item,
    ));
    setRecipients((current) => current.map((item) =>
      item.key_id === recipient.key_id ? { ...item, trusted: true } : item,
    ));
  };

  const setupKeys = async () => {
    setBusy(true);
    setError('');
    try {
      const generated = await generateNoteKeys();
      const value = { privateKey: generated.privateKey, publicKey: generated.publicKey };
      await storeIdentity(identityStorageKey(workspace, userId, deviceId), value);
      setIdentity(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create encryption keys');
    } finally {
      setBusy(false);
    }
  };

  const saveNote = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.trim() || !identity || recipients.length === 0) return;
    if (trustedRecipients.some((recipient) => !recipient.trusted)) {
      setError('Verify each public-key fingerprint with its agent through a separate trusted channel.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const encrypted = await encryptNote(draft.trim(), recipients);
      const response = await fetch(`/api/conversations/${encodeURIComponent(contact)}/notes`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, ...encrypted }),
      });
      const result = await responseJson<{ note: EncryptedNoteRecord }>(response);
      if (!response.ok) throw new Error(result.error || 'Could not save encrypted note');
      const clearText = await decryptNote(result.note, `${userId}:${deviceId}`, identity.privateKey);
      setNotes((current) => [{ ...result.note, clearText: clearText || draft.trim() }, ...current]);
      setDraft('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save encrypted note');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="notes-panel" aria-label="End-to-end encrypted private notes">
      <header className="notes-heading">
        <div>
          <strong>Private notes</strong>
          <span>End-to-end encrypted · {recipients.length} enrolled device(s)</span>
        </div>
        {identity && <button className="notes-refresh" onClick={() => setKeyRefresh((current) => current + 1)}>Refresh keys</button>}
      </header>
      {loading ? <p className="notes-empty">Loading encrypted notes…</p> : !identity ? (
        <div className="notes-enroll">
          <p>Set up an encryption key on this browser to read or leave private notes.</p>
          <button className="secondary-button" disabled={busy || !deviceId} onClick={() => void setupKeys()}>
            {busy ? 'Setting up…' : 'Set up encrypted notes'}
          </button>
        </div>
      ) : (
        <>
          {new Set(recipients.map((recipient) => recipient.key_id.split(':')[0])).size < 2 && (
            <p className="notes-enroll">
              At least one other agent must enroll a device before notes can be shared.
            </p>
          )}
          {trustedRecipients.map((recipient) => (
            <div className="notes-key" key={recipient.key_id}>
              <span>{recipient.userId}</span>
              <code>{recipient.fingerprint.match(/.{1,4}/g)?.join(' ')}</code>
              {recipient.trusted ? <small>verified</small> : (
                <button onClick={() => trustRecipient(recipient)}>
                  I verified this fingerprint out-of-band
                </button>
              )}
            </div>
          ))}
          <div className="notes-list">
            {notes.length === 0 ? <p className="notes-empty">No private notes yet.</p> : notes.map((note) => (
              <article className="private-note" key={note.id}>
                <p>{note.clearText}</p>
                <small>{note.author} · {new Date(note.createdAt).toLocaleString()}</small>
              </article>
            ))}
          </div>
          <form className="notes-form" onSubmit={(event) => void saveNote(event)}>
            <textarea value={draft} maxLength={10_000} rows={2} placeholder="Write an encrypted note for enrolled agents…"
              onChange={(event) => setDraft(event.target.value)} aria-label="Private note" />
            <button className="secondary-button" disabled={busy || !draft.trim() || new Set(recipients.map((recipient) => recipient.key_id.split(':')[0])).size < 2 || trustedRecipients.some((recipient) => !recipient.trusted)}>
              {busy ? 'Encrypting…' : 'Add private note'}
            </button>
          </form>
        </>
      )}
      {error && <p className="notes-error" role="alert">{error}</p>}
    </section>
  );
}
