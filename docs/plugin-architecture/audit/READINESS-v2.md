# Burrow Plugin System — Readiness Re-Audit (v2, Honest Hardened Assessment)

> **Post-Red-Team Update (`fix/redteam-1`)**: An independent red-team review subsequently identified bypasses against the initial `v2` controls ([RED-TEAM.md](./RED-TEAM.md)). All 28 core findings (`RT-01`..`RT-28`) have since been remediated (per-plugin `LOGIN` role pools, separate schema owners, `SECURITY INVOKER` DDL triggers, `node-sql-parser`, `WeakSet` SQL brands, `ipaddr.js` + DNS socket pinning, `sanitize-html`, default-disabled external consent, and hardened validator checks), promoted into [`tests/security/`](../../../tests/security/), and in-process JS runtime limits are recorded in [RESIDUAL-RISKS.md](../RESIDUAL-RISKS.md).

**Date**: 2026-11-22  
**Branch**: `feat/plugin-hardening` → `redteam/plugin-hardening-review` → `fix/redteam-1`  
**Threat Model Reference**: [RESIDUAL-RISKS.md](../RESIDUAL-RISKS.md) & [DECISIONS.md](../DECISIONS.md#d4-threat-model-db-enforcement--sqlite-tripwire-status-updated-2026-11-22)  
**Verdict**: **PASS (PostgreSQL Production Hosts) / PARTIAL (SQLite & D1 Single-Boundary SQL Guard)** — Ready for curated first-party and operator-chosen self-hosted plugins under the documented in-process trust model.

---

## 1. Honest Scope & Dialect Security Boundaries

Per [DECISIONS.md](../DECISIONS.md), PostgreSQL and SQLite/Cloudflare D1 provide fundamentally different database isolation guarantees:

1. **PostgreSQL (Database-Enforced Isolation — `PASS`)**:
   - Each plugin runs under a dedicated `NOLOGIN NOSUPERUSER` role (`plugin_<id>_role`) owning a dedicated `plugin_<id>` schema.
   - `PUBLIC` and plugin roles have `REVOKE ALL` on core tables, sibling `plugin_*` schemas, `pg_catalog.pg_notify`, and public schema creation; `SELECT` is granted solely on tables explicitly allowlisted in `manifest.coreTables` (column-restricted on `invites` to omit `token_hash`), plus FK `REFERENCES(id)` on core parents.
   - Every query runs inside `BEGIN ... SET LOCAL ROLE "plugin_<id>_role" ... SET LOCAL search_path = "plugin_<id>", public ...` and resets on exit; plugin migrations run as `plugin_<id>_role` (not superuser), followed by `REVOKE CREATE ON SCHEMA`. Database DDL event triggers and `SECURITY DEFINER` utility confinement block `RESET ROLE`, `SET SESSION AUTHORIZATION`, `CREATE FUNCTION`/`TRIGGER`, `COPY ... TO PROGRAM`, and `LISTEN`/`NOTIFY` inside Postgres itself even when the JS lexer is bypassed.
2. **SQLite & Cloudflare D1 (Best-Effort Tripwire — `PARTIAL`)**:
   - SQLite and D1 have **no database users/roles, schemas, or `GRANT`/`REVOKE` permissions**.
   - Therefore `assertPluginSqlAllowed()` (`src/core/plugins/plugin-db.ts`, `migrations.ts`) on SQLite/D1 is explicitly a **best-effort tripwire for operator-trusted plugins**, **not a security isolation boundary**. Any control depending solely on SQL parsing (`SQLite/D1 SQL Injection Tripwire` and `SQLite/D1 Table Access Scope`) is graded **`PARTIAL`** below.

---

## 2. OWASP-Style Security Verification Matrix

| Vulnerability / Control Area | Defense Mechanism & Dialect Reality | Status | Proving Automated Test |
| :--- | :--- | :--- | :--- |
| **PostgreSQL Database Isolation (Bypassing JS Lexer)** | Dedicated `plugin_<id>` schema + `plugin_<id>_role` (`NOLOGIN`), `REVOKE ALL`, `manifest.coreTables` grants, transactional `SET LOCAL ROLE` + pinned `search_path`, DDL event triggers, plugin-role migrations | **PASS** | `tests/adapters/plugin-postgres-node.test.ts` — `enforces database-level PostgreSQL role, schema, search_path, and privilege isolation when the JS lexer is bypassed` |
| **SQL Injection & SQL Guard (PostgreSQL + SDK API)** | Safe `sql` tag, `db.table()`, parameterized statements, comment/dollar-quote/multi-statement rejection, backed by PostgreSQL role/ACL enforcement | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `1. SQL Injection` + `tests/adapters/plugin-postgres-node.test.ts` |
| **SQL Injection & Table Scope (SQLite / D1 Lexer Only)** | `assertPluginSqlAllowed()` rejects `' OR '1'='1`, `"a'b"` desync, `$$...$$`, `UNION SELECT`, `SELECT INTO`, `MERGE`, multi-statements, sensitive tables, and parameterless core `WHERE` tautologies — **best-effort tripwire only** (no engine ACLs on SQLite/D1) | **PARTIAL** | `tests/audit/plugin-isolation-adversarial.test.ts` — `1. SQL Injection` & `4. Authz, IDOR & Table Isolation` *(Reason: JS regex/lexer without DB engine ACLs cannot serve as a hostile-code boundary)* |
| **Cross-Site Scripting (XSS) & CSP** | Escaped React default rendering, allowlist `sanitizePluginHtml()`, `sanitizePluginProps()` on UI slots, strict `script-src 'self'` core CSP | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `2. XSS & CSP` |
| **Server-Side Request Forgery (SSRF) & Egress** | `ctx.fetch` blocks private/loopback/CGNAT/link-local/metadata IPv4/IPv6 & `.nip.io`/integer hosts, DNS rebinding, HTTP redirect hops to private IPs, oversized responses, undeclared hosts (`manifest.network`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `3. SSRF & Egress` |
| **Broken Access Control, Authz & IDOR (App & Postgres)** | Default-deny routes (`401`), `ctx.requireRole()`, `ctx.requireWorkspaceAccess()` IDOR guard, stripped `env`/`infra`, Postgres role/schema ACLs (`42501` without `manifest.coreTables`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `4. Authz, IDOR & Table Isolation` + `tests/adapters/plugin-postgres-node.test.ts` |
| **CSRF, CORS & HTTP Method Safety** | Core `csrfProtection()`, stripped plugin `Access-Control-Allow-Origin`/`Credentials`, `GET`/`HEAD` write lock blocking `db.execute()`/`db.batch()` | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `5. CSRF, CORS & GET-Write Lock` |
| **Input Validation** | `ctx.defineRoute` Zod validation (`params`, `query`, `body` → `400`); `validatePluginDirectory()` fails unvalidated Hono/mutable routes | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `6. Input Validation` |
| **Path Traversal & Unsafe Uploads** | `ctx.storage` confines keys to `plugins/<id>/`; rejects `..`, `%2e`, `\`, `/`, Windows drives, null bytes, >5 MB payloads, HTML/SVG/JS MIME types | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `7. Path Traversal & Uploads` |
| **Secrets Exposure & Log Redaction** | Scoped `ctx.config` limited to `manifest.configKeys`; `ctx.log` and Hono `onError` handlers redact secret values and tokens | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `8. Secrets & Log Redaction` |
| **Resource Abuse & Kill Switch** | Handler timeouts (`504`), per-plugin rate limit (`429`), `PluginDb` row/timeout caps, non-blocking `emitAfter`, `PLUGINS_DISABLED` (`*` or CSV; deprecated alias `DISABLED_PLUGINS` warns), `POST /api/plugins/:id/toggle` consent | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `9. Resource Abuse & Kill Switch` |
| **Dependency & Supply Chain Risk** | Offline validator `pnpm run plugin:validate` rejects lifecycle scripts (`preinstall`/`install`/`postinstall`/`prepare`), unpinned deps, missing lockfiles, disallowed licenses, offline/audit CVEs | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `10. Supply Chain` |
| **Static Security Analysis** | `@burrow/eslint-plugin` rules block `eval`, `new Function`, string timers, unsanitized HTML sinks, raw `fetch`, `process.env`, string SQL, and `child_process`/`vm` | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `11. Static Checks (@burrow/eslint-plugin)` |

---

## 3. Re-Graded Readiness Summary (Parts A–D)

| Area | Prior Audit | Current Grade | Summary & Caveats |
| :--- | :--- | :--- | :--- |
| **Part A.1 — Dialect Support & PG Isolation** | PARTIAL | **PASS** | PostgreSQL 17 enforces per-plugin `NOLOGIN` role, owned schema, `REVOKE ALL`, explicit `coreTables` grants, `SET LOCAL ROLE`, pinned `search_path`, and plugin-role migrations; SQLite/D1 works cleanly with `?`→`$1..$n` & upsert parity. |
| **Part A.2 — Isolation & Safety (Postgres vs SQLite)** | FAIL | **PASS (Postgres) / PARTIAL (SQLite/D1)** | All app-layer guards (XSS, SSRF, Authz, CSRF, Storage, Secrets, Zod) pass; Postgres enforces DB engine boundaries (`PASS`); SQLite/D1 relies on `assertPluginSqlAllowed` best-effort tripwire (`PARTIAL`). |
| **Part A.3 — Lifecycle & Admin UI** | PARTIAL | **PASS** | Consent-gated enable/disable toggle (`/api/plugins`), `Settings → Installed Plugins` (`PluginsSection.tsx`), instance lock indicator, `cardType` UI selection. |
| **Part A.4 — Operations & Tooling** | PARTIAL | **PASS** | Redacted `ctx.log`, route timeouts, rate limits, `PLUGINS_DISABLED` kill switch, `@burrow/eslint-plugin`, offline `pnpm run plugin:validate`, [REGISTRY.md](../REGISTRY.md). |
| **Part B — SDK Publishability** | FAIL | **PASS** | `@burrow/sdk` builds ESM JS + `.d.ts` into `packages/sdk/dist/` cleanly. |
