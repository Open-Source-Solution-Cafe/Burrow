import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createCoreApp } from '../../src/core/app';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';
import * as t from '../../src/core/adapters/db/d1/schema';
import { getAccountWorkspaceScope } from './account-scope';

it('redacts foreign lock holders on reads, claims, early saves and raced saves', async () => {
  const db = createDb(env.DB);
  const infra = createD1Infrastructure(db, env);
  const app = createCoreApp(infra);
  const signup = await app.request('http://localhost/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Local owner',
      email: 'lock-scope@example.test',
      password: 'password123',
      bootstrapToken: env.BOOTSTRAP_TOKEN,
    }),
  });
  expect(signup.status).toBe(200);
  const headers = { Cookie: signup.headers.get('set-cookie')!, 'Content-Type': 'application/json' };
  const scope = await getAccountWorkspaceScope((path) =>
    app.request(`http://localhost${path}`, { headers }, env),
  );
  const create = await app.request(`http://localhost/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/notepads`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Lock scope' }),
  });
  expect(create.status).toBe(201);
  const { id } = (await create.json()) as { id: string };
  const foreignUser = crypto.randomUUID(),
    foreignWorkspace = crypto.randomUUID();
  const now = Date.now();
  await db.insert(t.user).values({
    id: foreignUser,
    name: 'Foreign private name',
    email: 'foreign-lock@example.test',
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  await db.insert(t.workspaces).values({
    id: foreignWorkspace,
    name: 'Foreign workspace',
    createdBy: foreignUser,
    createdAt: now,
  });
  await infra.repositories.members.create({
    workspaceId: foreignWorkspace,
    userId: foreignUser,
    role: 'owner',
    joinedAt: now,
  });
  await infra.locks.acquire(id, foreignUser, 'foreign-private-client', 60_000);

  const resource = (suffix: string) => `http://localhost/api/workspaces/${scope.workspaceId}/projects/${scope.projectId}/notepads/${id}${suffix}`;
  const read = await app.request(resource(''), { headers });
  expect(read.status).toBe(200);
  const note = (await read.json()) as { lock: Record<string, unknown> };
  expect(note.lock).toEqual({ name: 'Someone', isMe: false, expiresAt: expect.any(Number) });
  const saveRequest = {
    method: 'PUT',
    headers,
    body: JSON.stringify({ content: '[]', baseVersion: 1, clientId: 'request-client' }),
  };
  for (const [url, request] of [
    [
      resource('/lock'),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ clientId: 'request-client' }),
      },
    ],
    [resource('/content'), saveRequest],
  ] as const) {
    const response = await app.request(url, request);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'locked',
        holder: { name: 'Someone', isMe: false },
        expiresAt: expect.any(Number),
      },
    });
  }

  await infra.locks.release(id, 'foreign-private-client', { userId: foreignUser });
  const getLock = infra.repositories.notepads.getLock;
  let raced = false;
  infra.repositories.notepads.getLock = async (projectScope, notepadId) => {
    const lock = await getLock(projectScope, notepadId);
    if (!raced && notepadId === id) {
      raced = true;
      await infra.locks.acquire(id, foreignUser, 'foreign-private-client', 60_000);
    }
    return lock;
  };
  const racedSave = await app.request(resource('/content'), saveRequest);
  expect(racedSave.status).toBe(409);
  expect(await racedSave.json()).toEqual({
    error: {
      code: 'locked',
      holder: { name: 'Someone', isMe: false },
      expiresAt: expect.any(Number),
    },
  });
  expect(await infra.repositories.notepads.findByIdInScope(scope, id)).toMatchObject({
    content: '[]',
    version: 1,
  });
  infra.repositories.notepads.getLock = getLock;

  await infra.locks.release(id, 'foreign-private-client', { userId: foreignUser });
  await infra.locks.acquire(id, scope.userId, 'local-client', 60_000);
  const localRead = await app.request(resource(''), { headers });
  expect(await localRead.json()).toMatchObject({
    lock: {
      userId: scope.userId,
      clientId: 'local-client',
      name: 'Local owner',
      isMe: true,
    },
  });
  const localClaim = await app.request(resource('/lock'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ clientId: 'other-local-client' }),
  });
  expect(localClaim.status).toBe(409);
  expect(await localClaim.json()).toMatchObject({
    error: {
      code: 'locked',
      holder: { userId: scope.userId, name: 'Local owner', isMe: true },
    },
  });
});
