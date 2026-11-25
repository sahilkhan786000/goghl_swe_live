import assert from 'node:assert/strict';
import test from 'node:test';
import { getSession, parseWorkspaces, workspaceRole } from './auth.js';

test('malformed session cookies are treated as unauthenticated', async () => {
  const session = await getSession({
    headers: { cookie: 'switchboard_session=%' },
  });

  assert.equal(session, null);
});

test('workspace claims accept only known workspaces and supported roles', () => {
  assert.deepEqual(
    parseWorkspaces([
      { id: 'ws_acme', role: 'agent' },
      { id: 'ws_globex', role: 'admin' },
      { id: 'ws_unknown', role: 'admin' },
      { id: 'ws_acme', role: 'owner' },
      null,
    ]),
    [
      { id: 'ws_acme', role: 'agent' },
      { id: 'ws_globex', role: 'admin' },
    ],
  );
});

test('workspace authorization requires an exact membership', () => {
  const session = {
    sub: 'u_ben',
    workspaces: [{ id: 'ws_acme', role: 'agent' as const }],
  };

  assert.equal(workspaceRole(session, 'ws_acme')?.role, 'agent');
  assert.equal(workspaceRole(session, 'ws_globex'), undefined);
});
