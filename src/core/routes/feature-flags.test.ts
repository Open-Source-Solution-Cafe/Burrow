import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createFeatureFlagRoutes, requireFeatureFlag } from './feature-flags';
import { DEFAULT_FEATURE_FLAGS, parseFeatureFlagsEnv, resolveFeatureFlags } from '../../shared/featureFlags';

describe('Feature Flags (Milestone 0)', () => {
  it('defaults all new major features to dormant (false)', () => {
    expect(DEFAULT_FEATURE_FLAGS).toEqual({
      workspaceExport: false,
      notionImport: false,
      publicSharing: false,
      instanceMigration: false,
    });
  });

  it('parses FEATURE_FLAGS from comma-separated or JSON env strings', () => {
    expect(parseFeatureFlagsEnv('workspaceExport=true,publicSharing=false,unknown=true')).toEqual({
      workspaceExport: true,
      publicSharing: false,
    });
    expect(parseFeatureFlagsEnv('{"notionImport":true,"instanceMigration":true}')).toEqual({
      notionImport: true,
      instanceMigration: true,
    });
  });

  it('applies policy overrides over workspace and env flags', () => {
    expect(
      resolveFeatureFlags({
        envFlags: { workspaceExport: true },
        workspaceFlags: { publicSharing: true, instanceMigration: true },
        policyFlags: { publicSharing: false },
      }),
    ).toEqual({
      workspaceExport: true,
      notionImport: false,
      publicSharing: false,
      instanceMigration: true,
    });
  });

  it('blocks flagged routes when disabled and allows them when enabled', async () => {
    let storedFlags: Record<string, boolean> = {};
    const workspaces = {
      getFeatureFlags: vi.fn(async () => storedFlags),
      updateFeatureFlags: vi.fn(async (_wid: string, _uid: string, patch: Record<string, boolean>) => {
        storedFlags = { ...storedFlags, ...patch };
        return storedFlags;
      }),
    } as any;

    const members = {
      findByUserId: vi.fn(async (_wid: string, uid: string) =>
        uid === 'owner-1'
          ? { workspaceId: 'ws-1', userId: 'owner-1', role: 'owner' }
          : { workspaceId: 'ws-1', userId: 'editor-1', role: 'editor' },
      ),
    } as any;

    const app = new Hono<any>();
    app.use('*', async (c, next) => {
      c.set('identity', { userId: c.req.header('x-user') || 'owner-1' });
      await next();
    });
    app.route('/api/workspaces', createFeatureFlagRoutes({ workspaces, members }));
    app.get(
      '/api/workspaces/:wid/gated-export',
      async (c, next) => {
        c.set('workspaceId', c.req.param('wid'));
        await next();
      },
      requireFeatureFlag('workspaceExport', { workspaces }),
      (c) => c.json({ ok: true }),
    );
    app.onError((err: any, c) => c.json({ error: { code: err.code || 'err', message: err.message } }, err.status || 500));

    // Initially dormant -> 404
    const blockedRes = await app.request('/api/workspaces/ws-1/gated-export');
    expect(blockedRes.status).toBe(404);

    // Non-owner cannot toggle
    const editorPatch = await app.request('/api/workspaces/ws-1/feature-flags', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user': 'editor-1' },
      body: JSON.stringify({ workspaceExport: true }),
    });
    expect(editorPatch.status).toBe(403);

    // Owner enables flag -> 200 and route unlocks
    const ownerPatch = await app.request('/api/workspaces/ws-1/feature-flags', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-user': 'owner-1' },
      body: JSON.stringify({ workspaceExport: true }),
    });
    expect(ownerPatch.status).toBe(200);
    const body = (await ownerPatch.json()) as any;
    expect(body.flags.workspaceExport).toBe(true);

    const allowedRes = await app.request('/api/workspaces/ws-1/gated-export');
    expect(allowedRes.status).toBe(200);
  });
});
