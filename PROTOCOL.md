# Private-note encryption protocol

## Keys and encryption

Each user/browser/workspace creates an RSA-OAEP 2048-bit key pair using
WebCrypto. The private key is imported as non-extractable and stored in that
browser's IndexedDB. It is never sent to Switchboard. The public JWK is
registered for the user's device and workspace.

For each note, the browser generates a fresh 256-bit AES key and 96-bit
initialization vector. It encrypts the note with AES-256-GCM, then wraps the
AES key separately for every registered workspace device using RSA-OAEP with
SHA-256. A note is accepted only when the envelope covers all registered
devices and at least two distinct workspace users are enrolled.

Agents must compare the displayed SHA-256 public-key fingerprints through a
separate trusted channel before trusting a device key. The browser pins
verified fingerprints locally and blocks note creation when a key is
unverified or changes. The server is a key directory, not the source of
private keys.

## What the server stores

MongoDB stores the public JWKs and device/user identifiers, plus each note's
workspace, contact, author, timestamp, AES-GCM IV and ciphertext, and the
RSA-wrapped AES keys. It never receives note plaintext or private keys. Contact,
workspace, author, timestamps, device membership, and message/note activity
remain visible metadata.

Keys are per browser profile and workspace. A newly enrolled device can read
notes created after its enrollment, not earlier notes. Losing the browser
profile or clearing IndexedDB permanently loses access to notes encrypted for
that key; there is no server recovery or private-key export.

## Limits and attacks not prevented

1. A compromised browser, malicious extension, or same-origin XSS can read
   plaintext while an authorized user opens or writes a note.
2. A recipient can copy or disclose plaintext after decryption.
3. The server can delete, withhold, reorder, or hide notes and public keys.
   Fingerprint verification helps detect key substitution but there is no
   transparency log to prove that every device was listed.

AES-GCM detects ciphertext modification. It does not provide availability,
prevent traffic analysis, or protect visible note metadata.
