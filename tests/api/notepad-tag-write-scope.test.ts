import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createCoreApp } from '../../src/core/app';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { createWorkerApp } from '../../src/worker';
import { getAccountWorkspaceScope } from './account-scope';

it('denies note and tag writes when editor membership changes before the guarded repository command', async () => {
  const request = (path: string, cookie = '', method = 'GET', body?: unknown) => {
    const headers = new Headers();
    if (cookie) headers.set('Cookie', cookie);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return app.request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  };
  const signup = await createWorkerApp(env).request('http://localhost/api/auth/sign-up/email', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `note-tag-${crypto.randomUUID()}@example.test`, name: 'Write owner', password: 'password123', bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token' }),
  }, env);
  expect(signup.status).toBe(200);
  const cookie = signup.headers.get('set-cookie')!;
  const workerApp = createWorkerApp(env);
  const auth = await getAccountWorkspaceScope((path) => workerApp.request(`http://localhost${path}`, { headers: { Cookie: cookie } }, env));
  const infrastructure = createD1Infrastructure(createDb(env.DB), env);
  const app = createCoreApp(infrastructure);
  const noteResponse = await request(`/api/workspaces/${auth.workspaceId}/projects/${auth.projectId}/notepads`, cookie, 'POST', { title: 'Original note' });
  expect(noteResponse.status).toBe(201);
  const note = await noteResponse.json() as { id: string };
  const tagResponse = await request(`/api/workspaces/${auth.workspaceId}/projects/${auth.projectId}/tags`, cookie, 'POST', { name: 'Original tag' });
  expect(tagResponse.status).toBe(201);
  const tag = await tagResponse.json() as { id: string };
  const demote = async () => env.DB.prepare('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?').bind('viewer', auth.workspaceId, auth.userId).run();
  const originalUpdate = infrastructure.repositories.notepads.update.bind(infrastructure.repositories.notepads);
  infrastructure.repositories.notepads.update = async (...args) => { await demote(); return originalUpdate(...args); };
  const noteWrite = await request(`/api/workspaces/${auth.workspaceId}/projects/${auth.projectId}/notepads/${note.id}`, cookie, 'PATCH', { title: 'Must not save' });
  // A failed guarded write is intentionally indistinguishable from a missing
  // scoped resource after the actor is demoted.
  expect(noteWrite.status).toBe(404);
  expect(await env.DB.prepare('SELECT title FROM notepads WHERE id = ?').bind(note.id).first()).toMatchObject({ title: 'Original note' });
  infrastructure.repositories.notepads.update = originalUpdate;
  await env.DB.prepare('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?').bind('editor', auth.workspaceId, auth.userId).run();
  const originalTagUpdate = infrastructure.repositories.tags.updateGuarded.bind(infrastructure.repositories.tags);
  infrastructure.repositories.tags.updateGuarded = async (...args) => { await demote(); return originalTagUpdate(...args); };
  const tagWrite = await request(`/api/workspaces/${auth.workspaceId}/projects/${auth.projectId}/tags/${tag.id}`, cookie, 'PATCH', { name: 'Must not save' });
  expect(tagWrite.status).toBe(403);
  expect(await env.DB.prepare('SELECT name FROM tags WHERE id = ?').bind(tag.id).first()).toMatchObject({ name: 'Original tag' });
});
