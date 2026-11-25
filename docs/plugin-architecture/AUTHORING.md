# Burrow Plugin Authoring Guide

This guide describes how to build first-party and community plugins against `@burrow/sdk` without modifying core tables or forking the core Worker or web bundle.

## 1. Architecture & Isolation Contract

1. **Dependencies**: Depend on `@burrow/sdk` (MIT, zero runtime dependencies, types only).
2. **Manifest**: Every plugin provides a `PluginManifest`:
   - `id`: lowercase slug matching `/^[a-z][a-z0-9-]{0,30}$/`.
   - `version`: SemVer (`MAJOR.MINOR.PATCH`).
   - `sdkVersion`: SemVer range supported (for example `^0.4.0`).
   - `permissions`: explicit capability grant list (`db:own`, `routes:api`, `events:read`, `events:before`, `mentions:register`, `cards:register`, `ui:register`, etc.).
3. **Database Ownership (`plugin_<id>_*`)**:
   - Table prefix is derived automatically: `plugin_${id.replace(/-/g, '_')}_`.
   - Plugins may **never** `INSERT`, `UPDATE`, `DELETE`, `ALTER`, or `DROP` core tables directly (`PluginDb` enforces this on every SQL call and migration).
   - Plugins **may** `SELECT`/`JOIN` core tables (`workspaces`, `projects`, `cards`, `notepads`) for read-only scope validation.
   - Foreign keys from plugin tables to core tables should declare `ON DELETE CASCADE` so core deletions never violate integrity.
4. **D1 / SQLite Constraints**:
   - Never emit `BEGIN` / `COMMIT` / `ROLLBACK` or `PRAGMA foreign_keys = OFF`.
   - Use `db.batch([...])` for multi-statement atomicity.
   - Stay under **100 bound parameters per SQL statement**.
   - Keep `setup(ctx)` **synchronous** so Cloudflare Worker startup remains deterministic.

## 2. Server Plugin Anatomy (`BurrowServerPlugin`)

```ts
import { Hono } from 'hono';
import type { BurrowServerPlugin } from '@burrow/sdk';

export const myServerPlugin: BurrowServerPlugin = {
  manifest: {
    id: 'my-plugin',
    version: '0.1.0',
    sdkVersion: '^0.4.0',
    permissions: ['db:own', 'routes:api', 'events:read', 'mentions:register'],
  },
  migrations: [
    {
      name: '0001_init',
      sql: `CREATE TABLE IF NOT EXISTS plugin_my_plugin_items (
        card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
        note TEXT NOT NULL
      );`,
    },
  ],
  setup(ctx) {
    const app = new Hono();
    app.get('/ping', (c) => c.json({ ok: true }));
    ctx.route(app); // mounted at /api/plugins/my-plugin
  },
};
```

## 3. Web Plugin Anatomy (`BurrowWebPlugin`)

Web plugins contribute UI slots without forking `src/web/`:

- `slashCommands`: `{ id, label, contexts: ['notepad' | 'card' | 'quickadd'], execute }` — supports both `insertText` and `openModal`.
- `mentionKinds`: `{ kind: 'plugin:<id>:<type>', group, renderChip? }`.
- `cardTypes`: `{ type, label, renderTileBadge?, renderTileFooter?, renderPanelSection? }`.
- `sidebarPanels`: `{ id, label, icon?, render }`.
- `settingsSections`: `{ id, label, description?, render }`.
- `routes`: `{ path, parent?: 'root' | 'shell' | 'workspace' | 'project', component }`.

> [!NOTE]
> Follow Burrow's **Basalt** design system in all web components: use semantic tokens (`--surface`, `--surface2`, `--line`, `--text`, `--muted`, `--accent`) and `theme-radius-*` helpers; avoid hardcoded `rounded-*`, `shadow-*`, `bg-neutral-*`, or `dark:` utility classes (enforced by `node scripts/check-basalt.mjs`).

## 4. Local Testing

See `packages/plugins/estimation` for a full-stack showcase plugin and `tests/api/plugin-authoring-showcase.test.ts` for Miniflare/D1 integration testing.
