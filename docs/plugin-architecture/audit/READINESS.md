# Burrow Plugin System — Production-Readiness Audit

*Audit date: 2026-11-22 | Branch: `audit/plugin-readiness` (from `feat/plugin-architecture`)*

## 1. Baseline & What Actually Changed vs. Previous Audit

Comparison of `feat/plugin-architecture` (`Burrow` `8509c88`, private cloud repo `3777d86`) against the pre-plugin baseline (`Burrow` `master` `c26d0ae`, private cloud `main` `d025c14`) and `docs/plugin-architecture/AUDIT.md`:

| Area | Pre-Plugin Baseline (`AUDIT.md`) | Implemented on `feat/plugin-architecture` | Current Policy Alignment (Cloud -> Postgres) |
| :--- | :--- | :--- | :--- |
| **Core Monorepo & SDK** | Single package; static `createCoreApp` & `src/web/main.tsx` | Added `pnpm-workspace.yaml`, `packages/{sdk,core,web,worker,plugins}`, `PluginEventBus`, `MentionSourceRegistry`, `plugin_migrations`, `PluginDb`, `cards.card_type`, UI slots (`v0.5.0`). | Core keeps both SQLite/D1 and Postgres adapters, **but** `src/core/plugins/` and `src/server/index.ts` only wire SQLite/D1. |
| **Private Cloud Runtime** | Node.js + PostgreSQL (`src/server.ts`, `pgSchema`, `FOR UPDATE`, core triggers). | `feat/plugin-architecture` (`33b1209`..`22f3bc1`) ported cloud features to **Workers + D1** (`src/worker.ts`, `wrangler.jsonc`, `src/plugins/*`) and archived Node/PG in `legacy/`. `DECISIONS.md` (`D1`) froze Postgres. | **Unimplemented pivot:** code in the private cloud repo is still split between D1-only plugins (`src/worker.ts`) and legacy Node/PG (`src/server.ts`, `Dockerfile`), with **no Postgres plugin runtime yet**. |
| **First-Party Dogfooding** | Static routes in `src/core/app.ts` | `packages/plugins/{public-sharing,workspace-export}` wrap core routes via `ctx.infra` (`src/core/app.ts:147-166`). | Bypass `PluginDb` and capabilities by casting `ctx.infra`. |

> [!WARNING]
> **Architectural Divergence:** Recent direction reverses `DECISIONS.md` (`D1`) so the hosted cloud runs on **Postgres** rather than D1. As of this audit, **zero commits** implement Postgres support in `PluginDb`, `runPluginMigrations`, `src/server/index.ts`, or the private cloud's `src/plugins/*`.

---

## 2. Verdict: **NOT READY**

**Not ready for production.** At best, the runtime is **ready for internal, curated first-party D1/Workers prototypes only**—and **blocked** for:
1. Any **Postgres-backed** cloud or self-hosted plugin deployment (zero Postgres `PluginDb` / migration support).
2. Any **untrusted or lightly-reviewed third-party plugin** (trivial SQL guard bypasses, unrestricted `SELECT` on core auth secrets, raw `ctx.env`/`ctx.infra` exposure).
3. **Production operations** (no plugin kill switch, no timeouts, no `waitUntil` off-Workers, no lifecycle/uninstall).

---

## 3. Part A Graded Assessment

### 3.1 Dialect Support — **FAIL**

| Sub-criterion | Grade | Evidence & Observed Behavior |
| :--- | :--- | :--- |
| **`PluginDb` dialect awareness** | **FAIL** | `src/core/plugins/plugin-db.ts:15-41,294-380` only supports Cloudflare `D1Database` and `SqliteLikeDb` (`.prepare().all/get/run()`). Passing a `postgres` client throws `PluginSqlAccessError: database binding is not available` (`tests/audit/plugin-isolation-adversarial.test.ts`). No `$1`/`$2` placeholder translation, no dialect flag, no Postgres `ON CONFLICT` / `RETURNING` normalization. |
| **Migration ledger & runner** | **FAIL** | `src/core/plugins/migrations.ts:32-143` creates `plugin_migrations` with SQLite `INTEGER` and `INSERT OR IGNORE`; `runPluginMigrations()` checks `typeof client.prepare === 'function'` (`line 45`) and **silently returns `[]`** on Postgres clients! Also lacks advisory locking (`pg_advisory_xact_lock`) for concurrent deploys; `scripts/deploy.mjs:89-99` runs `--file` and ledger `INSERT` in two separate non-atomic `wrangler d1 execute` calls (mid-migration ledger drift risk). |
| **Manifest dialect declaration** | **FAIL** | `packages/sdk/src/index.ts:16-25` (`PluginManifest`) and `src/core/plugins/manifest.ts` have **no `dialects` field**. Loader does not refuse plugins lacking migrations for the active dialect. |
| **Postgres isolation & SQL guard bypasses** | **FAIL** | No per-plugin PG schema or role exists. Isolation relies solely on regex/string scanning in `assertPluginSqlAllowed` (`src/core/plugins/plugin-db.ts:44-292`). **Adversarial tests (`tests/audit/plugin-isolation-adversarial.test.ts`) proved 4 concrete bypasses:** (1) `stripCommentsAndStrings` ignores `"..."` double-quoted identifiers, so `WITH cte AS (SELECT 1 AS "a'b") DELETE FROM workspaces WHERE 'x' = 'x'` passes and **wipes `workspaces`**; (2) Postgres `$$...$$` dollar-quoting desyncs both `splitPluginSqlStatements` (splits `;` inside `$$`) and `stripCommentsAndStrings`; (3) `SELECT * INTO evil FROM workspaces` passes `^SELECT\b`; (4) `WITH src AS (...) MERGE INTO workspaces ...` passes `^WITH\b`. |

### 3.2 Isolation and Safety — **FAIL**

| Sub-criterion | Grade | Evidence & Observed Behavior |
| :--- | :--- | :--- |
| **Core/plugin table & secret containment** | **FAIL** | (1) `assertPluginSqlAllowed` (`src/core/plugins/plugin-db.ts:285`) permits arbitrary `SELECT` across **all** core tables (`user`, `session`, `account`, `invites`), **other plugins' tables**, and `_worker_runtime_config` (which stores plaintext `better_auth_secret` on Worker bootstrap: `src/worker/bootstrap.ts:170`). (2) `loadServerPlugins` (`src/core/plugins/loader.ts:82-83`) passes full `ctx.env` (all secrets + raw `DB`) and `ctx.infra` (all core repositories + raw `db`) even to plugins with `permissions: []` (`tests/audit/plugin-isolation-adversarial.test.ts`). |
| **Workspace scoping & route auth** | **PARTIAL** | Core provides opt-in `ctx.middleware.{requireIdentity,requireWorkspace,requireRole}` (`src/core/app.ts:119-123`) and `MentionSourceRegistry` passes `MentionScope` (`src/core/routes/workspace-views.ts:118`, `project-resources.ts:254`). **However**, plugins are not forced to attach auth/workspace middleware (`tests/audit/plugin-isolation-adversarial.test.ts`), and `ctx.route(app, { mountPath })` (`src/core/plugins/loader.ts:90`) allows **any** `routes:api` plugin to mount on arbitrary paths (`/api/*`, `/`, etc.) without a `mountPath` permission. |
| **Error & timeout containment** | **PARTIAL** | `PluginEventBus.emitAfter` (`src/core/plugins/event-bus.ts:89-97`) isolates exceptions with `Promise.allSettled` and logs errors. `emitBefore` (`lines 65-74`) is **fail-closed** on both intentional `HttpError` policy rejections and unexpected crashes (`TypeError`), aborting the core write. **Zero timeouts** exist on `onBefore`, `on`, `route`, `suggest`, `resolve`, or `setup()`. |
| **Ordering, dependencies, collisions** | **FAIL** | `PluginManifest` has no `dependencies` / `after` field (`packages/sdk/src/index.ts:16-25`); private cloud plugins fail opaquely with a 500 error if ordered wrong (`CloudDbHolder` in private cloud `src/plugins/schema.ts:160-163`). `loader.ts:48-52` catches duplicate `manifest.id`, **but** allows duplicate `mountPath`, duplicate `slashCommands[].id`, duplicate `cardTypes[].type`, duplicate `sidebarPanels[].id`, and silent last-writer-wins overwrites in `setAdapters()` (`loader.ts:105-122`). |

### 3.3 Lifecycle — **FAIL**

| Sub-criterion | Grade | Evidence & Observed Behavior |
| :--- | :--- | :--- |
| **Install / enable / disable / uninstall / upgrade / rollback** | **FAIL** | Plugins are statically compiled into `createApp({ plugins })` and `mountBurrowWeb({ plugins })`. There are **no** lifecycle hooks (`onInstall`/`onEnable`/`onDisable`/`onUninstall`), **no** down-migrations or rollback mechanism, and **no** orphan cleanup when a plugin is removed (tables and `plugin_migrations` rows remain indefinitely). |
| **Per-workspace vs instance enablement** | **FAIL** | `src/shared/featureFlags.ts:1-62` hardcodes 4 core flags (`workspaceExport`, `notionImport`, `publicSharing`, `instanceMigration`). Plugins cannot register workspace toggles or per-workspace enablement; built-in `public-sharing` and `workspace-export` still rely on core routes checking those hardcoded keys (`src/core/routes/feature-flags.ts:41-53`). |
| **SDK versioning & deprecation** | **PARTIAL** | `validatePluginManifest` (`src/core/plugins/manifest.ts:54-90,112-120`) enforces SemVer `sdkVersion` (`^`, `~`, `>=`, `x`, exact) against `BURROW_SDK_VERSION` (`0.4.0`), **but** does not support compound ranges (`>=0.4.0 <0.6.0` or `||`), `packages/sdk/package.json` (`0.4.0`) already drifted from root `package.json` (`0.5.0`), and there is no breaking-change or deprecation policy. |

### 3.4 Operations — **FAIL**

| Sub-criterion | Grade | Evidence & Observed Behavior |
| :--- | :--- | :--- |
| **Logging, metrics, health, kill switch** | **FAIL** | Zero per-plugin structured logging or metrics (`event-bus.ts:94` logs errors without plugin ID attribution). `/api/health` and `/api/ready` (`src/core/app.ts:321-322`) do not check plugin status or migrations. No runtime kill switch or config toggle exists to disable a misbehaving plugin without rebuilding/redeploying. |
| **Hot-path performance** | **PARTIAL** | On Cloudflare Workers, `emitAfter` uses `ctx.waitUntil` (`event-bus.ts:104-108`). **On Node.js/Postgres**, `ctx.waitUntil` is absent, so `emitAfter` **`await`s every listener inline** (`line 110`), blocking `notepad.saved` autosaves (passing up to 1.5 MB `content` string in payload: `src/core/services/notepads.ts:490-497`) and `task.created` responses! `MentionSourceRegistry.suggestAll` (`mention-registry.ts:36-52`) awaits sources serially instead of concurrently. |
| **Secrets & config handling** | **FAIL** | `ctx.env` exposes every instance environment variable/secret to every plugin (`src/core/plugins/loader.ts:82`); no per-plugin secret scoping or manifest config schema exists. |
| **Tests & plugin contract suite** | **PARTIAL** | Only 3 test files in `Burrow` cover the plugin runtime (`tests/unit/plugin-architecture.test.ts`, `tests/api/plugins.test.ts`, `tests/api/plugin-authoring-showcase.test.ts`), plus 1 in the private cloud (`tests/plugins/d1-cloud-plugins.test.ts`). No reusable `@burrow/sdk` contract test harness exists for third-party plugin authors, and the private cloud's dynamic route isolation suite (`tests/isolation/routes.test.ts`) only tests `src/app.ts`, not `src/plugins/*`. |

### 3.5 Quality Gates — **PASS (Current Branch Baseline)**

All existing automated gates in both repositories were executed on `audit/plugin-readiness` and passed:

| Check | Repo | Command | Observed Result |
| :--- | :--- | :--- | :--- |
| Sync / Version / Basalt / Licenses / Decoupling | `Burrow` | `node scripts/check-{sync,version,basalt,licenses,decoupling}.mjs` | **PASS** (`check: sync OK`, `check: version OK (v0.5.0)`, `check: basalt OK`, `453 packages scanned, 0 violations`, `509 files scanned, 0 violations`) |
| Typecheck & Lint | `Burrow` | `pnpm exec tsc -b; pnpm exec eslint --max-warnings=0 .` | **PASS** (exit 0, 0 warnings) |
| Build & Wrangler Dry-Run | `Burrow` | `pnpm run build; pnpm exec wrangler deploy --dry-run` | **PASS** (`dist/web` + `dist/server.mjs` 623.1kb; Total Upload 4111.36 KiB) |
| Full Test Suite (Unit + SQLite + PG 17 + Worker D1) | `Burrow` | `pnpm test` | **PASS** (`Test Files 153 passed (153)`, `Tests 845 passed (845)`) |
| Adversarial Audit Probes | `Burrow` | `pnpm exec vitest run --config .../vitest.audit.config.ts` | **PASS (6/6 probes confirm gaps)** in `tests/audit/plugin-isolation-adversarial.test.ts` |
| Pinned Submodule / Version / Typecheck / Build / Dry-Run | Private Cloud | `node scripts/check-pinned-burrow.mjs; node scripts/check-version.mjs; pnpm exec tsc --noEmit; pnpm run build:web; pnpm exec wrangler deploy --dry-run` | **PASS** (v0.3.1, pinned `8509c88`, Total Upload 3986.27 KiB) |
| Full Test Suite (PG 17 + Miniflare D1) | Private Cloud | `pnpm test` | **PASS** (`Test Files 19 passed (19)`, `Tests 178 passed (178)`) |

---

## 4. Top Blockers (Ranked by Severity, Security First)

1. **CRITICAL — Security: Unscoped `ctx.env` / `ctx.infra` & unrestricted `SELECT` leak all secrets and cross-workspace data** (`src/core/plugins/loader.ts:82-83`, `src/core/plugins/plugin-db.ts:285`, `src/worker/bootstrap.ts:170`). Any plugin—even with `permissions: []`—can read `BETTER_AUTH_SECRET` from `ctx.env` or `_worker_runtime_config`, read all users/sessions/workspaces via `SELECT`, or bypass `PluginDb` via `ctx.infra.db` / `ctx.env.DB`.
2. **CRITICAL — Security: Regex-based `PluginDb` SQL guard is trivially bypassed** (`src/core/plugins/plugin-db.ts:44-292`). A double-quoted identifier with an apostrophe (`"a'b"`) desyncs `stripCommentsAndStrings`, allowing `WITH cte AS (SELECT 1 AS "a'b") DELETE FROM workspaces` to wipe core tables; Postgres `$$...$$`, `SELECT ... INTO`, and `WITH ... MERGE` also bypass validation.
3. **CRITICAL — Architecture/Dialect: Zero Postgres support in `PluginDb`, `runPluginMigrations`, `src/server/index.ts`, or private cloud plugins** (`src/core/plugins/plugin-db.ts`, `src/core/plugins/migrations.ts`, `src/server/index.ts`). `runPluginMigrations` silently no-ops on Postgres clients, and private cloud plugins are hardcoded to SQLite/D1 syntax (`INSERT OR IGNORE`, `?` placeholders, `INTEGER` timestamps).
4. **HIGH — Security/Routing: Arbitrary `mountPath` override & unguarded plugin routes** (`src/core/plugins/loader.ts:90`). Any `routes:api` plugin can mount at `/api/*` or `/` without a capability guard, omit `requireIdentity`/`requireWorkspace`, and escape the private cloud's `tests/isolation/routes.test.ts` (which still targets legacy `src/app.ts`).
5. **HIGH — Availability/Operations: No Node background queue (`emitAfter` blocks hot path), no timeouts, and no runtime kill switch** (`src/core/plugins/event-bus.ts:65-111`, `src/core/services/notepads.ts:490-497`). On Node/Postgres, every `notepad.saved` and `task.created` awaits all `after*` handlers inline; buggy `onBefore` crashes fail closed; and no runtime toggle/kill switch exists per instance or workspace.
6. **MEDIUM — Distribution/Authoring: `@burrow/sdk` is unpublishable as-is and core entrypoints require source edits** (`packages/sdk/package.json`, `src/worker/index.ts:112`, `src/web/main.tsx:3`). `@burrow/sdk` exports raw `.ts` (failing Node runtime import with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), has no `dist/` or `files`, and external plugins cannot register without editing core source files.

---

## 5. Open Questions

1. **Cloud Postgres Topology**: Will the Postgres cloud run a shared multi-workspace DB with per-plugin PostgreSQL schemas/roles (`CREATE SCHEMA plugin_<id>` + `SET LOCAL ROLE`), or isolated DBs per customer?
2. **Core Adapter Plugins**: `public-sharing` and `workspace-export` currently cast `ctx.infra` to wrap core routes. Should built-in core capabilities stay core modules rather than pretending to use the third-party `PluginDb` contract, or should `@burrow/sdk` expose typed read-only repository APIs?
3. **`before*` Guard Policy vs. Crash Semantics**: Should unexpected non-`HttpError` exceptions in `onBefore` handlers continue to fail-closed (aborting saves/creates) or be configurable per plugin/hook?
