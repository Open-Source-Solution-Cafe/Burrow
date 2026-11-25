# Burrow Plugin Architecture — Implementation Handoff

**Branch**: `fix/redteam-1` (lineage: `feat/plugin-architecture` → `feat/plugin-hardening` → `redteam/plugin-hardening-review` → `fix/redteam-1`)  
**Baseline branches preserved untouched**: `Burrow` `master` (`c26d0ae`), downstream repo `main` (`d025c14`)  
**Historical audit snapshot preserved**: `audit/plugin-readiness` (never rewritten; see [DECISIONS.md](./DECISIONS.md))

---

## 1. Summary of Implemented Architecture

Burrow exposes a safe-by-default, capability-scoped plugin architecture across server (Node PostgreSQL / SQLite & Cloudflare Workers D1) and web (Vite + React + TanStack Router) while keeping public Burrow 100% standalone and free of commercial coupling (`node scripts/check-decoupling.mjs` verified with 0 violations).

### Workspace & Package Split (`Burrow`)
- **`packages/sdk` (`@burrow/sdk`)**: Publishable MIT-licensed contract package building ESM + `.d.ts` into `dist/` (`PluginManifest`, `coreTables`, `network`, `configKeys`, `WeakSet`-branded `sql` template tag and `db.table()` identifiers, `db.from()` structured query builder, `sanitizePluginHtml()`, `sanitizePluginProps()`, `ctx.defineRoute`, `ctx.requireRole`, `ctx.requireWorkspaceAccess`, `ctx.fetch`, `ctx.storage`, `ctx.log`, `ctx.config`, `formatPluginConsentSummary`). Plugins export their own route types + typed web client helpers (`hc<typeof pluginRouter>`) independently of core `AppType`. See [LICENSING.md](./LICENSING.md) for MIT/AGPL boundary checks.
- **`packages/eslint-plugin` (`@burrow/eslint-plugin`)**: MIT static analysis rules (`no-unsafe-eval`, `no-unsanitized-html`, `no-raw-fetch`, `no-process-env`, `no-string-sql`, `no-child-process`) executed by `pnpm run plugin:validate`.
- **`packages/core` (`@burrow/core`)**: Hono app composition (`createCoreApp`), `PluginEventBus`, `MentionSourceRegistry`, `plugin_migrations` runner, `PluginDb`, PostgreSQL database-enforced isolation (`provisionPluginPostgresIsolation`, `withPluginPostgresRole`), SSRF-hardened `safe-fetch`, prefix-scoped `plugin-storage`, secret-redacting `logger`, and `PLUGINS_DISABLED` (`*` or comma list; deprecated alias `DISABLED_PLUGINS`) + `/api/plugins` admin toggle UI.
- **`packages/web` (`@burrow/web`)**: `mountBurrowWeb({ plugins })`, `createBurrowRouter(plugins)`, `WebPluginRegistryProvider`, prop sanitization across slots, card type selector (`QuickAddCard` / `CardPanel`), and Workspace Settings → Installed Plugins (`PluginsSection`).
- **`packages/plugins/*`**: `hello`, `public-sharing`, `workspace-export`, `estimation`, and `_template` (plus [AUTHORING.md](./AUTHORING.md) & [REGISTRY.md](./REGISTRY.md)).

### Downstream Plugin Composition (`packages/*`)
- Downstream consumers consume `@burrow/sdk`, `@burrow/core`, `@burrow/web`, and `@burrow/worker` via pnpm workspaces pinned to an exact `Burrow` Git commit SHA.
- Never copy files manually between repositories; update the pinned submodule commit instead.

---

## 2. Database & Isolation Model
- **Public Burrow migration `0006_add_card_type.sql`** (synced across `migrations/`, `migrations/postgres/`, and `src/worker/d1-migrations.ts`): additive non-null `cards.card_type TEXT NOT NULL DEFAULT 'task'`.
- **PostgreSQL Database-Level Isolation (`PASS`)**: Every plugin runs on its own `LOGIN` `NOINHERIT` connection pool role (`plugin_<id>_role`) against a `plugin_<id>` schema owned by a separate non-login `plugin_<id>_owner` role (migrations run under a short-lived `plugin_<id>_migrator` role), with `REVOKE ALL` across core/sibling schemas and `PUBLIC` advisory locks, server-locked timeouts & `search_path`, selective FK `ON DELETE CASCADE` + explicit `manifest.coreTables` `SELECT` grants (excluding `invites.token_hash`), and `SECURITY INVOKER` DDL event triggers blocking functions/triggers/extensions and cross-schema DDL.
- **SQLite / Cloudflare D1 Guard (`PARTIAL` — Best-Effort Tripwire)**: SQLite and D1 have no database roles, schemas, or `GRANT`/`REVOKE`; `assertPluginSqlAllowed()` (`node-sql-parser` + linear lexer) operates purely as a best-effort tripwire for operator-trusted plugins, not a security isolation boundary. See [RESIDUAL-RISKS.md](./RESIDUAL-RISKS.md).

---

## 3. Quick Verification Commands

In `Burrow`:
```powershell
pnpm --dir packages/sdk run build
pnpm run check:ci
pnpm exec vitest run --config vitest.redteam.config.ts
pnpm exec vitest run --config vitest.residual.config.ts
pnpm exec wrangler deploy --dry-run
```

*(Note: `pnpm run check:ci` runs `check-version`, `check-sync`, `build`, `check-basalt`, `check-decoupling`, `check-licenses`, `tsc -b`, `eslint --max-warnings=0 .`, and the full Unit + SQLite + PostgreSQL 17 + Cloudflare Worker test suite.)*

In downstream workspace consumers:
```powershell
node scripts/check-pinned-burrow.mjs
pnpm exec tsc --noEmit
pnpm test
pnpm run build:web
```

---

## 4. Merge & Submodule Pinning Runbook (Critical)

1. **Red-Team & Security Gate First**:
   - Run the red-team (`vitest.redteam.config.ts`), residual (`vitest.residual.config.ts`), and full `pnpm run check:ci` suites on `fix/redteam-1`, fix all Critical and High findings, and re-run until clean before opening PRs / merging.
2. **NEVER Squash-Merge `Burrow`**:
   - Downstream repositories pin exact `Burrow` commit SHAs in `vendor/burrow`. Squash-merging rewrites history and orphans any `vendor/burrow` gitlink referencing commits on `fix/redteam-1`.
   - Always merge `Burrow`: `git switch master && git merge --no-ff fix/redteam-1` (never squash).
3. **Re-Pin Downstream Submodule After Merge**:
   - After merging `Burrow` onto `master`, record the merged commit hash (`MERGED_SHA`), update `vendor/burrow` in the downstream repo (`git -C vendor/burrow fetch origin ; git -C vendor/burrow checkout <MERGED_SHA>`), commit the updated gitlink + `pnpm-lock.yaml`, and verify with `node scripts/check-pinned-burrow.mjs`.
4. **Merge Downstream with `--no-ff` & Tag Both Repos**:
   - Merge downstream `fix/redteam-1` into `main` using `git merge --no-ff` and tag both repositories at their merge commits for clean rollback.

---

## 5. Governance & Licensing References
See [DECISIONS.md](./DECISIONS.md) (decisions `D1`–`D5`, npm `0.x` unstable publish plan, and `@burrow` scope verification) and [LICENSING.md](./LICENSING.md) (MIT vs. AGPL boundary verification).
