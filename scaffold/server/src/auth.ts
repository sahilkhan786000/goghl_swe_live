import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getRedis } from './redis.js';
import { config } from './config.js';
import type { UserSession, WorkspaceAccess } from './types.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const SESSION_COOKIE = 'switchboard_session';
const STATE_COOKIE = 'switchboard_oauth_state';
const STATE_TTL_SECONDS = 600;

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface TokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

let discoveryCache: OidcDiscovery | undefined;
let jwksCache: ReturnType<typeof createRemoteJWKSet> | undefined;

function issuerBase(): string {
  return config.oidc.issuer.replace(/\/+$/, '');
}

async function getDiscovery(): Promise<OidcDiscovery> {
  if (discoveryCache) return discoveryCache;
  const response = await fetch(`${issuerBase()}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`OIDC discovery returned ${response.status}`);
  const discovery = (await response.json()) as OidcDiscovery;
  if (
    discovery.issuer !== config.oidc.issuer &&
    discovery.issuer !== issuerBase()
  ) {
    throw new Error('OIDC discovery issuer did not match OIDC_ISSUER');
  }
  if (!discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri) {
    throw new Error('OIDC discovery document is missing required endpoints');
  }
  discoveryCache = discovery;
  return discovery;
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function cookieValue(request: { headers: { cookie?: string } }, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

function cookieOptions(request: Request, maxAgeSeconds: number): string {
  const secure = request.secure ? '; Secure' : '';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function expireCookie(response: Response, request: Request, name: string): void {
  response.append(
    'Set-Cookie',
    `${name}=; ${cookieOptions(request, 0)}`,
  );
}

export async function beginLogin(request: Request, response: Response): Promise<void> {
  const discovery = await getDiscovery();
  const state = randomToken();
  const verifier = randomToken(48);
  const nonce = randomToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redis = getRedis();
  await redis.set(
    `switchboard:oauth:${state}`,
    JSON.stringify({ verifier, nonce }),
    'EX',
    STATE_TTL_SECONDS,
  );
  response.append(
    'Set-Cookie',
    `${STATE_COOKIE}=${encodeURIComponent(state)}; ${cookieOptions(request, STATE_TTL_SECONDS)}`,
  );

  const authorize = new URL(discovery.authorization_endpoint);
  authorize.search = new URLSearchParams({
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  response.redirect(302, authorize.toString());
}

function parseWorkspaces(value: unknown): WorkspaceAccess[] {
  if (!Array.isArray(value)) throw new Error('ID token is missing workspace memberships');
  const known = new Set(['ws_acme', 'ws_globex']);
  const access: WorkspaceAccess[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { id?: unknown; role?: unknown };
    if (
      typeof candidate.id === 'string' &&
      known.has(candidate.id) &&
      (candidate.role === 'admin' || candidate.role === 'agent')
    ) {
      access.push({ id: candidate.id, role: candidate.role });
    }
  }
  return access;
}

export async function finishLogin(request: Request, response: Response): Promise<void> {
  const state = typeof request.query.state === 'string' ? request.query.state : '';
  const cookieState = cookieValue(request, STATE_COOKIE);
  expireCookie(response, request, STATE_COOKIE);
  if (!state || !cookieState || state !== cookieState) {
    response.status(400).json({ error: 'invalid_oauth_state' });
    return;
  }

  const redis = getRedis();
  const stateKey = `switchboard:oauth:${state}`;
  const saved = await redis.get(stateKey);
  await redis.del(stateKey);
  if (!saved) {
    response.status(400).json({ error: 'expired_oauth_state' });
    return;
  }
  if (typeof request.query.error === 'string') {
    response.status(400).json({ error: request.query.error });
    return;
  }
  const code = typeof request.query.code === 'string' ? request.query.code : '';
  if (!code) {
    response.status(400).json({ error: 'missing_authorization_code' });
    return;
  }

  const { verifier, nonce } = JSON.parse(saved) as { verifier: string; nonce: string };
  const discovery = await getDiscovery();
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.oidc.redirectUri,
    client_id: config.oidc.clientId,
    client_secret: config.oidc.clientSecret,
    code_verifier: verifier,
  });
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
    signal: AbortSignal.timeout(5000),
  });
  const tokens = (await tokenResponse.json()) as TokenResponse;
  if (!tokenResponse.ok || !tokens.id_token) {
    response.status(401).json({ error: tokens.error || 'token_exchange_failed' });
    return;
  }

  jwksCache ??= createRemoteJWKSet(new URL(discovery.jwks_uri));
  const verified = await jwtVerify(tokens.id_token, jwksCache, {
    issuer: discovery.issuer,
    audience: config.oidc.clientId,
  });
  if (verified.payload.nonce !== nonce || typeof verified.payload.sub !== 'string') {
    response.status(401).json({ error: 'invalid_identity_token' });
    return;
  }

  const session: UserSession = {
    sub: verified.payload.sub,
    name: typeof verified.payload.name === 'string' ? verified.payload.name : undefined,
    email: typeof verified.payload.email === 'string' ? verified.payload.email : undefined,
    workspaces: parseWorkspaces(verified.payload.workspaces),
  };
  const sessionId = randomToken();
  await redis.set(
    `switchboard:session:${sessionId}`,
    JSON.stringify(session),
    'EX',
    SESSION_TTL_SECONDS,
  );
  response.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; ${cookieOptions(request, SESSION_TTL_SECONDS)}`,
  );
  response.redirect(302, config.webOrigin);
}

export async function getSession(request: { headers: { cookie?: string } }): Promise<UserSession | null> {
  const sessionId = cookieValue(request, SESSION_COOKIE);
  if (!sessionId) return null;
  const serialized = await getRedis().get(`switchboard:session:${sessionId}`);
  if (!serialized) return null;
  return JSON.parse(serialized) as UserSession;
}

export async function logout(request: Request, response: Response): Promise<void> {
  const sessionId = cookieValue(request, SESSION_COOKIE);
  if (sessionId) await getRedis().del(`switchboard:session:${sessionId}`);
  expireCookie(response, request, SESSION_COOKIE);
  response.status(204).end();
}

export function workspaceRole(session: UserSession, workspace: string): WorkspaceAccess | undefined {
  return session.workspaces.find((membership) => membership.id === workspace);
}

export { SESSION_COOKIE };
