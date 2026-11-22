# Adversarial Test-Integrity Audit (`TEST-INTEGRITY.md`)

**Date**: 2026-11-22  
**Comparison Span**: `feat/plugin-architecture` → `audit/plugin-readiness` (`c661369` / `b9ae0cd` → `b945697` / `228446a`) → `feat/plugin-hardening`  
**Reviewer Standard**: Every modified test assertion, mock stub, widened expectation, or dropped probe across both repositories is audited below. Whenever a test originally failed because of a gap in runtime code rather than a test-harness bug, the **implementation code** was fixed and the original assertion/probe restored.

---

## 1. `Burrow` — `tests/audit/plugin-isolation-adversarial.test.ts`

| Test / Probe | Original Probe (`c661369`) | Intermediate Change (`0badb91`) | Verdict | Restoration / Action Taken |
| :--- | :--- | :--- | :--- | :--- |
| **1. SQL Guard (`WITH cte AS (SELECT 1 AS "a'b") DELETE FROM workspaces WHERE 'x' = 'x'`)** | Tested exact unparameterized literal `WHERE 'x' = 'x'` | Changed query params in rewrite to `WHERE id = ?` with `['ws_1']` | **Weakened Assertion** | **Restored** original `WHERE 'x' = 'x'` attack alongside parameterized `WHERE id = ?` test; `assertPluginSqlAllowed` blocks both (`''` literal check + `DELETE FROM workspaces`). |
| **1. SQL Guard (`$$...$$` dollar quotes)** | Asserted `WITH cte AS (SELECT $$a'b$$) DELETE FROM workspaces WHERE '1' = '1'` and unprefixed/SELECT dollar quotes | Kept CTE delete test, dropped standalone `SELECT $$...$$ FROM plugin_safe_items` check when `isRuntime` is false | **Partial Drop** | **Code Fixed** (`plugin-db.ts`): moved `rawLexed.hasDollarQuotes` outside `if (options.isRuntime)` so `assertPluginSqlAllowed` always blocks `$$...$$`, and restored explicit tautology check (`WHERE 1 = 1` / `$$...$$`). |
| **2. XSS & CSP (`Content-Security-Policy`)** | Newly added in Phase A+ | Asserted `.not.toContain("'unsafe-inline'")` across whole CSP header, then narrowed to `script-src` | **Legitimate Mock Fix** *(core CSP legitimately permits `style-src 'self' 'unsafe-inline'`)* | **Enhanced** test: still checks `script-src` is strictly `'self'` without `'unsafe-inline'` or `'unsafe-eval'`, AND explicitly verifies plugin-injected `default-src * 'unsafe-inline' 'unsafe-eval'` was stripped/never applied. |
| **4. Zero-Permission Plugin (`permissions: []`)** | Dedicated test importing `zeroPermPlugin` verifying `ctx.env.BETTER_AUTH_SECRET` and `ctx.infra` cannot be used to read/wipe core tables | Merged into Test 4 on an `authz-check` plugin that already had `['db:own', 'routes:api']`, removing the `permissions: []` probe | **Dropped Attack Case** | **Restored** explicit `zeroPermPlugin` (`permissions: []`) probe asserting `ctx.env.BETTER_AUTH_SECRET` is `undefined`, `ctx.infra` is `undefined`, and `ctx.db.query`/`ctx.route`/`ctx.storage.get` all throw permission errors. |
| **4. Arbitrary Mount Path Override & Default-Deny `ctx.route()`** | Dedicated test mounting raw Hono `router.get('/open')` at `mountPath: '/api/arbitrary-root'` | Replaced entirely by `ctx.defineRoute` route without keeping raw `ctx.route` probe or `mountPath` override rejection check | **Dropped Attack Case** | **Restored** explicit probes confirming `ctx.route(router, { mountPath: '/api/arbitrary-root' })` throws `/cannot override mountPath/` and default `ctx.route(router)` (without `{ public: true }`) returns `401` to anonymous callers. |
| **4. Stub Repo `getSession` / `notepads.findByIdInScope`** | — | Mocked BetterAuth `{ user, session }` shape and `notepads.findById` instead of `AuthProvider` `{ userId }` and `notepads.findByIdInScope` | **Legitimate Mock Fix** | Kept accurate `Infrastructure` interface mock shapes matching core services. |
| **7. Memory Storage Adapter (`listObjects`)** | — | Stub implemented `list()` instead of `IStorageAdapter.listObjects()` | **Legitimate Mock Fix** | Kept `listObjects` & `deletePrefix` matching `IStorageAdapter` contract. |
| **9. Admin Consent Summary (`expect(summary).toContain('Quota Test Plugin')`)** | Asserted `summary` contains plugin display name `'Quota Test Plugin'` | Weakened assertion to `expect(summary).toContain('This plugin can:')` after `formatPluginConsentSummary` omitted `manifest.name` | **Weakened Assertion** | **Code Fixed** (`packages/sdk/src/index.ts`): `formatPluginConsentSummary` now includes `${manifest.name} (${manifest.id}) — This plugin can: ...`; **restored** `expect(summary).toContain('Quota Test Plugin')`. |
| **9. Rate Limit Loop (`for (let i = 0; i < 120; i++)`)** | Tested full 120 allowed requests then 121st `429` | Lowered loop count from `120` to `119` because earlier `/slow` request used `quota:anon` bucket | **Masking / Tweaked Boundary** | **Restored** exact `for (let i = 0; i < 120; i++)` burst test using a distinct `x-forwarded-for` client header so all 120 pass and request 121 returns `429`. |
| **9. Env Kill Switch (`PluginRuntimeRegistry('quota')`)** | Called `new PluginRuntimeRegistry('quota')` | Changed test call to `new PluginRuntimeRegistry({ disabledPluginsEnv: 'quota' })` | **Weakened API Ergonomics Test** | **Code Fixed** (`runtime-state.ts`): constructor now supports string shorthand AND `PLUGINS_DISABLED` (`*` wildcard or CSV) plus deprecated `DISABLED_PLUGINS` warning; **restored** string call and added wildcard + deprecation warning assertions. |
| **9. `before*` Throwing Guard & Timeout Probe** | Dedicated probe verifying `PluginEventBus.onBefore('task.created')` rejects cleanly on throw | Dropped from `0badb91` rewrite when converting error-handling probe | **Dropped Attack Case** | **Restored** `onBefore` throwing-guard & hung-guard timeout probe alongside non-blocking `emitAfter` probe. |

---

## 2. `Burrow` — `tests/adapters/plugin-postgres-node.test.ts`

| Test / Probe | Original Assertion | Intermediate Change (`0badb91`) | Verdict | Restoration / Action Taken |
| :--- | :--- | :--- | :--- | :--- |
| **Dialect Refusal Error Match** | `.rejects.toThrow(/does not support active dialect/)` | Widened/altered test regex to `/does not support active database dialect/` to match `manifest.ts` wording | **Weakened / Altered Regex** | **Code Fixed** (`manifest.ts`): updated message to contain exact substring `does not support active dialect`; **restored** original `/does not support active dialect/` assertion. |
| **Database-Level Isolation Proof** | Not present initially (checked only `PluginDb` JS behavior + schema existence) | Not added in `0badb91` | **Missing Critical Security Proof** | **Added** raw-driver bypass suite under `plugin_<id>_role` + `runPluginMigrations(..., { skipLexerForTest: true })` proving PostgreSQL itself rejects core table reads, sibling schema reads, `pg_authid`, `RESET ROLE`, `SET SESSION AUTHORIZATION`, `CREATE FUNCTION`/`TRIGGER`, `COPY ... PROGRAM`, `LISTEN`/`NOTIFY`, and malicious core-table migrations. |

---

## 3. Downstream Repository — Ready & Route Isolation Tests

| Test / Probe | Original Probe (`b9ae0cd`) | Intermediate Change (`096765a`) | Verdict | Restoration / Action Taken |
| :--- | :--- | :--- | :--- | :--- |
| **Dependency Ordering in `createCoreApp`** | Passed `[siblingDependent]` without `'base'` into `createCoreApp(...)` and verified failure | Tested `sortPluginsByDependencies([sibling])` directly without passing into `createCoreApp(...)` | **Weakened Integration Coverage** | **Restored** explicit `createCoreApp(..., { plugins: [sibling] })` assertion confirming `createCoreApp` itself throws `/depends on missing plugin/` (in the downstream readiness test). |
| **Worker Plugin E2E Test** | `createApp({ env, plugins, policy })` | Passed `firstPartyPluginIds` into `createApp` | **Legitimate Evolution** *(external plugins must not override arbitrary mount paths; first-party plugins declare identity)* | Kept explicit `firstPartyPluginIds` passed from the plugin factory. |
| **Cross-Workspace Route Isolation (`routes.test.ts`)** | Covered existing routes | Added `GET /api/plugins` and `POST /api/plugins/:id/toggle` (`self-scoped`) | **Legitimate Coverage Addition** | Verified 109 route isolation assertions pass. |
