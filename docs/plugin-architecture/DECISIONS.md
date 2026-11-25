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

### D2. `burrow-cloud` Tenancy & D1 Cloud Path Policy (`Status: Decided — Deprecated Now, Remove in Follow-Up Release`)
- **Decision**: Production `burrow-cloud` runs on **PostgreSQL** across shared multi-tenant (`TENANT_MODE=shared`) and dedicated (`TENANT_MODE=dedicated`) deployments using per-plugin isolated PostgreSQL schemas/roles (`plugin_<id>`) and `plugin_cloud_*` tables.
- **D1 Cloud Code Disposition (`Decided 2026-11-22`)**: Deprecate the Cloudflare Workers + D1 harness inside `burrow-cloud` (`burrow-cloud/src/worker.ts`, `burrow-cloud/tests/plugins/d1-cloud-plugins.test.ts`, `burrow-cloud/wrangler.jsonc`) **now**, and remove it in a follow-up release once PostgreSQL cloud runs in production. Keeping it doubles maintenance and retains weaker SQLite tripwire isolation inside a private SaaS codebase.
- **Self-Hosted D1 Boundary**: Public `Burrow` retains full Cloudflare Workers + D1 support and keeps all D1 tests inside public `Burrow`.

### D3. `@burrow/sdk` & `@burrow/eslint-plugin` Licensing (`Status: Checks 1 & 2 Verified · Pending Legal Sign-Off on Check 3`)
- **Decision**: `packages/sdk/package.json` and `packages/eslint-plugin/package.json` declare `"license": "MIT"`, while core runtime packages (`@burrow/core`, `@burrow/web`, `@burrow/worker`, `@burrow/plugins`, root `burrow`) remain `"AGPL-3.0-or-later"`.
- **Verification Record**: See [LICENSING.md](./LICENSING.md):
  1. **No AGPL core code copied**: Verified `packages/sdk` and `packages/eslint-plugin` contain zero imports from `@burrow/core`/`src/` and duplicate no AGPL enforcement code (`safe-fetch`, `plugin-storage`, `postgres-isolation`, `plugin-db`, `plugin-validate`).
  2. **Sole authorship & consent**: `git log` confirms sole authorship (`Teelon Mitchell <28550464+Teelon@users.noreply.github.com>`), with future contributions covered by [CLA.md](../../CLA.md).
  3. **Legal counsel confirmation (`Pending Legal Review`)**: Lawyer review needed to confirm whether plugins importing `@burrow/core` (not just `@burrow/sdk`) constitute derivative works under AGPL and sign off on published guidance in [LICENSING.md](./LICENSING.md).

### D4. Threat Model, DB Enforcement & SQLite Tripwire (`Status: Updated 2026-11-22`)
- **Decision**: Plugins are installed at the **operator's discretion** (self-hosters choose their own plugins). The platform's job is to make the safe path the default and block common vulnerability classes (SQLi, XSS, SSRF, IDOR, CSRF, path traversal, secret leaks, resource exhaustion, supply-chain risks) even from careless plugin code. A hostile-code V8 isolate sandbox is **not** required for self-hosted installs (accepted runtime limitations are documented in [RESIDUAL-RISKS.md](./RESIDUAL-RISKS.md)).
- **Database Enforcement Boundary**:
  - **PostgreSQL**: Enforces true database-level isolation per plugin via a separate non-login schema owner (`plugin_<id>_owner`), a dedicated `LOGIN` `NOINHERIT` query role pool (`plugin_<id>_role` with locked `search_path`, `statement_timeout`, `lock_timeout`, and connection limits), a short-lived `plugin_<id>_migrator` role for DDL, `REVOKE ALL` on core/sibling objects, explicit `manifest.coreTables` read grants, DDL `SECURITY INVOKER` event triggers, and strict migration-time FK validation (`ON DELETE CASCADE`).
  - **SQLite / Cloudflare D1**: Lacks database roles, schemas, and `GRANT`/`REVOKE`. `assertPluginSqlAllowed()` on SQLite/D1 is explicitly a **best-effort AST/lexer tripwire for operator-trusted plugins**, **NOT** a security isolation boundary.
- **Operations & Kill Switch**: Instances support `PLUGINS_DISABLED` (`*` or comma-separated plugin IDs) to shut down misbehaving plugins without a redeploy (`DISABLED_PLUGINS` remains as a deprecated alias with a startup warning).
- **Cloud Boundary**: Shared multi-tenant `burrow-cloud` stays **curated and instance-wide only** (per-workspace installation of arbitrary plugin code on cloud is strictly prohibited). Future untrusted multi-tenant runtime isolation (Workers for Platforms + Outbound Worker + sandboxed `<iframe>` UI) remains documented in `docs/plugin-architecture/UNTRUSTED.md` as a separate later phase.

### D5. Core Domain Scope & Dogfooding Boundaries (`Status: Confirmed 2026-11-22`)
- **Decision**: Confirmed — Notepads (`notepads`, `notepads_fts`, `edit_locks`, `notepad_links`) and Core Kanban tables (`boards`, `board_columns`, `cards`) remain in core permanently due to deep transactional and FK coupling (`cards(notepad_id, kind) -> notepads(id, kind)` and `saveContentBatch`). Revisit only if a future plugin demonstrates a concrete need. Dogfooding is applied to `burrow-cloud` plugins, `publicSharing`, `workspaceExport`, and the `estimation` showcase plugin (`cards.card_type = 'estimate'`).

---

## Resolved Operational & Release Decisions (2026-11-22)

1. **`burrow-cloud/legacy/` Removal (`Decided`)**: Remove `burrow-cloud/legacy/` after the PostgreSQL cloud deployment has run in production for **one stable release**. Before deleting it, create an annotated git tag `legacy-node-pg-final` on the last commit containing `legacy/`.
2. **Hono Plugin RPC Pattern (`Decided`)**: Each plugin exports its own route type and a small typed client helper in its web package (`hc<typeof pluginRouter>('/api/plugins/<id>')` or typed fetch wrapper); core remains unaware of plugin route types (`hc<AppType>` stays core-only). Revisit a combined RPC abstraction only once 2–3 real plugins exist.
3. **Publishing `@burrow/sdk` (`Decided + Registry Checked`)**: Publish `@burrow/sdk` (and `@burrow/eslint-plugin`) to **public npm as `0.x` (labeled unstable)** once the red-team pass is clean (avoiding GitHub Packages auth friction for community authors).
   - **npm Scope Verification (`2026-11-22`)**: `@burrow/sdk` (`HTTP 404`) and `@burrow/eslint-plugin` (`HTTP 404`) have zero published packages, and `@burrow/*` search returned `0` results; however, unscoped `burrow` exists under maintainer `vjpr` and `https://www.npmjs.com/org/burrow` returned `403` unauthenticated. Confirm `@burrow` npm org ownership/availability (or adopt an alternate scope) before publishing.

## Canonical Merge Order (After Red Team)
1. Run the red team against `feat/plugin-hardening` and fix all **Critical** and **High** findings; re-run until clean.
2. In `Burrow`: `git switch master && git merge --no-ff feat/plugin-hardening` *(never squash)*.
3. In `burrow-cloud`: update `vendor/burrow` to the new `Burrow` `master` merge commit and run `node scripts/check-pinned-burrow.mjs`.
4. In `burrow-cloud`: `git switch main && git merge --no-ff feat/plugin-hardening` *(never squash)*.
5. Tag both repositories at their merge commits (`vX.Y.Z` / release tags) for clean rollback.
