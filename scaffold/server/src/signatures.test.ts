import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyWebhookSignature } from './signatures.js';

test('webhook signatures bind the timestamp and raw body', () => {
  const now = 1_800_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const body = Buffer.from('{"id":"evt_1"}');
  const signature = createHmac('sha256', 'test-secret')
    .update(`${timestamp}.`)
    .update(body)
    .digest('hex');
  const header = `t=${timestamp},v1=${signature}`;

  assert.equal(verifyWebhookSignature(header, body, 'test-secret', now), true);
  assert.equal(verifyWebhookSignature(header, Buffer.from('{"id":"evt_2"}'), 'test-secret', now), false);
  assert.equal(verifyWebhookSignature(header, body, 'test-secret', now + 301_000), false);
  assert.equal(verifyWebhookSignature('bad', body, 'test-secret', now), false);
});
