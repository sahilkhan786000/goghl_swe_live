import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { getRedis } from './redis.js';
import { getCollections } from './store.js';
import type { BillingStatus, UserSession, WorkspaceBilling } from './types.js';

const WORKSPACES = new Set(['ws_acme', 'ws_globex']);
const LOCK_TTL_MS = 30_000;

interface PayboxPayment {
  status?: string;
  next_action?: { url?: string };
}

interface PayboxSubscription {
  id: string;
  customer: string;
  quantity: number;
  status: string;
  latest_invoice?: { payment?: PayboxPayment } | null;
}

interface PayboxCustomer {
  id: string;
  metadata?: Record<string, string>;
}

interface PayboxErrorBody {
  error?: { code?: string; message?: string };
}

export class BillingError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface BillingView {
  status: BillingStatus;
  seats: number;
  can_send: boolean;
  action_url?: string;
}

class PayboxError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function paybox<T>(path: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
  const response = await fetch(`${config.paybox.url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.paybox.secretKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
  });
  const result = await response.json() as T & PayboxErrorBody;
  if (!response.ok) {
    throw new PayboxError(
      response.status,
      result.error?.message || result.error?.code || `Paybox returned ${response.status}`,
    );
  }
  return result;
}

function mapStatus(status: string): Exclude<BillingStatus, 'none'> {
  if (status === 'active' || status === 'past_due' || status === 'canceled') return status;
  if (status === 'incomplete_expired') return 'canceled';
  return 'incomplete';
}

function canSend(status: BillingStatus): boolean {
  return status === 'none' || status === 'active' || status === 'past_due';
}

function toView(record?: WorkspaceBilling | null): BillingView {
  if (!record) return { status: 'none', seats: 0, can_send: true };
  return {
    status: record.status,
    seats: record.seats,
    can_send: record.canSend,
    ...(record.actionUrl ? { action_url: record.actionUrl } : {}),
  };
}

function asBillingError(error: unknown): never {
  if (error instanceof BillingError) throw error;
  if (error instanceof PayboxError) {
    throw new BillingError(error.status === 400 || error.status === 402 ? 402 : 502, error.message);
  }
  throw error;
}

async function withLock<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const key = `switchboard:billing-lock:${workspace}`;
  const lockId = randomUUID();
  const deadline = Date.now() + LOCK_TTL_MS;
  while (Date.now() < deadline) {
    const acquired = await redis.set(key, lockId, 'PX', LOCK_TTL_MS, 'NX');
    if (acquired === 'OK') {
      try {
        return await operation();
      } finally {
        await redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1,
          key,
          lockId,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new BillingError(409, 'billing_update_in_progress');
}

async function persistSubscription(workspace: string, subscription: PayboxSubscription): Promise<WorkspaceBilling> {
  const c = await getCollections();
  const status = mapStatus(subscription.status);
  const record: WorkspaceBilling = {
    workspace,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    status,
    seats: subscription.quantity,
    canSend: canSend(status),
    actionUrl: subscription.latest_invoice?.payment?.next_action?.url,
    updatedAt: new Date(),
  };
  await c.billing.updateOne(
    { workspace },
    { $set: record },
    { upsert: true },
  );
  return record;
}

export async function getBilling(workspace: string): Promise<BillingView> {
  return toView(await (await getCollections()).billing.findOne({ workspace }));
}

export async function workspaceCanSend(workspace: string): Promise<boolean> {
  const record = await (await getCollections()).billing.findOne({ workspace });
  return !record || record.canSend;
}

export async function subscribeWorkspace(
  workspace: string,
  seats: number,
  token: string,
  user: Pick<UserSession, 'sub' | 'name' | 'email'>,
): Promise<BillingView> {
  if (!WORKSPACES.has(workspace)) throw new BillingError(400, 'unknown workspace');
  if (!Number.isInteger(seats) || seats < 1 || seats > 500) {
    throw new BillingError(400, 'seats must be a whole number from 1 to 500');
  }
  if (typeof token !== 'string' || !token.startsWith('tok_')) {
    throw new BillingError(400, 'a Paybox card token is required');
  }
  const fingerprint = createHash('sha256').update(token).digest('hex');
  return withLock(workspace, async () => {
    const c = await getCollections();
    let existing = await c.billing.findOne({ workspace });
    if (existing?.status === 'active' || existing?.status === 'past_due') return toView(existing);
    if (existing?.tokenFingerprint === fingerprint && existing.subscriptionId) {
      try {
        const current = await paybox<PayboxSubscription>(`/v1/subscriptions/${existing.subscriptionId}`);
        return toView(await persistSubscription(workspace, current));
      } catch (error) {
        asBillingError(error);
      }
    }

    try {
      let customerId = existing?.customerId;
      if (!customerId) {
        const customer = await paybox<PayboxCustomer>(
          '/v1/customers',
          'POST',
          {
            name: user.name || user.sub,
            email: user.email,
            metadata: { workspace },
          },
          `switchboard-customer-${workspace}`,
        );
        customerId = customer.id;
        await c.billing.updateOne(
          { workspace },
          {
            $set: {
              workspace,
              customerId,
              status: 'incomplete',
              seats,
              canSend: false,
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        );
      }

      await c.billing.updateOne(
        { workspace },
        {
          $set: {
            workspace,
            customerId,
            status: 'incomplete',
            seats,
            canSend: false,
            tokenFingerprint: fingerprint,
            updatedAt: new Date(),
          },
          $unset: { subscriptionId: '', actionUrl: '' },
        },
        { upsert: true },
      );
      await paybox(
        `/v1/customers/${customerId}/payment_method`,
        'POST',
        { token },
        `switchboard-pm-${workspace}-${fingerprint}`,
      );
      const subscription = await paybox<PayboxSubscription>(
        '/v1/subscriptions',
        'POST',
        { customer: customerId, price: 'price_seat_monthly', quantity: seats },
        `switchboard-subscription-${workspace}-${fingerprint}`,
      );
      const saved = await persistSubscription(workspace, subscription);
      await c.billing.updateOne({ workspace }, { $set: { tokenFingerprint: fingerprint } });
      return toView(saved);
    } catch (error) {
      asBillingError(error);
    }
  });
}

export async function changeSeats(workspace: string, seats: number): Promise<BillingView> {
  if (!WORKSPACES.has(workspace)) throw new BillingError(400, 'unknown workspace');
  if (!Number.isInteger(seats) || seats < 1 || seats > 500) {
    throw new BillingError(400, 'seats must be a whole number from 1 to 500');
  }
  return withLock(workspace, async () => {
    const c = await getCollections();
    const existing = await c.billing.findOne({ workspace });
    if (!existing?.subscriptionId || (existing.status !== 'active' && existing.status !== 'past_due')) {
      throw new BillingError(402, 'an active subscription is required to change seats');
    }
    try {
      const updated = await paybox<PayboxSubscription>(
        `/v1/subscriptions/${existing.subscriptionId}`,
        'POST',
        { quantity: seats },
        `switchboard-seats-${existing.subscriptionId}-${existing.seats}-${seats}-${Date.now()}`,
      );
      return toView(await persistSubscription(workspace, updated));
    } catch (error) {
      asBillingError(error);
    }
  });
}

export async function handlePayboxEvent(event: { type: string; data?: { object?: Record<string, unknown> } }): Promise<void> {
  const object = event.data?.object;
  if (!object) return;
  const subscriptionId = typeof object.id === 'string' && object.object === 'subscription'
    ? object.id
    : typeof object.subscription === 'string'
      ? object.subscription
      : undefined;
  if (!subscriptionId) return;

  const c = await getCollections();
  let record = await c.billing.findOne({ subscriptionId });
  try {
    const subscription = await paybox<PayboxSubscription>(`/v1/subscriptions/${subscriptionId}`);
    if (record) {
      await persistSubscription(record.workspace, subscription);
      return;
    }

    const customer = await paybox<PayboxCustomer>(`/v1/customers/${subscription.customer}`);
    const workspace = customer.metadata?.workspace;
    if (!workspace || !WORKSPACES.has(workspace)) return;
    record = await c.billing.findOne({ workspace });
    if (record?.subscriptionId && record.subscriptionId !== subscriptionId) return;
    await persistSubscription(workspace, subscription);
  } catch (error) {
    asBillingError(error);
  }
}

export async function refreshBilling(workspace: string): Promise<BillingView> {
  const record = await (await getCollections()).billing.findOne({ workspace });
  if (!record?.subscriptionId) return toView(record);
  const current = await paybox<PayboxSubscription>(`/v1/subscriptions/${record.subscriptionId}`);
  return toView(await persistSubscription(workspace, current));
}
