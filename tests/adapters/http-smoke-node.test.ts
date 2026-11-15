import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { createCoreApp } from '../../src/core/app';
import type { IStorageAdapter } from '../../src/core/adapters/storage';
import type { Infrastructure } from '../../src/core/infrastructure/types';
import { createWorkspacePlan } from '../../src/core/entities/workspace';
import { openPersistence, type PersistenceFixture } from './node-fixture';

describe.each(['sqlite', 'postgres'] as const)('%s HTTP smoke', (kind) => {
  let fixture: PersistenceFixture;
  let admin: ReturnType<typeof postgres> | undefined;
  let database: string | undefined;

  const insertUser = async (id: string, email: string) => {
    const now = Date.now();
    const fields = kind === 'sqlite' ? '"createdAt", "updatedAt"' : 'created_at, updated_at';
    const timestamp = kind === 'sqlite' ? now : new Date(now).toISOString();
    await fixture.query(
      `INSERT INTO "user" (id, name, email, ${fields}) VALUES (?, ?, ?, ?, ?)`,
      [id, 'Smoke User', email, timestamp, timestamp],
    );
  };

  const createMemoryStorage = (): IStorageAdapter => {
    const objects = new Map<string, { body: Uint8Array; contentType: string }>();
    return {
      async put(key, data, contentType = 'application/octet-stream') {
        objects.set(key, {
          body: data instanceof Uint8Array ? data : new Uint8Array(data),
          contentType,
        });
      },
      async get(key) {
        return objects.get(key) ?? null;
      },
      async delete(key) {
        objects.delete(key);
      },
      async deletePrefix(prefix) {
        for (const k of objects.keys()) {
          if (k.startsWith(prefix)) objects.delete(k);
        }
      },
      async listObjects() {
        return [...objects.keys()].sort();
      },
    };
  };

  beforeEach(async () => {
    let url = inject('postgresTestUrl');
    if (kind === 'postgres') {
      admin = postgres(url, { max: 1, onnotice: () => {} });
      database = `http_smoke_${crypto.randomUUID().replaceAll('-', '')}`;
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      const testUrl = new URL(url);
      testUrl.pathname = `/${database}`;
      url = testUrl.toString();
    }
    fixture = await openPersistence(kind, url);
  });

  afterEach(async () => {
    await fixture?.close();
    if (admin && database) await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    await admin?.end();
  });

  it('serves health, auth config, bootstrap claim recovery, slim notepad list, and owner update guard (#012, #014, #016)', async () => {
    const users = new Map<string, { userId: string; email: string; name: string }>();
    const bootstrapToken = 'smoke-bootstrap-token-123456';

    const infra: Infrastructure = {
      repositories: {
        workspaces: fixture.workspaces,
        projects: fixture.projects,
        boards: fixture.boards,
        cards: fixture.cards,
        notepads: fixture.notepads,
        projectFiles: fixture.projectFiles,
        tags: fixture.tags,
        notifications: fixture.notifications,
        members: fixture.createMembers(),
        invites: fixture.invites,
      },
      storage: createMemoryStorage(),
      search: fixture.search,
      locks: fixture.locks,
      auth: {
        async getSession(headers) {
          const token = headers.get('x-smoke-user');
          return token ? (users.get(token) ?? null) : null;
        },
        async handler() {
          return new Response('Not implemented', { status: 404 });
        },
      },
      email: { provider: 'console', send: async () => ({ id: 'smoke-email-1' }) },
      bootstrapToken,
      env: kind === 'postgres' ? { DATABASE_URL: 'postgres://localhost/burrow' } : {},
    };

    const app = createCoreApp(infra);

    const health = await app.request('http://localhost/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const versionRes = await app.request('http://localhost/api/system/version');
    expect(versionRes.status).toBe(200);
    expect(await versionRes.json()).toMatchObject({
      runtime: kind === 'postgres' ? 'docker-postgres' : 'node-sqlite',
      maxUploadBytes: 100 * 1024 * 1024,
    });

    const authConfig = await app.request('http://localhost/api/auth/config');
    expect(authConfig.status).toBe(200);
    expect(await authConfig.json()).toMatchObject({
      emailPasswordEnabled: true,
      magicLinkEnabled: false,
      oauthProviders: [],
    });

    // Claim bootstrap for a mistyped email and reset it via /api/auth/bootstrap/recover (#012)
    expect(await fixture.workspaces.claimBootstrap('mistyped@example.com')).toBe(true);
    const badReset = await app.request('http://localhost/api/auth/bootstrap/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken: 'wrong-token-value', resetClaim: true }),
    });
    expect(badReset.status).toBe(403);

    const goodReset = await app.request('http://localhost/api/auth/bootstrap/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken, resetClaim: true }),
    });
    expect(goodReset.status).toBe(200);
    expect(await goodReset.json()).toEqual({ ok: true, reset: true });

    // Complete bootstrap as owner and create second member
    const ownerId = crypto.randomUUID();
    const otherOwnerId = crypto.randomUUID();
    await insertUser(ownerId, 'owner@example.com');
    await insertUser(otherOwnerId, 'other@example.com');
    users.set('owner', { userId: ownerId, email: 'owner@example.com', name: 'Owner' });
    users.set('other', { userId: otherOwnerId, email: 'other@example.com', name: 'Other' });

    expect(await fixture.workspaces.claimBootstrap('owner@example.com')).toBe(true);
    const completed = await fixture.workspaces.completeBootstrap(
      'owner@example.com',
      createWorkspacePlan({
        userId: ownerId,
        name: 'Smoke Workspace',
        workspaceId: 'ws-smoke-1',
        projectId: 'proj-smoke-1',
        notepadId: 'note-smoke-1',
        now: Date.now(),
      }),
    );
    expect(completed?.id).toBe('ws-smoke-1');

    // Resetting claim after workspace creation must fail with 409
    const postCompleteReset = await app.request('http://localhost/api/auth/bootstrap/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bootstrapToken, resetClaim: true }),
    });
    expect(postCompleteReset.status).toBe(409);

    // Non-instance-owner cannot trigger /api/system/update (#006)
    const deniedUpdate = await app.request('http://localhost/api/system/update', {
      method: 'POST',
      headers: { 'x-smoke-user': 'other' },
    });
    expect(deniedUpdate.status).toBe(403);

    // Instance owner passes admin guard and reaches manual update fallback when webhook is unset
    const ownerUpdate = await app.request('http://localhost/api/system/update', {
      method: 'POST',
      headers: { 'x-smoke-user': 'owner' },
    });
    expect(ownerUpdate.status).toBe(200);
    expect(await ownerUpdate.json()).toMatchObject({ ok: true, status: 'manual' });

    // Save non-empty notepad body and verify list endpoint omits heavy content (#016)
    const heavyBlocks = JSON.stringify([
      { type: 'paragraph', content: [{ type: 'text', text: 'Large saved content body' }] },
    ]);
    const saveContent = await app.request(
      'http://localhost/api/workspaces/ws-smoke-1/projects/proj-smoke-1/notepads/note-smoke-1/content',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-smoke-user': 'owner' },
        body: JSON.stringify({ content: heavyBlocks, baseVersion: 1, clientId: 'smoke-client' }),
      },
    );
    expect(saveContent.status).toBe(200);

    const repoListed = await fixture.notepads.listByProject({
      workspaceId: 'ws-smoke-1',
      projectId: 'proj-smoke-1',
    });
    expect(repoListed).toHaveLength(1);
    expect(repoListed[0]?.content).toBe('[]');

    const listRes = await app.request(
      'http://localhost/api/workspaces/ws-smoke-1/projects/proj-smoke-1/notepads',
      { headers: { 'x-smoke-user': 'owner' } },
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as Array<{ id: string; content?: string; title: string }>;
    expect(listed.length).toBe(1);
    expect(listed[0]?.content).toBeUndefined();

    const getRes = await app.request(
      'http://localhost/api/workspaces/ws-smoke-1/projects/proj-smoke-1/notepads/note-smoke-1',
      { headers: { 'x-smoke-user': 'owner' } },
    );
    expect(getRes.status).toBe(200);
    const detail = (await getRes.json()) as { content: string };
    expect(detail.content).toContain('Large saved content body');
  });
});
