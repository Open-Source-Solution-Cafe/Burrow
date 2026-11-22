import { Hono } from 'hono';
import type { BurrowServerPlugin } from '@burrow/sdk';

export const helloPlugin: BurrowServerPlugin = {
  manifest: {
    id: 'hello',
    name: 'Hello Example Plugin',
    version: '0.1.0',
    sdkVersion: '^0.4.0',
    permissions: ['db:own', 'routes:api', 'routes:public', 'events:read'],
    description: 'Reference plugin demonstrating prefixed D1 migrations, events, and API routes.',
  },
  migrations: [
    {
      name: '0001_init.sql',
      sql: `CREATE TABLE IF NOT EXISTS plugin_hello_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_hello_logs_ws ON plugin_hello_logs(workspace_id, created_at);`,
    },
  ],
  setup(ctx) {
    ctx.on('task.created', async (payload) => {
      await ctx.db.execute(
        'INSERT INTO plugin_hello_logs (id, workspace_id, event_name, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
        [crypto.randomUUID(), payload.workspaceId, 'task.created', payload.cardId, Date.now()],
      );
    });

    ctx.on('notepad.saved', async (payload) => {
      await ctx.db.execute(
        'INSERT INTO plugin_hello_logs (id, workspace_id, event_name, target_id, created_at) VALUES (?, ?, ?, ?, ?)',
        [crypto.randomUUID(), payload.workspaceId, 'notepad.saved', payload.notepadId, Date.now()],
      );
    });

    const router = new Hono();
    router.get('/ping', (c) => c.json({ ok: true, plugin: 'hello', prefix: ctx.db.prefix }));
    router.get(
      '/workspaces/:wid/logs',
      ctx.middleware.requireIdentity as any,
      ctx.middleware.requireWorkspace as any,
      async (c) => {
        const wid = c.req.param('wid');
        const rows = await ctx.db.query<{
          id: string;
          workspace_id: string;
          event_name: string;
          target_id: string;
          created_at: number;
        }>(
          'SELECT id, workspace_id, event_name, target_id, created_at FROM plugin_hello_logs WHERE workspace_id = ? ORDER BY created_at ASC',
          [wid],
        );
        return c.json({ logs: rows });
      },
    );

    ctx.route(router, { public: true });
  },
};
