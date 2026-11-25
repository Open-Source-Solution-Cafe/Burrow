# Burrow Plugin Architecture Implementation Plan

**Branch**: `feat/plugin-architecture` (in both `Burrow` and `burrow-cloud`)
**Starting SHAs**:
- `Burrow` (`master`): `c26d0ae41d7ec2f2caf3fc8ec87b7678c043f057`
- `burrow-cloud` (`main`): `d025c14c53d5e308d23953995a7ad192576001b9` (`wip/pre-plugin-snapshot`: `d74e3980c3ac59b184d80386e7377bb9a41b23bd`)

---

## Licensing & Public/Private Decoupling Verification

1. **Zero Public->Private Dependency**: Public `Burrow` (`src/`, `packages/`, `migrations/`, `tests/`, `scripts/`) never imports, references, or knows about `burrow-cloud`, Stripe, billing, orgs, tenants, SSO, or Coolify.
2. **Decoupling Guard**: `node scripts/check-decoupling.mjs` passes with 0 violations (`packages/` added to scanned directories).
3. **Dependency License Guard**: `node scripts/check-licenses.mjs` passes in `Burrow` (internal `@burrow/*` workspace packages recognized; all third-party deps remain permissive).
4. **Self-Hosted Standalone UX**: Self-hosted `Burrow` boots cleanly with Email/Password alone and hides Magic Link / OAuth when env vars are unset.
5. **Cross-Tenant Route Isolation**: All `burrow-cloud` routes pass `tests/isolation/routes.test.ts`.

---

## Phase 0: Git Safety & Plan Documentation
- [x] Verify clean branches (`wip/pre-plugin-snapshot` created in `burrow-cloud`, `feat/plugin-architecture` created in both repos from `master`/`main`).
- [x] Create `docs/plugin-architecture/{PLAN.md,PROGRESS.md,DECISIONS.md,AUDIT.md}`.

## Phase 1: Core Seams and Monorepo Split (`Burrow`)
- [x] **1.1** Clean cloud/demo leaks (`policy.ts`, `infrastructure/types.ts`, `decoupling-allowlist.json`, `workspace-export.ts`, `Login.tsx`, update `check-decoupling.mjs` to scan `packages/`).
- [x] **1.2** Split into pnpm workspace packages: `packages/sdk`, `packages/core`, `packages/web`, `packages/worker`, `packages/plugins` while keeping root build, Vitest, and `pnpm deploy` working.
- [x] **1.3** Implement `packages/sdk` (`@burrow/sdk`, zero runtime deps, MIT license field, types & manifest interfaces).
- [x] **1.4** Add typed event bus (`PluginEventBus`) in core with synchronous `before*` guards and post-commit `after*` handlers dispatched via `ctx.waitUntil` (`task.created`, `task.updated`, `task.deleted`, `notepad.saved`, `workspace.created`, `workspace.deleted`, `user.deleted`, `account.export`).
- [x] **1.5** Implement `createApp({ plugins, adapters, policy })` in `worker/index.ts` and `core/app.ts`; pass `ExecutionContext`; mount plugin routes at `/api/plugins/:id` with identity, workspace, and role middleware helpers.
- [x] **1.6** Add `AuthProvider.getPublicConfig()` for `/api/auth/config` composition and widen `oauthProviders[].kind` in `Login.tsx` (`'social' | 'oidc' | 'saml'`).
- [x] **1.7** Implement `plugin_migrations` ledger, deploy/boot runner (`scripts/deploy.mjs` & `src/worker/bootstrap.ts`), and `PluginDb` SQL guard (`plugin_<id>_*` table enforcement, `PRAGMA foreign_keys = OFF` blocked).
- [x] **1.8** Implement `validatePluginManifest` loader failing fast on invalid IDs, SemVer incompatibility, or unknown permissions.
- [x] **1.9** Add Phase 1 tests (events, migrations, `PluginDb`, manifest validation, route mounting, `AuthProvider.getPublicConfig`) and `packages/plugins/hello` example plugin; verify local Wrangler dev / dry-run and OSS deploy unchanged.

## Phase 2: `burrow-cloud` on Workers + D1 as Plugins
- [x] **2.1** Export `mountBurrowWeb({ plugins })` and `createBurrowRouter(plugins)` from `@burrow/web`; consume `@burrow/*` from `burrow-cloud` via pinned `vendor/burrow` submodule.
- [x] **2.2** Port tenancy, Stripe billing, D1 quota enforcement (single conditional `UPDATE ... RETURNING` inside D1 atomic flow), and OIDC/SAML SSO to `BurrowServerPlugin` modules using `plugin_cloud_*` D1 tables.
- [x] **2.3** Replace HTTP-path sniffing in `burrow-cloud/src/app.ts` with event handlers (`workspace.deleted`, `user.deleted`, `account.export`) and policy hooks; replace raw-HTML admin UI with plugin routes and web plugins.
- [x] **2.4** Configure `burrow-cloud` Vite build composing `@burrow/web` with private `BurrowWebPlugin` modules (billing settings + admin UI).
- [x] **2.5** Add `burrow-cloud/src/worker.ts`, `wrangler.jsonc`, and `pnpm deploy`; archive superseded Node/Postgres code in `burrow-cloud/legacy/` with `README.md`; verify tests + `vite build` + `wrangler deploy --dry-run`.

## Phase 3: Authoring and UI Extension Points (`Burrow`)
- [x] **3.1** Unify slash commands (`src/shared/slash.ts` canonical registry consumed by `NotepadEditor` and `QuickAddCard`; plugins register commands for `['notepad', 'card', 'quickadd']` with `insertText` & `openModal`).
- [x] **3.2** Open `@` mention kinds (`plugin:<id>:<type>`), pluggable `/suggest` & `/references`, and editor rendering without modifying `notepad_links`.
- [x] **3.3** Add `cards.card_type` (default `'task'`) via new core migration (`0006_add_card_type.sql` + Postgres parity + `db:sync-d1`), plugin metadata FKs to `cards(id) ON DELETE CASCADE`, and `renderTileBadge`/`renderTileFooter`/`renderPanelSection` slots in `KanbanView` and `CardPanel`.
- [x] **3.4** Add Sidebar rail panel slots and Settings section slots (widen `RailTab` union + render `sidebarPanels` and `settingsSections`).
- [x] **3.5** Dogfood: extract `publicSharing` and `workspaceExport` into `packages/plugins/` using the public SDK surface.
- [x] **3.6** Write `docs/plugin-architecture/AUTHORING.md`, create `packages/plugins/_template`, and build `packages/plugins/estimation` showcase plugin adding a slash command, card type, `@` mention source, and sidebar panel without modifying core.

## Phase 4: Untrusted Plugin Design (`DOCS ONLY`)
- [x] **4.1** Write `docs/plugin-architecture/UNTRUSTED.md` covering the curated PR catalog process, Cloudflare Workers for Platforms (dispatch namespaces, per-invocation limits, Outbound Worker, RPC façade, verified pricing/limits), and sandboxed `<iframe>` UI bridge.

## Finish
- [x] Run full quality gate in both repos (`tsc`, `vitest`, `check-decoupling`, `check-licenses`, `check-basalt`, `check-sync`, `eslint`, `vite build`, `wrangler deploy --dry-run`).
- [x] Update `CHANGELOG.md` and run version bump parity checks in both repos.
- [x] Write `docs/plugin-architecture/HANDOFF.md` and finalize `PLAN.md` / `PROGRESS.md` / `DECISIONS.md`.
- [x] Verify clean git state, untouched `master`/`main`, and push `feat/plugin-architecture` in both repos.
