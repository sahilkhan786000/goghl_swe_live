import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { getSession, workspaceRole } from './auth.js';
import { getRedis } from './redis.js';
import { getCollections } from './store.js';
import type { WorkspaceEvent } from './types.js';

interface SocketClient {
  socket: WebSocket;
  workspace: string;
  replaying: boolean;
  lastSent: number;
  buffered: Map<number, WorkspaceEvent>;
}

const CHANNEL = 'switchboard:workspace-events';
const clients = new Set<SocketClient>();

function sendEvent(client: SocketClient, event: WorkspaceEvent): void {
  if (event.seq <= client.lastSent || client.socket.readyState !== WebSocket.OPEN) return;
  client.socket.send(JSON.stringify(event));
  client.lastSent = event.seq;
}

function broadcast(event: WorkspaceEvent): void {
  for (const client of clients) {
    if (client.workspace !== event.workspace) continue;
    if (client.replaying) client.buffered.set(event.seq, event);
    else sendEvent(client, event);
  }
}

function rejectUpgrade(
  socket: import('node:stream').Duplex,
  status: 401 | 403 | 400 | 500,
  message: string,
): void {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Internal Server Error';
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
}

async function replayEvents(client: SocketClient, after: number): Promise<void> {
  const c = await getCollections();
  const history = await c.workspaceEvents
    .find({ workspace: client.workspace, seq: { $gt: after } })
    .sort({ seq: 1 })
    .toArray();
  for (const event of history) sendEvent(client, event);

  client.replaying = false;
  const pending = Array.from(client.buffered.values()).sort((a, b) => a.seq - b.seq);
  client.buffered.clear();
  for (const event of pending) sendEvent(client, event);
}

export async function startRealtime(server: Server): Promise<void> {
  const subscriber = getRedis().duplicate();
  await subscriber.subscribe(CHANNEL);
  subscriber.on('message', (_channel, payload) => {
    try {
      broadcast(JSON.parse(payload) as WorkspaceEvent);
    } catch (error) {
      console.error('Ignoring malformed realtime notification', error);
    }
  });

  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 400, 'Unknown WebSocket endpoint');
      return;
    }

    void (async () => {
      const workspace = url.searchParams.get('workspace') || '';
      const session = await getSession(request);
      if (!session) {
        rejectUpgrade(socket, 401, 'Authentication required');
        return;
      }
      if (!workspaceRole(session, workspace)) {
        rejectUpgrade(socket, 403, 'Workspace access denied');
        return;
      }
      const afterValue = url.searchParams.get('after');
      const after = afterValue === null ? 0 : Number(afterValue);
      if (!Number.isSafeInteger(after) || after < 0) {
        rejectUpgrade(socket, 400, 'Invalid sequence');
        return;
      }

      sockets.handleUpgrade(request, socket, head, (webSocket) => {
        const client: SocketClient = {
          socket: webSocket,
          workspace,
          replaying: true,
          lastSent: after,
          buffered: new Map(),
        };
        clients.add(client);
        webSocket.once('close', () => clients.delete(client));
        webSocket.once('error', () => clients.delete(client));
        void replayEvents(client, after).catch((error: unknown) => {
          console.error('Could not replay WebSocket events', error);
          webSocket.close(1011, 'Event replay failed');
        });
      });
    })().catch((error: unknown) => {
      console.error('WebSocket authorization failed', error);
      if (!socket.destroyed) rejectUpgrade(socket, 500, 'WebSocket setup failed');
    });
  });
}
