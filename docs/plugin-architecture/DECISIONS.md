# Architectural Decisions & Open Questions

All default assumptions below were adopted so implementation could proceed autonomously on `feat/plugin-architecture` and `feat/plugin-hardening`. Items marked **Pending Owner** require explicit sign-off before merging to `master` / `main`.

## Branch Lineage & Audit History Note

- **Canonical Hardening Branch**: `feat/plugin-hardening` (created in both `Burrow` and `burrow-cloud` with lineage `feat/plugin-architecture -> feat/plugin-hardening`).
- **Preserved Audit History (`audit/plugin-readiness`)**: Initial hardening work landed on `audit/plugin-readiness` (recorded at `b945697ee8938b816e84f54b94e32b13b312c764` in `Burrow` and `228446a0d579951bcca121987f752a0f7af77a18` in `burrow-cloud`). Per no-rewrite git safety policy, `audit/plugin-readiness` is left untouched in place and carries those historical commits, while `feat/plugin-hardening` is the canonical branch for all hardening, integration, and merge preparation.

---

## Adopted Default Assumptions

### D1. Postgres Adapter Policy (`Status: Updated 2026-11-22`)
- **Decision**: Hosted cloud runs on **PostgreSQL** (`postgres` driver), while public core keeps **both SQLite/D1 and PostgreSQL** adapters. Plugin runtime infrastructure (`PluginDb`, `runPluginMigrations`, `src/server/index.ts`) must support both SQLite/D1 and PostgreSQL dialects cleanly.
- **Handling**: Plugins declare supported `dialects?: ('sqlite' | 'postgres')[]` in `PluginManifest`. `PluginDb` translates parameterized queries (`?` → `$1..$n`) and safe portability idioms across dialects, and `runPluginMigrations` executes inside `pg_advisory_xact_lock` on Postgres and `db.batch()` / transactions on D1/SQLite.

### D2. `burrow-cloud` Tenancy & D1 Cloud Path Policy (`Status: Pending Owner`)
- **Decision**: Production `burrow-cloud` runs on **PostgreSQL** across shared multi-tenant (`TENANT_MODE=shared`) and dedicated (`TENANT_MODE=dedicated`) deployments using per-plugin isolated PostgreSQL schemas/roles (`plugin_<id>`) and `plugin_cloud_*` tables.
- **D1 Cloud Code Status (`Pending Owner`)**: The Cloudflare Workers + D1 entrypoint (`burrow-cloud/src/worker.ts`, `wrangler.jsonc`) and its E2E contract test (`burrow-cloud/tests/plugins/d1-cloud-plugins.test.ts`) are retained intact as a **Legacy / Portable SQLite Edge Harness**, not the primary production runtime for `burrow-cloud`.
- **Owner Action**: Confirm whether the D1 cloud Worker path in `burrow-cloud` should stay supported for edge portability or be formally deprecated/removed once Postgres cloud deploys stabilize.

### D3. `@burrow/sdk` Licensing (`Status: Pending Owner / Legal Review`)
- **Decision**: `packages/sdk/package.json` and `packages/eslint-plugin/package.json` declare `"license": "MIT"` while the rest of public `Burrow` (`@burrow/core`, `@burrow/web`, `@burrow/worker`, `@burrow/plugins`, root `package.json`) remains `"AGPL-3.0-or-later"`.
- **Rationale**: Allows community and proprietary plugins (including `burrow-cloud`) to import `@burrow/sdk` TypeScript types and security rules cleanly without copyleft license friction on type contracts.
- **Owner Action**: Legal / maintainer sign-off on dual/MIT licensing for `packages/sdk` and `packages/eslint-plugin`.

### D4. Threat Model, DB Enforcement & SQLite Tripwire (`Status: Updated 2026-11-22`)
- **Decision**: Plugins are installed at the **operator's discretion** (self-hosters choose their own plugins). The platform's job is to make the safe path the default and block common vulnerability classes (SQLi, XSS, SSRF, IDOR, CSRF, path traversal, secret leaks, resource exhaustion, supply-chain risks) even from careless plugin code. A hostile-code V8 isolate sandbox is **not** required for self-hosted installs.
- **Database Enforcement Boundary**:
  - **PostgreSQL**: Enforces true database-level isolation per plugin via dedicated `plugin_<id>` schema ownership, `NOLOGIN` `plugin_<id>_role` privileges, `REVOKE ALL` on unapproved core/sibling objects, explicit `manifest.coreTables` read grants, transactional `SET LOCAL ROLE` + pinned `search_path`, and migration execution under the plugin role.
  - **SQLite / Cloudflare D1**: Lacks database roles, schemas, and `GRANT`/`REVOKE`. `assertPluginSqlAllowed()` on SQLite/D1 is explicitly a **best-effort static/lexer tripwire for operator-trusted plugins**, **NOT** a security isolation boundary.
- **Operations & Kill Switch**: Instances support `PLUGINS_DISABLED` (`*` or comma-separated plugin IDs) to shut down misbehaving plugins without a redeploy (`DISABLED_PLUGINS` remains as a deprecated alias with a startup warning).
- **Cloud Boundary**: Shared multi-tenant `burrow-cloud` stays **curated and instance-wide only** (per-workspace installation of arbitrary plugin code on cloud is strictly prohibited). Future untrusted multi-tenant runtime isolation (Workers for Platforms + Outbound Worker + sandboxed `<iframe>` UI) remains documented in `docs/plugin-architecture/UNTRUSTED.md` as a separate later phase.

### D5. Core Domain Scope & Dogfooding Boundaries (`Status: Pending Owner`)
- **Decision**: Notepads (`notepads`, `notepads_fts`, `edit_locks`, `notepad_links`) and Core Kanban tables (`boards`, `board_columns`, `cards`) remain in core due to deep transactional and FK coupling (`cards(notepad_id, kind) -> notepads(id, kind)` and `saveContentBatch`). Dogfooding is applied to `burrow-cloud` plugins, `publicSharing`, `workspaceExport`, and the `estimation` showcase plugin (`cards.card_type = 'estimate'`).
- **Owner Action**: Confirm that keeping Notepads + Core Boards in core aligns with long-term product roadmap.

---

## Open Questions & Implementation Notes for Review

1. **Legacy Postgres/Node Removal in `burrow-cloud`**: Old Node/Postgres code (`server.ts`, `extensions.sql`, `migrator.ts`) has been preserved under `burrow-cloud/legacy/` per Phase 2.5. When should it be permanently removed?
2. **Typed RPC (`hc<AppType>`) vs. Plugin Routes**: Hono's compile-time `hc<AppType>` cannot infer dynamically mounted `/api/plugins/:id/*` routes. Plugin UI components use typed fetch wrappers or plugin-local `hc<PluginAppType>` clients (`hc<typeof pluginRouter>('/api/plugins/<id>')`). Is that pattern acceptable for community authors?
3. **Submodule vs. Published Package**: During branch development, `burrow-cloud` consumes `@burrow/*` from the pinned `vendor/burrow` git submodule via pnpm workspaces. Should `Burrow` publish `@burrow/sdk` to npm/GitHub Packages separately once `v0.5.0` ships?
