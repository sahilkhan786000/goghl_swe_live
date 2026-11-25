import { createHash } from 'node:crypto';
import { config } from './config.js';
import { getCollections } from './store.js';
import type { StoredMessage } from './types.js';

const INDEX = 'switchboard-messages';
const backfilled = new Set<string>();
const backfills = new Map<string, Promise<void>>();
let indexReady: Promise<void> | undefined;

interface SearchHit {
  _id: string;
  _source: {
    contact: string;
    direction: 'inbound' | 'outbound';
    text: string;
    createdAt: string;
  };
}

interface SearchResponse {
  hits: { hits: SearchHit[] };
}

export class SearchUnavailableError extends Error {
  constructor() {
    super('Elasticsearch search is unavailable');
  }
}

function documentId(message: StoredMessage): string {
  const identity = message.direction === 'inbound'
    ? message.providerMessageId
    : message.clientRef;
  return createHash('sha256')
    .update(`${message.workspace}:${message.direction}:${identity || message.createdAt.toISOString()}`)
    .digest('hex');
}

async function elastic(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${config.elasticsearchUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5000),
  });
}

async function ensureIndex(): Promise<void> {
  if (!indexReady) {
    indexReady = (async () => {
      const head = await elastic(`/${INDEX}`, { method: 'HEAD' });
      if (head.ok) return;
      if (head.status !== 404) throw new Error(`Elasticsearch index check failed (${head.status})`);
      const created = await elastic(`/${INDEX}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mappings: {
            properties: {
              workspace: { type: 'keyword' },
              contact: { type: 'keyword' },
              direction: { type: 'keyword' },
              text: { type: 'text' },
              createdAt: { type: 'date' },
            },
          },
        }),
      });
      if (!created.ok) {
        const detail = await created.text();
        if (!(created.status === 400 && detail.includes('resource_already_exists_exception'))) {
          throw new Error(`Elasticsearch index creation failed (${created.status}): ${detail}`);
        }
      }
    })().catch((error: unknown) => {
      indexReady = undefined;
      throw error;
    });
  }
  await indexReady;
}

async function bulkIndex(messages: StoredMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const lines: string[] = [];
  for (const message of messages) {
    lines.push(JSON.stringify({ index: { _index: INDEX, _id: documentId(message) } }));
    lines.push(JSON.stringify({
      workspace: message.workspace,
      contact: message.contact,
      direction: message.direction,
      text: message.text,
      createdAt: message.createdAt.toISOString(),
    }));
  }
  const response = await elastic('/_bulk?refresh=false', {
    method: 'POST',
    headers: { 'content-type': 'application/x-ndjson' },
    body: `${lines.join('\n')}\n`,
  });
  if (!response.ok) throw new Error(`Elasticsearch bulk indexing failed (${response.status}): ${await response.text()}`);
  const result = await response.json() as { errors?: boolean; items?: Array<Record<string, { error?: unknown }>> };
  if (result.errors) {
    const failed = result.items?.find((item) => Object.values(item).some((entry) => entry.error));
    throw new Error(`Elasticsearch rejected a message document: ${JSON.stringify(failed || {})}`);
  }
}

async function backfillWorkspace(workspace: string): Promise<void> {
  const c = await getCollections();
  const cursor = c.messages.find({ workspace }).batchSize(500);
  let batch: StoredMessage[] = [];
  for await (const message of cursor) {
    batch.push(message);
    if (batch.length === 500) {
      await bulkIndex(batch);
      batch = [];
    }
  }
  await bulkIndex(batch);
}

async function ensureWorkspaceIndexed(workspace: string): Promise<void> {
  if (backfilled.has(workspace)) return;
  const current = backfills.get(workspace);
  if (current) return current;
  const work = backfillWorkspace(workspace).then(() => {
    backfilled.add(workspace);
  }).finally(() => {
    backfills.delete(workspace);
  });
  backfills.set(workspace, work);
  return work;
}

export async function indexMessage(message: StoredMessage): Promise<void> {
  await ensureIndex();
  await bulkIndex([message]);
}

export async function searchMessages(
  workspace: string,
  query: string,
  limit = 30,
): Promise<Array<{ id: string; contact: string; direction: 'inbound' | 'outbound'; text: string; createdAt: string }>> {
  try {
    await ensureIndex();
    await ensureWorkspaceIndexed(workspace);
    const response = await elastic(`/${INDEX}/_search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        size: Math.max(1, Math.min(50, Math.floor(limit))),
        query: {
          bool: {
            filter: [{ term: { workspace } }],
            must: [{
              multi_match: {
                query,
                fields: ['text', 'contact'],
                operator: 'and',
              },
            }],
          },
        },
        sort: [{ _score: 'desc' }, { createdAt: 'desc' }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Elasticsearch search failed (${response.status}): ${await response.text()}`);
    }
    const result = await response.json() as SearchResponse;
    return (result.hits?.hits || []).map((hit) => ({
      id: hit._id,
      contact: hit._source.contact,
      direction: hit._source.direction,
      text: hit._source.text,
      createdAt: hit._source.createdAt,
    }));
  } catch (error) {
    console.error('Message search failed', error);
    throw new SearchUnavailableError();
  }
}

export async function resetSearchIndex(): Promise<void> {
  backfilled.clear();
  backfills.clear();
  indexReady = undefined;
  try {
    await ensureIndex();
  } catch (error) {
    console.warn('Elasticsearch unavailable during application reset', error);
    return;
  }
  const response = await elastic(`/${INDEX}/_delete_by_query?conflicts=proceed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: { match_all: {} } }),
  });
  if (!response.ok) throw new Error(`Elasticsearch reset failed (${response.status}): ${await response.text()}`);
}
