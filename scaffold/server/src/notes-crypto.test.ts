import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptNote, encryptNote, generateNoteKeys } from '../../web/src/notes-crypto.js';

test('encrypted note content is readable only with a recipient private key', async () => {
  const [recipient, outsider] = await Promise.all([generateNoteKeys(), generateNoteKeys()]);
  const encrypted = await encryptNote('internal handoff', [{
    key_id: 'u_agent:device_123456789012',
    public_key: recipient.publicKey,
  }]);
  const note = {
    id: 'note_1',
    author: 'u_agent',
    createdAt: new Date().toISOString(),
    ...encrypted,
  };

  assert.equal(
    await decryptNote(note, 'u_agent:device_123456789012', recipient.privateKey),
    'internal handoff',
  );
  assert.equal(await decryptNote(note, 'u_other:device_123456789012', outsider.privateKey), null);
});
