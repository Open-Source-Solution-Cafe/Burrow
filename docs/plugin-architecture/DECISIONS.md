# Architectural Decisions & Open Questions

All default assumptions below were adopted so implementation could proceed autonomously on `feat/plugin-architecture`. Items marked **Pending Owner** require explicit sign-off before merging to `master` / `main`.

---

## Adopted Default Assumptions

### D1. Postgres Adapter Policy (`Status: Updated 2026-11-22`)
- **Decision**: Hosted cloud runs on **PostgreSQL** (`postgres` driver), while public core keeps **both SQLite/D1 and PostgreSQL** adapters. Plugin runtime infrastructure (`PluginDb`, `runPluginMigrations`, `src/server/index.ts`) must support both SQLite/D1 and PostgreSQL dialects cleanly.
- **Handling**: Plugins declare supported `dialects?: ('sqlite' | 'postgres')[]` in `PluginManifest`. `PluginDb` translates parameterized queries (`?` → `$1..$n`) and safe portability idioms across dialects, and `runPluginMigrations` executes inside `pg_advisory_xact_lock` on Postgres and `db.batch()` / transactions on D1/SQLite.

### D2. `burrow-cloud` Tenancy Topology (`Status: Pending Owner`)
- **Decision**: `burrow-cloud` runs multi-tenant shared and dedicated deployments on PostgreSQL using `plugin_cloud_*` schema/tables (with `PluginDb` portability for SQLite/D1 testing). Dedicated tenants provision isolated databases and storage buckets.
- **Owner Action**: Confirm shared-schema vs. per-tenant Postgres database/schema topology prior to production SaaS launch.

### D3. `@burrow/sdk` Licensing (`Status: Pending Owner / Legal Review`)
- **Decision**: `packages/sdk/package.json` declares `"license": "MIT"` while the rest of public `Burrow` (`@burrow/core`, `@burrow/web`, `@burrow/worker`, `@burrow/plugins`, root `package.json`) remains `"AGPL-3.0-or-later"`.
- **Rationale**: Allows community and proprietary plugins (including `burrow-cloud`) to import `@burrow/sdk` TypeScript types and manifest definitions cleanly without copyleft license friction on type contracts.
- **Owner Action**: Legal / maintainer sign-off on dual/MIT licensing for `packages/sdk`.

### D4. Threat Model & Trust Boundary (`Status: Updated 2026-11-22`)
- **Decision**: Plugins are installed at the **operator's discretion** (self-hosters choose their own plugins). The platform's job is to make the safe path the default and block common vulnerability classes (SQLi, XSS, SSRF, IDOR, CSRF, path traversal, secret leaks, resource exhaustion, supply-chain risks) even from careless plugin code. A hostile-code V8 isolate sandbox is **not** required for self-hosted installs.
- **Cloud Boundary**: Shared multi-tenant `burrow-cloud` stays **curated and instance-wide only** (per-workspace installation of arbitrary plugin code on cloud is strictly prohibited). Future untrusted multi-tenant runtime isolation (Workers for Platforms + Outbound Worker + sandboxed `<iframe>` UI) remains documented in `docs/plugin-architecture/UNTRUSTED.md` as a separate later phase.

### D5. Core Domain Scope & Dogfooding Boundaries (`Status: Pending Owner`)
- **Decision**: Notepads (`notepads`, `notepads_fts`, `edit_locks`, `notepad_links`) and Core Kanban tables (`boards`, `board_columns`, `cards`) remain in core due to deep transactional and FK coupling (`cards(notepad_id, kind) -> notepads(id, kind)` and `saveContentBatch`). Dogfooding is applied to `burrow-cloud` plugins, `publicSharing`, `workspaceExport`, and the `estimation` showcase plugin (`cards.card_type = 'estimate'`).
- **Owner Action**: Confirm that keeping Notepads + Core Boards in core aligns with long-term product roadmap.

---

## Open Questions & Implementation Notes for Review

1. **Legacy Postgres/Node Removal in `burrow-cloud`**: Old Node/Postgres code (`server.ts`, `extensions.sql`, `migrator.ts`) has been preserved under `burrow-cloud/legacy/` per Phase 2.5. When should it be permanently removed?
2. **Typed RPC (`hc<AppType>`) vs. Plugin Routes**: Hono's compile-time `hc<AppType>` cannot infer dynamically mounted `/api/plugins/:id/*` routes. Plugin UI components use typed fetch wrappers or plugin-local `hc<PluginAppType>` clients (`hc<typeof pluginRouter>('/api/plugins/<id>')`). Is that pattern acceptable for community authors?
3. **Submodule vs. Published Package**: During branch development, `burrow-cloud` consumes `@burrow/*` from the pinned `vendor/burrow` git submodule via pnpm workspaces. Should `Burrow` publish `@burrow/sdk` to npm/GitHub Packages separately once `v0.5.0` ships?
