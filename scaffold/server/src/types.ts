export type WorkspaceRole = 'admin' | 'agent';

export interface WorkspaceAccess {
  id: string;
  role: WorkspaceRole;
}

export interface UserSession {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceAccess[];
}

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'failed';

export interface Conversation {
  workspace: string;
  contact: string;
  assignee: string | null;
  state: 'open' | 'closed';
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
}

export interface StoredMessage {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  status?: MessageStatus;
  providerMessageId?: string;
  clientRef?: string;
  createdAt: Date;
  occurredAt: Date;
  providerStatusAt?: Date;
  sendState?: 'queued' | 'sending' | 'sent';
  attempts?: number;
  nextAttemptAt?: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  lastError?: string;
}

export interface PigeonEvent {
  id: string;
  type: string;
  workspace?: string;
  occurred_at?: string;
  data?: {
    message_id?: string;
    from?: string;
    text?: string;
    client_ref?: string;
    status?: string;
  };
}

export interface WorkspaceEvent {
  workspace: string;
  seq: number;
  type: string;
  contact: string;
  dedupeKey: string;
  createdAt: Date;
  message_id?: string;
  client_ref?: string;
  status?: string;
  assignee?: string | null;
}

export interface WebhookRecord {
  _id: string;
  event: PigeonEvent;
  status: 'pending' | 'processing' | 'done';
  createdAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  attempts: number;
}
