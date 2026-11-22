# Burrow Plugin Architecture — Implementation Handoff

**Branch**: `feat/plugin-hardening` (lineage: `feat/plugin-architecture` → `feat/plugin-hardening`)  
**Baseline branches preserved untouched**: `Burrow` `master` (`c26d0ae`), downstream repo `main` (`d025c14`)  
**Historical audit snapshot preserved**: `audit/plugin-readiness` (never rewritten; see [DECISIONS.md](./DECISIONS.md))

---

## 1. Summary of Implemented Architecture

Burrow exposes a safe-by-default, capability-scoped plugin architecture across server (Node PostgreSQL / SQLite & Cloudflare Workers D1) and web (Vite + React + TanStack Router) while keeping public Burrow 100% standalone and free of commercial coupling (`node scripts/check-decoupling.mjs` verified with 0 violations).

### Workspace & Package Split (`Burrow`)
- **`packages/sdk` (`@burrow/sdk`)**: Publishable MIT-licensed contract package building ESM + `.d.ts` into `dist/` (`PluginManifest`, `coreTables`, `network`, `configKeys`, `sql` template tag, `db.table()`, `sanitizePluginHtml()`, `sanitizePluginProps()`, `ctx.defineRoute`, `ctx.requireRole`, `ctx.requireWorkspaceAccess`, `ctx.fetch`, `ctx.storage`, `ctx.log`, `ctx.config`, `formatPluginConsentSummary`).
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
- **PostgreSQL Database-Level Isolation (`PASS`)**: Every plugin receives its own `plugin_<id>` schema and `NOLOGIN NOSUPERUSER` role `plugin_<id>_role`, with `REVOKE ALL` across core/sibling schemas, selective FK `REFERENCES(id)` + explicit `manifest.coreTables` `SELECT` grants (excluding `invites.token_hash`), transactional `SET LOCAL ROLE` + pinned `search_path`, DDL event triggers blocking functions/triggers/cross-schema DDL, and migrations executed under `plugin_<id>_role` (never superuser).
- **SQLite / Cloudflare D1 Guard (`PARTIAL` — Best-Effort Tripwire)**: SQLite and D1 have no database roles, schemas, or `GRANT`/`REVOKE`; `assertPluginSqlAllowed()` operates purely as a best-effort static/lexer tripwire for operator-trusted plugins, not a security isolation boundary.

---

## 3. Quick Verification Commands

In `Burrow`:
```powershell
pnpm --dir packages/sdk run build
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
node scripts/check-pinned-burrow.mjs
pnpm exec tsc --noEmit
pnpm test
pnpm run build:web
```

---

## 4. Merge & Submodule Pinning Runbook (Critical)

1. **NEVER Squash-Merge `Burrow`**:
   - Downstream repositories pin exact `Burrow` commit SHAs in `vendor/burrow`. Squash-merging rewrites history and orphans any `vendor/burrow` gitlink referencing commits on `feat/plugin-hardening`.
   - Always merge `Burrow` (`feat/plugin-hardening` -> `master`) using a standard merge commit (`git merge --no-ff`) or fast-forward merge (`git merge --ff-only`).
2. **Re-Pin Downstream Submodule After Merge**:
   - After merging `Burrow` onto `master`, record the merged commit hash (`MERGED_SHA`), update `vendor/burrow` in the downstream repo (`git -C vendor/burrow fetch origin ; git -C vendor/burrow checkout <MERGED_SHA>`), commit the updated gitlink + `pnpm-lock.yaml`, and verify with `node scripts/check-pinned-burrow.mjs`.

---

## 5. Open Owner Decisions
See [DECISIONS.md](./DECISIONS.md) (`D1`–`D5` and Open Questions 1–3, including D1 edge test harness disposition) before merging `feat/plugin-hardening` to `master` / `main`.
