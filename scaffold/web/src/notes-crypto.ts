export interface NoteRecipient {
  key_id: string;
  public_key: JsonWebKey;
}

export interface EncryptedNotePayload {
  iv: string;
  ciphertext: string;
  wrappedKeys: Record<string, string>;
}

export interface EncryptedNoteRecord extends EncryptedNotePayload {
  id: string;
  author: string;
  createdAt: string;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bufferFromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

export async function fingerprintKey(publicKey: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    kty: publicKey.kty,
    n: publicKey.n,
    e: publicKey.e,
    alg: publicKey.alg,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function generateNoteKeys(): Promise<{ privateKey: CryptoKey; publicKey: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  );
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const exportablePrivate = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    exportablePrivate,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
  return { privateKey, publicKey };
}

export async function encryptNote(
  text: string,
  recipients: NoteRecipient[],
): Promise<EncryptedNotePayload> {
  if (recipients.length === 0) throw new Error('No workspace encryption keys are registered');
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(text),
  );
  const wrappedKeys: Record<string, string> = {};
  for (const recipient of recipients) {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      recipient.public_key,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );
    const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawKey);
    wrappedKeys[recipient.key_id] = base64(new Uint8Array(wrapped));
  }
  return {
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(cipherBuffer)),
    wrappedKeys,
  };
}

export async function decryptNote(
  note: EncryptedNoteRecord,
  keyId: string,
  privateKey: CryptoKey,
): Promise<string | null> {
  const wrapped = note.wrappedKeys[keyId];
  if (!wrapped) return null;
  const rawKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    bufferFromBase64(wrapped),
  );
  const aesKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  const clearText = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bufferFromBase64(note.iv) },
    aesKey,
    bufferFromBase64(note.ciphertext),
  );
  return new TextDecoder().decode(clearText);
}
