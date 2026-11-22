# Burrow Plugin Architecture — Implementation Handoff

**Branch**: `feat/plugin-architecture` (in both repositories)  
**Baseline branches preserved untouched**: `Burrow` `master` (`c26d0ae`), private repo `main` (`d025c14`)

---

## 1. Summary of Implemented Architecture

Burrow now exposes a typed, capability-scoped plugin architecture across both server (Cloudflare Workers + D1) and web (Vite + React + TanStack Router) while keeping public Burrow 100% standalone and clean of commercial/operator logic (`node scripts/check-decoupling.mjs` verified with 0 violations).

### Workspace & Package Split (`Burrow`)
- **`packages/sdk` (`@burrow/sdk`)**: Zero-dependency, types-only contracts (`BurrowServerPlugin`, `BurrowWebPlugin`, `PluginManifest`, `Permission`, `BurrowEventMap`, `PluginDb`, `ServerPluginContext`). License field set to `MIT` (pending legal/owner sign-off in `DECISIONS.md`).
- **`packages/core` (`@burrow/core`)**: Hono app composition (`createCoreApp`), `PluginEventBus` (`onBefore` guards + post-commit `on` via `ExecutionContext.waitUntil`), `MentionSourceRegistry`, `plugin_migrations` ledger/runner, `PluginDb` prefix validator (`plugin_<id>_*`), manifest validator, and `AuthProvider.getPublicConfig()`.
- **`packages/web` (`@burrow/web`)**: `mountBurrowWeb({ plugins })`, `createBurrowRouter(plugins)`, `WebPluginRegistryProvider`, and UI extension slots across slash commands (`NotepadEditor` + `QuickAddCard`), `@` mentions (`plugin:<id>:<type>`), Kanban cards (`cards.card_type` tile badge/footer & panel sections), sidebar rail panels, and settings sections.
- **`packages/worker` (`@burrow/worker`)**: `createApp({ plugins, policy, adapters })` and cold-start `runPluginMigrations`.
- **`packages/plugins/*`**:
  - `hello` (`@burrow/plugin-hello`): Minimal reference plugin (`plugin_hello_logs`, route, event subscriber).
  - `public-sharing` (`@burrow/plugin-public-sharing`) & `workspace-export` (`@burrow/plugin-workspace-export`): First-party dogfooded plugins registered by default in `createCoreApp`.
  - `estimation` (`@burrow/plugin-estimation`): Full-stack community showcase (`/estimate` slash command, `estimate` card type, `plugin:estimation:sprint` mention source, `Estimation` sidebar panel, `plugin_estimation_points` table with `REFERENCES cards(id) ON DELETE CASCADE`).
  - `_template` (`@burrow/plugin-template`): Starter template + `docs/plugin-architecture/AUTHORING.md`.

### Downstream Plugin Composition (`packages/*`)
- Downstream distributions consume `@burrow/sdk`, `@burrow/core`, `@burrow/web`, and `@burrow/worker` via pnpm workspaces.
- Server extensions (`BurrowServerPlugin`) supply domain routes, `PluginEventBus` handlers (`workspace.deleted`, `user.deleted`, `account.export`), `AccessPolicy` adapters, and `AuthProvider.getPublicConfig()` hooks without patching core files.
- Web extensions (`BurrowWebPlugin`) compose into Vite SPAs cleanly via `mountBurrowWeb({ plugins })` and `createBurrowRouter(plugins)`.
- Cloudflare Workers deployments configure `wrangler.jsonc` (`assets` + D1 + R2) with `createApp({ plugins, policy })`.

---

## 2. Database & Migration Summary
- **Public Burrow migration `0006_add_card_type.sql`** (synced across `migrations/`, `migrations/postgres/`, and `src/worker/d1-migrations.ts`):
  - Adds additive non-null column `cards.card_type TEXT NOT NULL DEFAULT 'task'`.
  - `sqlite-migrations.test.ts` and `schema-parity.test.ts` verified forward upgrade preservation on both SQLite and PostgreSQL 17.
- **Plugin Migration Ledger (`plugin_migrations`)**:
  - Primary key `(plugin_id, name)`; validates all plugin DDL/DML touches only `plugin_<id>_*` tables and blocks `PRAGMA foreign_keys = OFF` and core-table writes.

---

## 3. Quick Verification Commands

In `Burrow`:
```powershell
pnpm install --frozen-lockfile --offline
node scripts/check-version.mjs
node scripts/check-sync.mjs
node scripts/check-decoupling.mjs
node scripts/check-licenses.mjs
node scripts/check-basalt.mjs
pnpm exec tsc -b
pnpm exec eslint --max-warnings=0 .
pnpm test
pnpm run build
pnpm exec wrangler deploy --dry-run
```

In downstream workspace consumers:
```powershell
pnpm exec tsc --noEmit
pnpm test
pnpm run build:web
pnpm exec wrangler deploy --dry-run
```

---

## 4. Open Owner Decisions
See [DECISIONS.md](./DECISIONS.md) (`D1`–`D5` and Open Questions 1–3) before merging `feat/plugin-architecture` to `master` / `main`.
