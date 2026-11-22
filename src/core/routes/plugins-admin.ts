import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env } from '../app';
import type { IWorkspaceRepository } from '../infrastructure/types';
import type { PluginRuntimeRegistry } from '../plugins/runtime-state';

const toggleSchema = z.object({
  enabled: z.boolean(),
  consentAccepted: z.boolean().optional(),
});

export function createPluginAdminRoutes(args: {
  runtimeRegistry: PluginRuntimeRegistry;
  workspaces: IWorkspaceRepository;
}) {
  const { runtimeRegistry, workspaces } = args;
  const route = new Hono<Env>();

  route.get('/', async (c) => {
    const identity = c.get('identity');
    if (!identity) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json({ plugins: runtimeRegistry.listViews() });
  });

  route.post('/:id/toggle', zValidator('json', toggleSchema), async (c) => {
    const identity = c.get('identity');
    if (!identity) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
    }

    const id = c.req.param('id');
    const rec = runtimeRegistry.get(id);
    if (!rec) {
      return c.json({ error: { code: 'not_found', message: `Plugin "${id}" not found` } }, 404);
    }

    if (rec.instanceManaged) {
      return c.json(
        {
          error: {
            code: 'instance_managed',
            message: 'This plugin is managed at the instance level and cannot be toggled here',
          },
        },
        403,
      );
    }

    const isInstanceAdmin = workspaces.isInstanceOwner
      ? await workspaces.isInstanceOwner(identity.userId)
      : false;
    if (!isInstanceAdmin) {
      const owned = await workspaces.listByUser(identity.userId);
      if (!owned.some((ws) => ws.role === 'owner')) {
        return c.json(
          { error: { code: 'forbidden', message: 'Owner privileges required to toggle plugins' } },
          403,
        );
      }
    }

    const body = c.req.valid('json');
    if (body.enabled && !body.consentAccepted) {
      return c.json(
        {
          error: {
            code: 'consent_required',
            message: 'Enabling a plugin requires confirming its declared capability consent summary',
          },
        },
        400,
      );
    }

    try {
      const updated = runtimeRegistry.setEnabled(id, body.enabled);
      return c.json({ ok: true, plugin: updated ? runtimeRegistry.listViews().find((p) => p.id === id) : null });
    } catch (err) {
      return c.json(
        {
          error: {
            code: 'kill_switched',
            message: err instanceof Error ? err.message : 'Plugin is kill-switched',
          },
        },
        409,
      );
    }
  });

  return route;
}
