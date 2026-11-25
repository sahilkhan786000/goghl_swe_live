import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookSignature(
  header: string | undefined,
  raw: Buffer,
  secret: string,
  now = Date.now(),
): boolean {
  if (!header) return false;
  const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/i.exec(header);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now / 1000 - timestamp) > 300) return false;
  const expected = createHmac('sha256', secret)
    .update(`${match[1]}.`)
    .update(raw)
    .digest();
  const provided = Buffer.from(match[2], 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
