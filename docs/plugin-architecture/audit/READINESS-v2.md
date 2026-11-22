# Burrow Plugin System — Readiness Re-Audit (v2, Hardened Safe-by-Default Architecture)

**Date**: 2026-11-22  
**Branch**: `audit/plugin-readiness`  
**Threat Model Reference**: [DECISIONS.md](../DECISIONS.md#d4-threat-model-and-trust-boundary)  
**Verdict**: **PASS — Production-Ready for Curated First-Party & Self-Hosted Plugins**

---

## 1. Executive Summary

Following the initial readiness audit ([READINESS.md](./READINESS.md)) and amended threat model ([DECISIONS.md](../DECISIONS.md)), all Phase A, Phase A+ (Safe-by-Default SDK), Phase B (Dual-Dialect PostgreSQL + SQLite/D1), Phase C (Publishable `@burrow/sdk` & Card Type UI), and Phase D (Admin/Consent UI & Registry Standard) items have been implemented and verified by automated unit, Worker, and PostgreSQL 17 integration suites.

Under the documented trust boundary, operators explicitly choose installed plugins, shared multi-workspace SaaS remains curated and instance-wide only, and the platform blocks major vulnerability classes by default via safe-by-default SDK APIs, runtime middleware, SQL/egress/storage guards, static ESLint rules, and offline supply-chain checks.

---

## 2. OWASP-Style Security Verification Matrix

All 12 security & isolation controls have been verified with dedicated adversarial tests that fail when unguarded and pass under the hardened runtime:

| Vulnerability Category | Defense Mechanism (Implementation) | Status | Proving Automated Test |
| :--- | :--- | :--- | :--- |
| **SQL Injection** | Lexer-aware comment/identifier/dollar-quote stripping, multi-statement rejection, `WHERE`/`HAVING` unparameterized literal block, `sql` template tag, `db.table('name')` identifier helper (`src/core/plugins/plugin-db.ts`, `packages/sdk/src/index.ts`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `1. SQL Injection: blocks lexer desync, dollar-quoting, SELECT INTO, MERGE, UNION, unparameterized WHERE literals, and multi-statements; allows sql`` + db.table()` |
| **Cross-Site Scripting (XSS) & CSP** | Escaped React default rendering, allowlist-based `sanitizePluginHtml()`, `sanitizePluginProps()` on mention/card UI slots, un-loosenable strict core `script-src 'self'` CSP (`packages/sdk/src/index.ts`, `src/core/middleware/security.ts`, `src/core/plugins/loader.ts`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `2. XSS & CSP: sanitizePluginHtml and sanitizePluginProps strip executable payloads and core keeps strict CSP headers` |
| **Server-Side Request Forgery (SSRF) & Egress** | `ctx.fetch` blocks private/loopback/CGNAT/link-local/metadata IPv4/IPv6 & `.nip.io`/integer hosts, resolves DNS against private IPs, re-validates every HTTP redirect hop, enforces `manifest.network` allowlist, timeout & response byte caps (`src/core/plugins/safe-fetch.ts`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `3. SSRF & Egress: ctx.fetch blocks private/loopback/metadata IPs, DNS rebinding, unsafe redirects, oversized payloads, and undeclared hosts` |
| **Broken Access Control, Authz & IDOR** | Default-deny authentication on plugin routes (opt-in `{ public: true }` requires `routes:public`), `ctx.requireRole()`, `ctx.requireWorkspaceAccess()` resource scope verification, stripped `ctx.env`/`ctx.infra` for third-party plugins, SQL blocks on `_worker_runtime_config`/`user`/`session`/`account`/`invites.token_hash`/cross-plugin tables/unscoped core reads (`src/core/plugins/loader.ts`, `src/core/plugins/plugin-db.ts`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `4. Authz, IDOR & Table Isolation: default-deny routes, requireRole, requireWorkspaceAccess, stripped env/infra, and scoped DB views` |
| **CSRF, CORS & HTTP Method Safety** | Core `csrfProtection()` (`Sec-Fetch-Site`, `Origin` check), plugin CORS header stripping, AsyncLocalStorage `GET`/`HEAD` write lock blocking `db.execute()`/`db.batch()` on HTTP reads (`src/core/plugins/loader.ts`, `src/core/plugins/plugin-db.ts`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `5. CSRF, CORS & GET-Write Lock: inherits CSRF rejection, strips untrusted CORS headers, and blocks DB writes inside GET handlers` |
| **Input Validation** | `ctx.defineRoute({ method, path, schemas, handler })` validating `params`, `query`, and `body` via Zod schemas (`400` on invalid input); `validatePluginDirectory()` fails unvalidated mutable routes (`src/core/plugins/loader.ts`, `scripts/plugin-validate.mjs`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `6. Input Validation: ctx.defineRoute enforces Zod schemas (params, query, body) and plugin:validate rejects unvalidated mutable routes` |
| **Path Traversal & Unsafe File Uploads** | `ctx.storage` confines keys under `plugins/<id>/`, rejects `..`, `%2e`, `\`, leading `/`, Windows drive letters, null bytes, >5 MB payloads, and active content MIME types (`text/html`, `image/svg+xml`, JS) (`src/core/plugins/plugin-storage.ts`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `7. Path Traversal & Uploads: ctx.storage prefixes plugins/<id>/, blocks traversal/null bytes/oversized/XSS content types` |
| **Secrets Exposure & Log Redaction** | Scoped `ctx.config` limited to `manifest.configKeys` (core reserved secrets blocked), `ctx.log` & Hono route/event error handlers redact secret values & inline credentials (`src/core/plugins/logger.ts`, `src/core/plugins/loader.ts`, `src/core/plugins/event-bus.ts`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `8. Secrets & Log Redaction: ctx.config exposes only declared keys; ctx.log and error responses redact secrets` |
| **Resource Abuse & Kill Switch** | Per-handler timeout (`504`), per-plugin rate limit (`429`), `PluginDb` timeout (`3s`) and `maxRows` (`500`) cap, non-blocking `emitAfter` dispatch, `DISABLED_PLUGINS` env kill switch, and consent-gated `POST /api/plugins/:id/toggle` (`503` when disabled) (`src/core/plugins/loader.ts`, `src/core/plugins/runtime-state.ts`, `src/core/routes/plugins-admin.ts`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `9. Resource Abuse & Kill Switch: enforces handler timeouts (504), rate limits (429), DB row limits, non-blocking emitAfter, DISABLED_PLUGINS, and /api/plugins toggle consent` |
| **Dependency & Supply Chain Risk** | Offline validator `pnpm run plugin:validate` rejects lifecycle scripts (`preinstall`/`install`/`postinstall`/`prepare`), unpinned deps (`*`/`^`/`~`/URLs), missing lockfiles, disallowed licenses, and offline/audit CVEs (`scripts/plugin-validate.mjs`, `scripts/check-licenses.mjs`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `10. Supply Chain: validatePluginDirectory blocks postinstall scripts, unpinned versions, missing lockfile, copyleft deps, and offline CVEs` |
| **Static Security Analysis** | `@burrow/eslint-plugin` rules block `eval()`, `new Function()`, string timers, unsanitized `innerHTML`/`dangerouslySetInnerHTML`, raw `fetch()`, `process.env`, string-concatenated SQL, and `child_process`/`vm` imports (`packages/eslint-plugin/src/index.js`) | **PASS** | `tests/audit/plugin-isolation-adversarial.test.ts` — `11. Static Checks (@burrow/eslint-plugin): flags eval, new Function, unsanitized HTML, raw fetch, process.env, string SQL, and child_process` |
| **PostgreSQL & SQLite Dual-Dialect Isolation** | `PluginDb` & `runPluginMigrations()` detect dialect, rewrite `?` → `$1..$n`, `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, `MAX(0,)` → `GREATEST(0,)`, synchronize via `pg_advisory_xact_lock`, provision `plugin_<id>` schemas, and reject unsupported dialects (`src/core/plugins/plugin-db.ts`, `src/core/plugins/migrations.ts`) | **PASS** | `tests/adapters/plugin-postgres-node.test.ts` — `sqlite plugin runtime contract` & `postgres plugin runtime contract` (real PostgreSQL 17) |

---

## 3. Re-Graded Readiness Summary (Parts A–D)

| Area | Prior Audit | Current Grade | Summary of Changes Verified |
| :--- | :--- | :--- | :--- |
| **Part A.1 — Dialect Support** | PARTIAL | **PASS** | PostgreSQL 17 + SQLite/D1 full parity in `PluginDb` & `runPluginMigrations`, `pg_advisory_xact_lock` concurrency protection, `manifest.dialects` enforcement, per-plugin PG schema creation. |
| **Part A.2 — Isolation & Safety** | FAIL | **PASS** | Safe-by-default SDK (`ctx.fetch`, `ctx.storage`, `ctx.config`, `ctx.log`, `ctx.defineRoute`, `sql`` `, `sanitizePluginHtml`), default-deny routes, CSP/CORS/CSRF inheritance, SQL lexer & unscoped-table guardrails, dependency graph ordering. |
| **Part A.3 — Lifecycle & Admin UI** | PARTIAL | **PASS** | Consent-gated enable/disable toggle (`/api/plugins`), `Settings → Plugins` (`PluginsSection.tsx`) displaying version/permissions/network/configKeys, instance-managed lock indicator, `cardType` selection in UI (`QuickAddCard.tsx`, `CardPanel.tsx`). |
| **Part A.4 — Operations & Tooling** | PARTIAL | **PASS** | Redacted `ctx.log` per plugin, route timeouts (`504`), rate limits (`429`), `DISABLED_PLUGINS` kill switch, `@burrow/eslint-plugin`, offline `pnpm run plugin:validate`, documented registry & 11-item checklist ([REGISTRY.md](../REGISTRY.md)). |
| **Part B — SDK Publishability** | FAIL | **PASS** | `@burrow/sdk` builds ESM JS + `.d.ts` into `packages/sdk/dist/` (`pnpm --dir packages/sdk run build`) with clean `exports`, `files`, and `peerDependencies`. |

---

## 4. Open Questions & Future Phase Work

- **Untrusted Multi-Workspace Execution**: If third-party community plugins are later opened for per-workspace installation on shared hosting, run plugin code in isolated V8 isolates / Dynamic Worker Loader workers as outlined in [UNTRUSTED.md](../UNTRUSTED.md).
- **Automated NPM Registry Publish**: Run `pnpm publish` from `packages/sdk` and `packages/eslint-plugin` during release tagging when ready for external package distribution.
