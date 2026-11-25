import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

type Workspace = { id: string; role: 'admin' | 'agent' };
type User = { sub: string; name?: string; email?: string; workspaces: Workspace[] };
type Message = {
  direction: 'inbound' | 'outbound';
  text: string;
  status?: 'queued' | 'sent' | 'delivered' | 'failed';
  createdAt: string;
};
type Conversation = {
  contact: string;
  assignee: string | null;
  state: 'open' | 'closed';
  lastActivityAt: string;
  latestMessage: Message | null;
};
type ConversationDetail = { conversation: Conversation; messages: Message[] };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function useRealtime(workspace: string | undefined): number {
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    if (!workspace) return;
    const storageKey = `switchboard:last-seq:${workspace}`;
    sequence.current = Number(sessionStorage.getItem(storageKey) || 0);
    let active = true;
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retryDelay = 500;

    const connect = () => {
      if (!active) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws?workspace=${encodeURIComponent(workspace)}&after=${sequence.current}`,
      );
      socket.onopen = () => {
        retryDelay = 500;
      };
      socket.onmessage = (event) => {
        try {
          const change = JSON.parse(String(event.data)) as { seq?: number };
          if (typeof change.seq !== 'number' || change.seq <= sequence.current) return;
          sequence.current = change.seq;
          sessionStorage.setItem(storageKey, String(change.seq));
          setRevision((value) => value + 1);
        } catch {
          setRevision((value) => value + 1);
        }
      };
      socket.onclose = () => scheduleReconnect();
      socket.onerror = () => socket?.close();
    };

    const scheduleReconnect = () => {
      if (!active || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, retryDelay);
      retryDelay = Math.min(10_000, retryDelay * 2);
    };

    connect();
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [workspace]);

  return revision;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [workspace, setWorkspace] = useState<string>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedContact, setSelectedContact] = useState<string>();
  const [detail, setDetail] = useState<ConversationDetail>();
  const [filter, setFilter] = useState<'open' | 'closed'>('open');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRealtime(workspace);
  const currentWorkspace = useMemo(
    () => user?.workspaces.find((membership) => membership.id === workspace),
    [user, workspace],
  );

  useEffect(() => {
    let mounted = true;
    request<User>('/api/me')
      .then((me) => {
        if (!mounted) return;
        setUser(me);
        setWorkspace(me.workspaces[0]?.id);
      })
      .catch(() => {
        if (mounted) setUser(null);
      })
      .finally(() => {
        if (mounted) setAuthLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const loadConversations = useCallback(async () => {
    if (!workspace) return;
    try {
      const result = await request<{ items: Conversation[] }>(
        `/api/conversations?workspace=${encodeURIComponent(workspace)}&state=${filter}`,
      );
      setConversations(result.items);
      setError('');
      setSelectedContact((current) =>
        current && result.items.some((item) => item.contact === current)
          ? current
          : result.items[0]?.contact,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load inbox');
    }
  }, [workspace, filter]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations, revision]);

  useEffect(() => {
    if (!workspace || !selectedContact) {
      setDetail(undefined);
      return;
    }
    let mounted = true;
    request<ConversationDetail>(
      `/api/conversations/${encodeURIComponent(selectedContact)}?workspace=${encodeURIComponent(workspace)}`,
    )
      .then((value) => {
        if (mounted) setDetail(value);
      })
      .catch((reason) => {
        if (mounted) setError(reason instanceof Error ? reason.message : 'Could not load conversation');
      });
    return () => {
      mounted = false;
    };
  }, [workspace, selectedContact, revision]);

  const act = async (path: string, body?: unknown) => {
    if (!workspace) return;
    setBusy(true);
    setError('');
    try {
      await request(path, {
        method: 'POST',
        body: JSON.stringify({ ...((body || {}) as object), workspace }),
      });
      await loadConversations();
      if (selectedContact) {
        const updated = await request<ConversationDetail>(
          `/api/conversations/${encodeURIComponent(selectedContact)}?workspace=${encodeURIComponent(workspace)}`,
        );
        setDetail(updated);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The action failed');
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspace || !selectedContact || !draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      await request(
        `/api/conversations/${encodeURIComponent(selectedContact)}/replies?workspace=${encodeURIComponent(workspace)}`,
        { method: 'POST', body: JSON.stringify({ text: draft }) },
      );
      setDraft('');
      const updated = await request<ConversationDetail>(
        `/api/conversations/${encodeURIComponent(selectedContact)}?workspace=${encodeURIComponent(workspace)}`,
      );
      setDetail(updated);
      await loadConversations();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Reply could not be queued');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      setUser(null);
      setWorkspace(undefined);
    }
  };

  if (authLoading) {
    return <main className="screen-state">Loading your workspace…</main>;
  }

  if (!user) {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="brand-mark">S</div>
          <p className="eyebrow">CUSTOMER OPERATIONS</p>
          <h1>Good conversations start here.</h1>
          <p className="muted">Sign in to pick up where your team left off.</p>
          <a className="primary-button login-button" href="/auth/login">
            Continue with your account
          </a>
          <p className="login-footnote">Secure team access · Switchboard Inbox</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark small">S</div>
          <span>switchboard</span>
        </div>
        <label className="field-label" htmlFor="workspace">WORKSPACE</label>
        <select
          id="workspace"
          value={workspace || ''}
          onChange={(event) => {
            setWorkspace(event.target.value);
            setSelectedContact(undefined);
          }}
        >
          {user.workspaces.map((item) => (
            <option key={item.id} value={item.id}>{item.id.replace('ws_', '')}</option>
          ))}
        </select>
        <p className="nav-heading">INBOX</p>
        <button className={`nav-item ${filter === 'open' ? 'active' : ''}`} onClick={() => setFilter('open')}>
          <span className="nav-icon">▤</span> Open conversations
          <span className="nav-count">{conversations.length}</span>
        </button>
        <button className={`nav-item ${filter === 'closed' ? 'active' : ''}`} onClick={() => setFilter('closed')}>
          <span className="nav-icon">✓</span> Closed
        </button>
        <div className="sidebar-bottom">
          <div className="user-card">
            <div className="avatar">{(user.name || user.sub).slice(0, 1).toUpperCase()}</div>
            <div className="user-details">
              <strong>{user.name || user.sub}</strong>
              <span>{currentWorkspace?.role || 'member'}</span>
            </div>
            <button className="icon-button" aria-label="Sign out" onClick={() => void signOut()}>↗</button>
          </div>
        </div>
      </aside>

      <section className="conversation-panel">
        <header className="panel-header">
          <div>
            <p className="eyebrow">TEAM INBOX</p>
            <h1>{filter === 'open' ? 'Open conversations' : 'Closed conversations'}</h1>
          </div>
          <button className="icon-button refresh-button" aria-label="Refresh inbox" onClick={() => void loadConversations()}>↻</button>
        </header>
        <div className="conversation-list">
          {conversations.length === 0 ? (
            <div className="empty-list">
              <div className="empty-icon">✳</div>
              <strong>All caught up</strong>
              <span>New customer messages will appear here.</span>
            </div>
          ) : conversations.map((conversation) => (
            <button
              key={conversation.contact}
              className={`conversation-row ${selectedContact === conversation.contact ? 'selected' : ''}`}
              onClick={() => setSelectedContact(conversation.contact)}
            >
              <div className="avatar contact-avatar">{conversation.contact.slice(-2)}</div>
              <div className="conversation-copy">
                <div className="conversation-topline">
                  <strong>{conversation.contact}</strong>
                  <time>{formatTime(conversation.lastActivityAt)}</time>
                </div>
                <p>{conversation.latestMessage?.text || 'No messages yet'}</p>
                <span className="assignee-label">
                  {conversation.assignee ? `Assigned to ${conversation.assignee}` : 'Unassigned'}
                </span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="chat-panel">
        {detail ? (
          <>
            <header className="chat-header">
              <div className="contact-heading">
                <div className="avatar contact-avatar large-avatar">{detail.conversation.contact.slice(-2)}</div>
                <div>
                  <h2>{detail.conversation.contact}</h2>
                  <span>{detail.conversation.assignee ? `Assigned to ${detail.conversation.assignee}` : 'Unassigned conversation'}</span>
                </div>
              </div>
              <div className="chat-actions">
                {!detail.conversation.assignee && (
                  <button className="secondary-button" disabled={busy} onClick={() => void act(`/api/conversations/${encodeURIComponent(detail.conversation.contact)}/claim`)}>
                    Claim
                  </button>
                )}
                {detail.conversation.state === 'open' ? (
                  <button className="secondary-button" disabled={busy} onClick={() => void act(`/api/conversations/${encodeURIComponent(detail.conversation.contact)}/close`)}>
                    Close conversation
                  </button>
                ) : (
                  <button className="secondary-button" disabled={busy} onClick={() => void act(`/api/conversations/${encodeURIComponent(detail.conversation.contact)}/reopen`)}>
                    Reopen
                  </button>
                )}
              </div>
            </header>
            <div className="message-stream">
              <div className="day-divider"><span>Conversation history</span></div>
              {detail.messages.map((message, index) => (
                <article key={`${message.direction}-${message.createdAt}-${index}`} className={`message-line ${message.direction}`}>
                  <div className="message-content">
                    <div className="message-bubble">{message.text}</div>
                    <div className="message-meta">
                      <time>{formatTime(message.createdAt)}</time>
                      {message.direction === 'outbound' && <span className={`status status-${message.status || 'queued'}`}>{message.status || 'queued'}</span>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {error && <div className="inline-error" role="alert">{error}</div>}
            <form className="composer" onSubmit={(event) => void sendReply(event)}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Write a reply…"
                maxLength={10_000}
                rows={3}
                aria-label="Reply"
              />
              <div className="composer-footer">
                <span>Replies are sent securely through your messaging provider.</span>
                <button className="primary-button send-button" disabled={busy || !draft.trim()}>
                  {busy ? 'Sending…' : 'Send reply'} <span aria-hidden="true">↑</span>
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="empty-conversation">
            <div className="empty-icon">✳</div>
            <h2>Select a conversation</h2>
            <p>Choose a customer from the inbox to read and reply.</p>
            {error && <div className="inline-error" role="alert">{error}</div>}
          </div>
        )}
      </section>
    </main>
  );
}
