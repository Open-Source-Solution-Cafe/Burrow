import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createCoreApp } from '../../src/core/app';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';

const infrastructure = () => createD1Infrastructure(createDb(env.DB), env);
const request = (app: ReturnType<typeof createCoreApp>, path: string, body?: unknown) =>
  app.request(
    `http://localhost${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
    env,
  );

describe('session resolution failures', () => {
  it('returns a generic 503 and does not continue to account routes when authentication fails', async () => {
    const infra = infrastructure();
    infra.auth.getSession = vi.fn().mockRejectedValue(new Error('private auth failure'));
    infra.auth.handler = vi.fn();
    infra.repositories.workspaces.count = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(createCoreApp(infra), '/api/auth/sign-up/email', {
        email: 'first@example.test',
        name: 'First',
        password: 'password123',
        bootstrapToken: 'token',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: 'session_unavailable', message: 'Unable to verify your session' },
      });
      expect(infra.auth.handler).not.toHaveBeenCalled();
      expect(infra.repositories.workspaces.count).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('isolates account identity from explicit workspace access', async () => {
    const infra = infrastructure();
    infra.auth.getSession = vi
      .fn()
      .mockResolvedValue({ userId: 'account', email: 'a@example.test' });
    infra.repositories.workspaces.completeBootstrap = vi
      .fn()
      .mockResolvedValue({ id: 'workspace' });
    infra.repositories.members.findByUserId = vi.fn().mockResolvedValue({
      workspaceId: 'workspace',
      userId: 'account',
      role: 'viewer',
      joinedAt: 0,
    });
    infra.repositories.projects.listByWorkspace = vi.fn().mockResolvedValue([]);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createCoreApp(infra);
      const response = await request(app, '/api/account');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: { id: 'account' } });
      expect((await request(app, '/api/me')).status).toBe(404);
      const scoped = await request(app, '/api/workspaces/workspace/projects');
      expect(scoped.status).toBe(200);
      expect(scoped.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await scoped.json()).toEqual([]);
      expect(infra.repositories.members.findByUserId).toHaveBeenCalledTimes(1);
      expect(infra.repositories.members.findByUserId).toHaveBeenCalledWith('workspace', 'account');
      const recovery = await request(app, '/api/auth/bootstrap/recover', {
        bootstrapToken: env.BOOTSTRAP_TOKEN,
      });
      expect(recovery.status).toBe(200);
      expect(await recovery.json()).toEqual({ workspaceId: 'workspace' });
      expect(infra.repositories.workspaces.completeBootstrap).toHaveBeenCalledOnce();
      vi.mocked(infra.repositories.members.findByUserId).mockRejectedValue(
        new Error('private scoped failure'),
      );
      const failedScoped = await request(app, '/api/workspaces/workspace/projects');
      expect(failedScoped.status).toBe(503);
      expect(failedScoped.headers.get('Cache-Control')).toBe('private, no-store');
      expect(JSON.stringify(await failedScoped.json())).not.toContain('private scoped failure');
    } finally {
      log.mockRestore();
    }
  });

  it('preserves unauthenticated and membership-free behavior and leaves downstream errors alone', async () => {
    const infra = infrastructure();
    infra.auth.getSession = vi.fn().mockResolvedValue(null);
    const app = createCoreApp(infra);
    expect((await request(app, '/api/account')).status).toBe(401);
    infra.auth.getSession = vi
      .fn()
      .mockResolvedValue({ userId: 'account', email: 'a@example.test' });
    expect((await request(app, '/api/account')).status).toBe(200);
    expect((await request(app, '/api/me')).status).toBe(404);
    expect((await request(app, '/api/workspaces/workspace/projects')).status).toBe(404);
    expect(
      (await request(app, '/api/auth/bootstrap/recover', { bootstrapToken: 'wrong' })).status,
    ).toBe(403);

    infra.repositories.members.findByUserId = vi.fn().mockResolvedValue({
      workspaceId: 'workspace',
      userId: 'account',
      role: 'owner',
      joinedAt: 0,
    });
    infra.repositories.projects.listByWorkspace = vi
      .fn()
      .mockRejectedValue(new Error('downstream failure'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await request(app, '/api/workspaces/workspace/projects')).status).toBe(500);
    } finally {
      log.mockRestore();
    }
  });
});
