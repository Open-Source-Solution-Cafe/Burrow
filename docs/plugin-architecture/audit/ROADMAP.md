# Burrow Plugin System — Production Roadmap

*Ordered, minimal milestones derived from the 2026-11-22 production-readiness audit. Effort: **S** (≤1–2 days), **M** (3–5 days), **L** (1–2+ weeks).*

---

## Phase 1: Curated First-Party Launch (Postgres Cloud + Public Core Hardening)

*Prerequisite: Must complete before launching Postgres-backed hosted SaaS or recommending `feat/plugin-architecture` for production.*

| Order | Item | Repo | Effort | Why / Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- |
| **1.1** | **Scoped `ServerPluginContext` (drop raw `ctx.infra` & full `ctx.env`)** | `Burrow` | **M** | Stop leaking `BETTER_AUTH_SECRET`, raw `DB`, and all repositories to plugins. Replace `ctx.env` with declared `manifest.requiredEnv` allowlist; move core-wrapping `public-sharing` / `workspace-export` into explicit first-party core modules or typed SDK capabilities; block `mountPath` overrides unless `routes:root` (first-party only) is declared. |
| **1.2** | **Replace regex SQL guard with AST parser + block core secret/cross-plugin reads** | `Burrow` | **M** | Fix the `"a'b"` / `$$...$$` / `SELECT INTO` / `WITH MERGE` bypasses in `src/core/plugins/plugin-db.ts` using a real SQLite/PG lexer/parser (`node-sql-parser` or `pgsql-ast-parser` + `sqlite-parser`, checked by `check-licenses.mjs`). Restrict `SELECT` to `plugin_<id>_*` + explicit safe read-only core views/tables (never `_worker_runtime_config`, `session`, `account`, `verification`, or other `plugin_*` tables). |
| **1.3** | **Add Postgres dialect support to `PluginDb`, `runPluginMigrations`, and `src/server/index.ts`** | `Burrow` | **L** | Implement `PostgresPluginDb` (`postgres` driver, `$1` placeholders or tagged/positional normalization, `pg_advisory_xact_lock(hashtext('burrow:plugin_migrations'))`, `INSERT ... ON CONFLICT DO NOTHING`). Add `dialects?: ('sqlite' | 'postgres')[]` and dialect-keyed migrations (`sqlite` / `postgres`) to `@burrow/sdk`; fail fast if active dialect has no migration target. Wire `plugins` and `runPluginMigrations` into `src/server/index.ts` (`--migrate` and startup). |
| **1.4** | **Postgres schema/role isolation for plugins** | `Burrow` | **M** | On Postgres, create per-plugin schema (`plugin_<id>`) or enforce `SET LOCAL search_path` + restricted DB role that grants `SELECT` only on safe core views/tables and blocks DDL/DML on `public.*` and sibling plugin schemas at the database engine level. |
| **1.5** | **Port private cloud plugins (`src/plugins/*`) from D1-only to Postgres + unify `src/server.ts` / `Dockerfile`** | Private Cloud | **L** | Rewrite the 4 private cloud server plugins and `schema.ts` to support Postgres (`$1` / dialect adapter, `BIGINT` timestamps, `ON CONFLICT DO NOTHING`, PG atomic quota update `RETURNING`), wire `createCloudServerPlugins()` + `cloudWebPlugins` into `src/server.ts` and `Dockerfile`, and switch `tests/isolation/routes.test.ts` to enumerate `src/plugins/*` routes directly. |
| **1.6** | **Event bus & handler safety: non-blocking Node dispatch, timeouts, plugin attribution, error policy** | `Burrow` | **M** | On Node/Postgres (when `ctx.waitUntil` is absent), run `after*` handlers on a bounded async queue with `AbortSignal.timeout` (do not `await` inline in `saveContent`). Tag every handler with `pluginId` for structured error logging/metrics. Distinguish intentional `HttpError` rejections from crashes in `onBefore` and add per-handler timeouts. |
| **1.7** | **Dependency ordering, collision detection, and runtime kill switch** | `Burrow` | **M** | Add `dependencies?: string[]` to `PluginManifest` with topological sort & cycle detection in `loadServerPlugins` (fixes `CloudDbHolder` order fragility). Reject colliding `mountPath`, `slashCommands[].id`, `cardTypes[].type`, `sidebarPanels[].id`, and duplicate `setAdapters()` overrides. Add `DISABLED_PLUGINS` env kill switch + `/api/health` plugin status summary. |
| **1.8** | **Fix `cardType` UI selection gap** | `Burrow` | **S** | Expose registered `cardTypes` in `QuickAddCard` and `CardPanel` so users can actually create and switch custom card types without raw API calls. |

---

## Phase 2: Community Submissions (Curated Build-Time Registry)

*Prerequisite: Phase 1 complete.*

| Order | Item | Repo | Effort | Why / Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- |
| **2.1** | **Make `@burrow/sdk` truly publishable** | `Burrow` | **S** | Add `tsup`/`tsc` build emitting `dist/index.js` + `dist/index.d.ts`, add `"files": ["dist", "LICENSE"]`, align `version` with `0.5.0` in `check-version.mjs`, declare optional `peerDependencies` (`hono`, `react`), and publish `@burrow/sdk` to npm. |
| **2.2** | **Declarative `burrow.plugins.json` + `scripts/plugin-cli.mjs` (`add` / `remove` / `list`)** | `Burrow` | **M** | Self-hosters install plugins with one command without editing `src/worker/index.ts`, `src/server/index.ts`, or `src/web/main.tsx`. |
| **2.3** | **Standalone `create-burrow-plugin` template & contract test harness** | `Burrow` | **M** | Provide `tsconfig.json`, server + web entrypoints, `hono`/`react` dev/peer setup, and `@burrow/sdk/testing` (in-memory SQLite + mock `ExecutionContext` + route/event test helpers) so external plugins test without cloning `Burrow`. |
| **2.4** | **CI-less `burrow plugin validate` CLI & PR submission checklist** | `Burrow` | **M** | Single offline script validating manifest, `dialects`, SPDX license, SQL AST safety, Basalt tokens, decoupling, and contract tests; document `registry/` layout and review checklist. |
| **2.5** | **Workspace Admin Plugin UI & per-workspace toggles** | `Burrow` | **M** | Add `plugin_workspace_states` table + **Settings -> Plugins** section showing installed plugins, declared permissions summary, and owner toggles (respecting instance-locked adapter plugins). |
| **2.6** | **Plugin lifecycle hooks & down-migration / uninstall cleanup** | `Burrow` | **M** | Support `onDisable`/`onUninstall`, optional `down` SQL / safe table drop on explicit purge, and startup warning when orphaned `plugin_<id>_*` tables exist in `plugin_migrations` with no loaded plugin. |

---

## Phase 3: Untrusted Runtime Plugins (Workers for Platforms + Sandboxed UI)

*Prerequisite: Phases 1 & 2 complete; requires explicit owner sign-off (`DECISIONS.md` D4, `UNTRUSTED.md`).*

| Order | Item | Repo | Effort | Why / Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- |
| **3.1** | **Per-plugin isolated storage (PG schema/role or isolated DO/D1) + RPC `PluginDb` façade** | `Burrow` / Cloud | **L** | Zero shared-DB blast radius; untrusted code never holds DB credentials or raw drivers, only an authenticated RPC stub scoped to its own schema/DB. |
| **3.2** | **Cloudflare Workers for Platforms dispatch namespace + Outbound Worker** | Cloud | **L** | Run untrusted server plugins in separate V8 isolates with `limits: { cpuMs, subRequests }` and SSRF-blocking Outbound Worker (`allowedEgressHosts` manifest field). |
| **3.3** | **Sandboxed `<iframe sandbox="allow-scripts">` UI + `MessageChannel` capability RPC** | `Burrow` | **L** | Isolate third-party React/JS away from host origin cookies, CSRF tokens, and DOM; render declarative badges/panels via `MessageChannel` handshake. |
| **3.4** | **Per-workspace permission consent & instant runtime revocation** | `Burrow` / Cloud | **M** | Require explicit workspace owner approval of requested capabilities/egress hosts before first invocation, and revoke dispatch + iframe mounts immediately on disable. |
