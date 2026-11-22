# Burrow Plugin Installation & Distribution Audit

*Audit date: 2026-11-22 | Scope: Current real install/ops flows across all 4 personas, gaps, and minimal target install model.*

---

## 1. Current Real Flows & Scores

| Audience | Current Flow (Observed in Code) | Score | Key Friction & Gaps |
| :--- | :--- | :--- | :--- |
| **1. Self-Hoster (Open Source)** | **Fork / Edit Core Source.** No plugin config file exists. Self-hoster must: (a) clone `Burrow`, (b) copy or `pnpm add` plugin into `packages/plugins/<id>` (or workspace), (c) edit `src/worker/index.ts:112` (`createApp({ plugins: [...] })`) and `src/web/main.tsx:3` (`mountBurrowWeb({ plugins: [...] })`), (d) rebuild (`pnpm run build` / `vite build`), (e) deploy Worker (`pnpm run deploy` / `wrangler deploy`). Migrations run automatically on Worker cold start (`ensureWorkerRuntimeEnv` -> `runPluginMigrations`) or via `migrations/plugins/<id>/*.sql` in `scripts/deploy.mjs:286`. **Node/Postgres (`src/server/index.ts`) cannot load plugins at all.** | **FAIL** | - Not one command; requires editing tracked core files (`src/worker/index.ts`, `src/web/main.tsx`), breaking `sync:upstream` / one-click updates.<br>- `src/server/index.ts` (Docker/Node/Postgres) ignores plugins completely.<br>- External npm plugins fail unless `@burrow/sdk` is built & published. |
| **2. Cloud Operator (Private SaaS)** | **Workspace Submodule + Hardcoded Entrypoints.** Private repo pins `vendor/burrow` submodule, aliases `@burrow/*` in `vite.config.ts` & `tsconfig.json`, and hardcodes the 4 private cloud plugins (accounts/quotas, subscriptions, SSO, admin) in `src/worker.ts` + `src/web/plugins.tsx`. Adding a curated community plugin requires `pnpm add <pkg>`, editing `src/worker.ts` and `src/web/plugins.tsx`, rebuilding Vite + Worker, and deploying. | **PARTIAL** | - **Dialect blocker:** `src/plugins/*` and `src/worker.ts` target D1; `src/server.ts` + `Dockerfile` target Postgres and only wire `lifecyclePlugin` (`src/app.ts`), **not** `src/plugins/*`. Cloud operator cannot deploy plugin-based SaaS on Postgres today.<br>- No config-driven list of enabled community plugins or per-deployment feature flags. |
| **3. Workspace Admin (End User)** | **No UI exists.** `WorkspaceSettings.tsx` (`src/web/pages/WorkspaceSettings.tsx`) and `FeatureFlagsSection.tsx` (`src/web/components/settings/FeatureFlagsSection.tsx`) only show the 4 hardcoded core flags (`workspaceExport`, `notionImport`, `publicSharing`, `instanceMigration`). There is no plugin list, no per-workspace enable/disable toggle, and no manifest permission prompt/disclosure. | **FAIL** | - Zero visibility into installed plugins.<br>- Cannot disable a buggy plugin per workspace.<br>- No permission consent screen (`db:own`, `events:before`, `auth:override`, etc.). |
| **4. Plugin Submission & Validation** | **Ad-hoc PR only.** `UNTRUSTED.md` describes a future Tier 1 PR catalog conceptually, **but** there is no `registry/` directory or index schema, no JSON Schema for `PluginManifest`, no PR review checklist, and **no local CLI validator** (no `burrow plugin validate` script that checks manifest, license, Basalt compliance, decoupling, SQL safety, and migration parity without GitHub Actions). | **FAIL** | - No automated or CI-less validation tool (`burrow plugin validate`).<br>- `scripts/check-licenses.mjs` and `scripts/check-basalt.mjs` only scan the whole `Burrow` repo, not an external submitted plugin package. |

---

## 2. Detailed Gap Matrix

| Requirement | Current State | File Evidence |
| :--- | :--- | :--- |
| Config-driven plugin registration | Missing (hardcoded `createApp()` & `mountBurrowWeb()`) | `src/worker/index.ts:112`, `src/server/index.ts:97`, `src/web/main.tsx:3` |
| One-command self-hoster install | Missing | `package.json`, `scripts/deploy.mjs` |
| Node / Postgres plugin boot & migration | Missing (`runPluginMigrations` only checks `.prepare()`) | `src/server/index.ts:37-97`, `src/core/plugins/migrations.ts:45` |
| Admin UI + permission disclosure | Missing | `src/web/pages/WorkspaceSettings.tsx`, `src/shared/featureFlags.ts` |
| CI-less `burrow plugin validate` CLI | Missing | `scripts/` |

---

## 3. Proposed Minimal Target Install Model (No Marketplace Yet)

Goal: let self-hosters and the private cloud operator install curated npm/local plugins **without editing core source files**, support Postgres + SQLite/D1 uniformly, and validate submissions locally.

### Target Flow (Single Declarative File + Generated Entrypoints)

1. **Declarative `burrow.plugins.json` (in instance root):**
   ```json
   {
     "plugins": [
       { "package": "@burrow/plugin-estimation", "enabled": true, "config": {} }
     ]
   }
   ```
2. **One-command CLI (`pnpm burrow plugin ...` / `node scripts/plugin-cli.mjs`):**
   - `burrow plugin add <pkg>` — runs `pnpm add <pkg>`, validates its manifest + permissions + license, adds entry to `burrow.plugins.json`, and regenerates a gitignored/generated `.burrow/plugins.server.ts` and `.burrow/plugins.web.ts` barrel imported by `src/worker/index.ts`, `src/server/index.ts`, and `src/web/main.tsx` (falling back to `[]` when `burrow.plugins.json` is absent).
   - `burrow plugin validate <path-or-pkg>` — CI-less validator checking: (a) `PluginManifest` + `dialects`, (b) permissive license (`MIT`/`Apache-2.0`/`BSD-*`/`ISC`/`AGPL-3.0-or-later` for OSS), (c) AST SQL validation for all migrations on declared dialects, (d) Basalt token compliance (`check-basalt`), (e) decoupling (`check-decoupling` when targeting public core), and (f) presence of smoke/contract tests.
   - `burrow plugin migrate` — runs `runPluginMigrations` explicitly for Node/Postgres (`--migrate`) and remote D1 (`scripts/deploy.mjs`).
3. **Workspace Admin UI (Settings -> Plugins):**
   - Read-only/toggle table backed by `GET /api/workspaces/:wid/plugins` + `PATCH /api/workspaces/:wid/plugins/:id`:
     - Shows installed plugin `name`, `version`, `description`, and human-readable **declared permissions badge list** (e.g., `Database tables (plugin_estimation_*)`, `API routes`, `Reads task events`).
     - Workspace `owner` can toggle non-adapter plugins on/off per workspace (instance-wide `auth:override`/`policy:override`/`storage:override` plugins display `"Managed by Instance"` and cannot be toggled per workspace).

### Smallest Set of Changes to Reach Target Model

1. Build & publish `@burrow/sdk` (`dist/index.js` + `dist/index.d.ts`, `files: ["dist", "LICENSE"]`).
2. Add Postgres dialect support to `PluginDb` and `runPluginMigrations`, plus wire `plugins` into `src/server/index.ts`.
3. Support `burrow.plugins.json` -> generated `.burrow/plugins.{server,web}.ts` consumed by `src/worker/index.ts`, `src/server/index.ts`, and `src/web/main.tsx`.
4. Add `scripts/plugin-cli.mjs` (`add`, `remove`, `validate`, `list`) and expose `pnpm run plugin`.
5. Add `plugin_workspace_states` (or extend workspace feature flags) + Settings UI card displaying permissions and workspace toggles.
