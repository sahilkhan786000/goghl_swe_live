import { useEffect, useState } from 'react';

type Billing = {
  status: 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled';
  seats: number;
  can_send: boolean;
  action_url?: string;
};

type BillingConfig = { publishable_key: string; url: string };

async function readJson<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

export function BillingPanel({
  workspace,
  name,
  email,
}: {
  workspace: string;
  name?: string;
  email?: string;
}) {
  const [open, setOpen] = useState(false);
  const [billing, setBilling] = useState<Billing>();
  const [seats, setSeats] = useState(1);
  const [number, setNumber] = useState('');
  const [expMonth, setExpMonth] = useState('');
  const [expYear, setExpYear] = useState('');
  const [cvc, setCvc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    const response = await fetch(`/api/billing?workspace=${encodeURIComponent(workspace)}`, {
      credentials: 'same-origin',
    });
    const body = await readJson<Billing & { error?: string }>(response);
    if (!response.ok) throw new Error(body.error || 'Could not load billing');
    setBilling(body);
    setSeats(Math.max(1, body.seats || 1));
  };

  useEffect(() => {
    if (!open) return;
    setError('');
    void load().catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Could not load billing');
    });
  }, [open, workspace]);

  const submitSubscription = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const configResponse = await fetch(`/api/billing/config?workspace=${encodeURIComponent(workspace)}`, {
        credentials: 'same-origin',
      });
      const provider = await readJson<BillingConfig & { error?: string }>(configResponse);
      if (!configResponse.ok) throw new Error(provider.error || 'Could not initialize payment');

      const tokenResponse = await fetch(`${provider.url.replace(/\/+$/, '')}/v1/tokens`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${provider.publishable_key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          card: {
            number,
            exp_month: Number(expMonth),
            exp_year: Number(expYear),
            cvc,
          },
        }),
      });
      const token = await readJson<{ id?: string; error?: { message?: string; code?: string } }>(tokenResponse);
      if (!tokenResponse.ok || !token.id) {
        throw new Error(token.error?.message || token.error?.code || 'Card could not be tokenized');
      }

      setNumber('');
      setCvc('');
      const response = await fetch('/api/billing/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, seats, token: token.id }),
      });
      const result = await readJson<Billing & { error?: string }>(response);
      setBilling(result);
      if (response.status === 402) {
        if (!result.status) await load();
        setError(result.error || 'The payment needs attention.');
      } else if (!response.ok) {
        throw new Error(result.error || 'Could not start the subscription');
      } else {
        setNotice(result.status === 'active' ? 'Subscription active.' : 'Payment submitted.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Payment could not be completed');
    } finally {
      setBusy(false);
    }
  };

  const changeSeatCount = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/billing/seats', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, seats }),
      });
      const body = await readJson<Billing & { error?: string }>(response);
      if (!response.ok) throw new Error(body.error || 'Could not update seats');
      setBilling(body);
      setNotice('Seat count updated. Any reduction is credited on the next invoice.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update seats');
    } finally {
      setBusy(false);
    }
  };

  const description: Record<Billing['status'], string> = {
    none: 'Free trial — no subscription yet. You can still send messages.',
    incomplete: 'Payment is incomplete. Sending is paused until payment is confirmed.',
    active: 'Subscription active.',
    past_due: 'Payment is being retried. Sending remains available during the retry period.',
    canceled: 'Subscription canceled. The inbox is readable, but sending is paused.',
  };

  return (
    <>
      <button className="nav-item billing-trigger" onClick={() => setOpen(true)}>
        <span className="nav-icon" aria-hidden="true">$</span>
        <span>Workspace billing</span>
      </button>
      {open && (
        <div className="billing-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <section className="billing-dialog" role="dialog" aria-modal="true" aria-labelledby="billing-title">
            <header className="billing-dialog-header">
              <div>
                <p className="eyebrow">WORKSPACE SETTINGS</p>
                <h2 id="billing-title">Billing</h2>
                <span>{workspace.replace('ws_', '')}</span>
              </div>
              <button className="icon-button" aria-label="Close billing" onClick={() => setOpen(false)}>×</button>
            </header>
            {billing ? (
              <>
                <div className={`billing-status billing-${billing.status}`}>
                  <strong>{billing.status.replace('_', ' ')}</strong>
                  <p>{description[billing.status]}</p>
                  {billing.action_url && (
                    <a href={billing.action_url} target="_blank" rel="noreferrer">Continue bank approval</a>
                  )}
                </div>
                {(billing.status === 'active' || billing.status === 'past_due') && (
                  <form className="billing-form" onSubmit={(event) => void changeSeatCount(event)}>
                    <label>
                      Seats
                      <input type="number" min="1" max="500" required value={seats}
                        onChange={(event) => setSeats(Number(event.target.value))} />
                    </label>
                    <p className="billing-help">$12 per seat every 30 days. Seat increases are charged pro rata; reductions become next-invoice credit.</p>
                    <button className="primary-button" disabled={busy}>Update seats</button>
                  </form>
                )}
                {(billing.status === 'none' || billing.status === 'incomplete' || billing.status === 'canceled') && (
                  <form className="billing-form" onSubmit={(event) => void submitSubscription(event)}>
                    <label>
                      Seats
                      <input type="number" min="1" max="500" required value={seats}
                        onChange={(event) => setSeats(Number(event.target.value))} />
                    </label>
                    <label>
                      Card number
                      <input autoComplete="cc-number" inputMode="numeric" required value={number}
                        onChange={(event) => setNumber(event.target.value)} />
                    </label>
                    <div className="billing-card-row">
                      <label>
                        Expiry month
                        <input autoComplete="cc-exp-month" inputMode="numeric" min="1" max="12"
                          required value={expMonth} onChange={(event) => setExpMonth(event.target.value)} />
                      </label>
                      <label>
                        Expiry year
                        <input autoComplete="cc-exp-year" inputMode="numeric" required
                          value={expYear} onChange={(event) => setExpYear(event.target.value)} />
                      </label>
                      <label>
                        CVC
                        <input autoComplete="cc-csc" inputMode="numeric" required value={cvc}
                          onChange={(event) => setCvc(event.target.value)} />
                      </label>
                    </div>
                    <p className="billing-help">Card details are tokenized directly by Paybox and are not sent to Switchboard.</p>
                    <button className="primary-button" disabled={busy}>
                      {busy ? 'Processing…' : billing.status === 'none' ? 'Start subscription' : 'Try payment again'}
                    </button>
                  </form>
                )}
              </>
            ) : <p className="billing-help">Loading billing…</p>}
            {notice && <p className="billing-notice" role="status">{notice}</p>}
            {error && <p className="billing-error" role="alert">{error}</p>}
            <button className="billing-refresh" disabled={busy} onClick={() => {
              setError('');
              void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Could not refresh billing'));
            }}>Refresh billing status</button>
            <small className="billing-identity">Managed by {name || email || 'workspace admin'}</small>
          </section>
        </div>
      )}
    </>
  );
}
