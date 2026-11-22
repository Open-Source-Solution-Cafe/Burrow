import { Hono, type MiddlewareHandler } from 'hono';
import type { BurrowServerPlugin, BurrowWebPlugin, PluginManifest } from '@burrow/sdk';

export const TEMPLATE_MANIFEST: PluginManifest = {
  id: 'example-template',
  name: 'Example Template Plugin',
  version: '0.1.0',
  sdkVersion: '^0.4.0',
  permissions: ['db:own', 'routes:api', 'events:read', 'ui:register'],
  description: 'Starter template demonstrating D1 migrations, routes, events, and web slots.',
};

export const templateServerPlugin: BurrowServerPlugin = {
  manifest: TEMPLATE_MANIFEST,
  migrations: [
    {
      name: '0001_example_init',
      sql: `CREATE TABLE IF NOT EXISTS plugin_example_template_notes (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );`,
    },
  ],
  setup(ctx) {
    const app = new Hono();
    const requireIdentity = ctx.middleware.requireIdentity as MiddlewareHandler;

    app.get('/health', requireIdentity, async (c) => {
      const count = await ctx.db.first<{ total: number }>(
        'SELECT COUNT(*) AS total FROM plugin_example_template_notes',
      );
      return c.json({ ok: true, count: Number(count?.total ?? 0) });
    });

    ctx.route(app);
    ctx.on('task.created', async ({ cardId }) => {
      await ctx.db.execute(
        'INSERT OR IGNORE INTO plugin_example_template_notes (id, card_id, created_at) VALUES (?, ?, ?)',
        [`note_${cardId}`, cardId, Date.now()],
      );
    });
  },
};

export const templateWebPlugin: BurrowWebPlugin = {
  manifest: TEMPLATE_MANIFEST,
  slashCommands: [
    {
      id: 'template-stamp',
      label: 'Template Stamp',
      description: 'Inserts a structured template marker.',
      contexts: ['notepad', 'card', 'quickadd'],
      execute(ctx) {
        ctx.insertText?.('[template]');
      },
    },
  ],
};
