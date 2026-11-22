# Plugin Architecture Implementation Progress

**Started**: 2026-11-22  
**Branch**: `feat/plugin-architecture`

## Baseline Repository Hashes (Do Not Modify `master` / `main`)
- `Burrow` `master`: `c26d0ae41d7ec2f2caf3fc8ec87b7678c043f057`
- `burrow-cloud` `main`: `d025c14c53d5e308d23953995a7ad192576001b9`
- `burrow-cloud` `wip/pre-plugin-snapshot`: `d74e3980c3ac59b184d80386e7377bb9a41b23bd`

## Step Log

| Step | Repo | Status | Commit | Notes |
| :--- | :--- | :--- | :--- | :--- |
| 0.1 Git branch setup & plan docs | Both | Done | `58bddd0` | Created `wip/pre-plugin-snapshot` in `burrow-cloud`, `feat/plugin-architecture` in both repos, and `docs/plugin-architecture/*`. |
| 1.1 Clean cloud/demo leaks | Burrow | Done | `37d7aae` | Neutralized wording in `policy.ts`, `types.ts`, `workspace-export.ts`, `Login.tsx`; expanded `check-decoupling.mjs` to `packages/`. |
| 1.2 Workspace package split | Burrow | Done | `7abbc9e`, `e4f5dca` | Added `pnpm-workspace.yaml` and `packages/{sdk,core,web,worker,plugins}`. |
| 1.3 `@burrow/sdk` types & manifest | Burrow | Done | `e4f5dca` | Zero runtime deps, MIT license field, full server & web plugin contracts. |
| 1.4 Typed event bus (`before`/`after`) | Burrow | Done | `6aa6e26` | `PluginEventBus` + `ExecutionContext.waitUntil` wired into cards, notepads, workspaces, export, and user delete. |
| 1.5 `createApp({ plugins })` & route mount | Burrow | Done | `6aa6e26` | `createApp` / `createWorkerApp` / `createCoreApp` compose plugins, adapter overrides, and `/api/plugins/:id`. |
| 1.6 `AuthProvider.getPublicConfig()` & Login | Burrow | Done | `6aa6e26` | Merged public config in `/api/auth/config`; widened OIDC/SAML support in `Login.tsx`. |
| 1.7 `plugin_migrations` & `PluginDb` | Burrow | Done | `6aa6e26`, `b37474f` | Atomic `db.batch()` plugin migration ledger + SQL table prefix guard (including `ON CONFLICT DO UPDATE SET` upserts). |
| 1.8 Manifest validation loader | Burrow | Done | `6aa6e26` | Fail-fast SemVer, ID regex, and permission enforcement in `loader.ts`. |
| 1.9 Phase 1 tests & `hello` plugin | Burrow | Done | `4d9643b` | Added `@burrow/plugin-hello`, unit & D1 Worker E2E tests; full Phase 1 gate + `wrangler deploy --dry-run` green. |
| 2.1 `@burrow/web` composition & pin sync | Both | Done | `deaf44a`, `51723e3` / `33b1209` | Exported `mountBurrowWeb` & `createBurrowRouter`; updated `vendor/burrow` & wired `@burrow/*` in `burrow-cloud`. |
| 2.2 Port cloud features to D1 plugins | burrow-cloud | Done | `d894994` | Added `src/plugins/*` (`cloud`, `cloud-billing`, `cloud-sso`, `cloud-admin`) targeting `plugin_cloud_*` tables on D1. |
| 2.3 Replace path sniffing & raw HTML admin | burrow-cloud | Done | `1ccb920` | Replaced HTTP path-sniffing middleware and admin SSR HTML in `src/app.ts` with plugin lifecycle event hooks. |
| 2.4 `burrow-cloud` Vite bundle + web plugins | burrow-cloud | Done | `22f3bc1` | Added `src/web/{plugins.tsx,main.tsx}`, `index.html`, `vite.config.ts` composing `@burrow/web`. |
| 2.5 `wrangler.jsonc`, `legacy/`, D1 tests | burrow-cloud | Done | `22f3bc1` | Added `src/worker.ts`, `wrangler.jsonc`, `legacy/` Postgres archive, and Miniflare D1/R2 E2E test suite (19/19 test files green). |
| 3.1 Unify slash command registry | Burrow | Done | `e14ef88` | Extended `slash.ts`, `suggestionItems.tsx`, `NotepadEditor.tsx`, and `QuickAddCard.tsx` for plugin commands + `openModal`. |
| 3.2 Open `@` mention kinds | Burrow | Done | `906239b`, `60d0242` | Added `plugin:<id>:<type>` support in `shared/{blocks,extract,references}.ts`, `/suggest`, `/references`, and editor without altering `notepad_links`. |
| 3.3 `cards.card_type` & Kanban UI slots | Burrow | Done | `bc9841e` | Added `0006_add_card_type.sql` (SQLite + Postgres + D1 sync), schema/repo/service/route plumbing, and tile/panel plugin slots. |
| 3.4 Sidebar & Settings slots | Burrow | Done | `833484b` | Added rail icon tabs + panels (`Sidebar.tsx`) and plugin sections (`SettingsView.tsx`). |
| 3.5 Dogfood `publicSharing` & `workspaceExport` | Burrow | Done | `3735c96` | Extracted `packages/plugins/public-sharing` & `workspace-export` and registered by default in `createCoreApp`. |
| 3.6 `AUTHORING.md`, `_template`, `estimation` plugin | Burrow | Done | `d782a4d` | Added `AUTHORING.md`, `_template`, `@burrow/plugin-estimation` (server + web), and Miniflare D1 showcase E2E test. |
| 4.1 `UNTRUSTED.md` design doc | Burrow | Done | pending | Third-party isolation blueprint (Workers for Platforms, D1 limits, Outbound Worker, `<iframe>` sandbox RPC). |
| Finish: Quality gates, release bump, handoff, push | Both | In Progress | pending | `HANDOFF.md`, `CHANGELOG.md` updates, SemVer version bumps, full CI parity verification, push `feat/plugin-architecture`. |
