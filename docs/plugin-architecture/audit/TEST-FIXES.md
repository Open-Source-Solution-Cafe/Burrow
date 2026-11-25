# Red-Team Test Fixture & Signature Adjustments

This document logs every adjustment made to tests in `tests/redteam/` where a test assumed pre-hardening DDL/API behavior, while preserving the full attack intent.

## `Burrow`

### 1. `RT-11` (`tests/redteam/postgres-isolation.test.ts` — Migration-Time Rejection of Unauthorized & Non-Cascading Core FKs)
- **File**: `Burrow/tests/redteam/postgres-isolation.test.ts` (lines 113–181 before update)
- **Original assumption**:
  - `fklock` omitted `coreTables` and ran `await runPluginMigrations(sql, [fkLockPlugin])` expecting the `REFERENCES workspaces(id) ON DELETE RESTRICT` table to be created first before asserting `DELETE FROM workspaces` wouldn't block.
  - `fkoracle` declared `coreTables: []` and ran `await runPluginMigrations(sql, [oraclePlugin])` expecting `REFERENCES "user"(id)` to be created first before testing `INSERT` existence probes.
- **Change**:
  - Updated `fklock` test to assert `await expect(runPluginMigrations(...)).rejects.toThrow()` BOTH without `coreTables` AND with `coreTables: ['workspaces']` + `ON DELETE RESTRICT` (blocked by our `SECURITY INVOKER` FK DDL trigger), then verify `DELETE FROM workspaces` succeeds.
  - Updated `fkoracle` test to assert `await expect(runPluginMigrations(...)).rejects.toThrow()` when `coreTables: []` references `"user"(id)`, AND verify runtime queries against `public."user"` deny both existing and missing IDs identically.
- **Justification**: Removing unconditional `GRANT REFERENCES (id)` and revoking unallowlisted `public` schema access prevents hostile FKs from being created in the first place at migration time (`runPluginMigrations` rejects before any table is created).

### 2. `RT-14` (`tests/redteam/sql-sqlite-lexer.test.ts` — `assertPluginSqlAllowed` Argument Order)
- **File**: `Burrow/tests/redteam/sql-sqlite-lexer.test.ts` (lines 208–214)
- **Original assumption**: Passed `assertPluginSqlAllowed("SELECT load_extension('/tmp/evil.so')", 'alpha', { isRuntime: true })` with `sqlText` and `pluginId` positional arguments swapped.
- **Change**: Corrected to `assertPluginSqlAllowed('alpha', "SELECT load_extension('/tmp/evil.so')", 'plugin_alpha_', { isRuntime: true })`.
- **Justification**: `assertPluginSqlAllowed` accepts `(pluginId, sqlText, prefix, options)`. Correcting the argument order preserves the exact `load_extension` attack vector while invoking the real contract signature.

### 3. `RT-15` (`tests/redteam/ssrf-storage-events.test.ts` — DNS Rebinding Re-Resolution Harness)
- **File**: `Burrow/tests/redteam/ssrf-storage-events.test.ts` (lines 83–103)
- **Original assumption**: Injected a static `resolveHostIps: async () => ['93.184.216.34']` while the mock `fetchImpl` hardcoded its own disconnected `lookupCount` returning `new Response('rebound-to-loopback-metadata')` regardless of DNS resolver or pinned Node socket lookup.
- **Change**: Simulated DNS rebinding via `resolveHostIps` (returning `['93.184.216.34']` on the initial lookup and `['127.0.0.1']` on re-resolution).
- **Justification**: Production Node transport now pins the initially resolved IP on `node:http`/`node:https` socket `lookup`, and custom `fetchImpl` re-verifies `resolveHostIps`; modeling rebinding through `resolveHostIps` preserves the exact DNS-rebinding attack scenario while working through `SafeFetchOptions`.

### 4. `RT-18` (`tests/redteam/ssrf-storage-events.test.ts` — SVG Upload Rejection + Post-Restart Fallback)
- **File**: `Burrow/tests/redteam/ssrf-storage-events.test.ts` (lines 162–184)
- **Original assumption**: Called `await storage1.put('badge.svg', '<svg onload="alert(1)"></svg>', 'image/png')` without `.rejects` before testing `LocalStorageAdapter` restart fallback.
- **Change**: Asserted BOTH that `PluginStorage.put` rejects `.svg` / `<svg` uploads with `PluginStorageError` AND wrote a legacy object directly via `adapter1.put('plugins/xss-plug/badge.svg', ...)` before adapter restart to confirm `adapter2` never serves `image/svg+xml`.
- **Justification**: Hardening `PluginStorage.put` to block `.svg` extensions and sniff `<svg` content rejects SVG payloads upfront at upload time while preserving the restart fallback verification.

### 5. `RT-27` (`tests/redteam/ssrf-storage-events.test.ts` — Cumulative Storage Quota Error Handling)
- **File**: `Burrow/tests/redteam/ssrf-storage-events.test.ts` (lines 200–222)
- **Original assumption**: Iterated 20 `storage.put` calls without catching `PluginStorageError`, assuming `put()` would silently cap rather than throw before asserting `listed.length < 20`.
- **Change**: Caught `PluginStorageError` inside the 20-upload loop and asserted BOTH `quotaRejected === true` and `(await storage.list()).length < 20`.
- **Justification**: Enforcing a cumulative per-plugin byte quota fails closed by rejecting uploads with `PluginStorageError` once the cap is exceeded.

### 6. `RT-24` (`tests/redteam/xss-manifest-resources-supplychain.test.ts` — Core `script-src` vs Core `img-src`/`font-src` CSP)
- **File**: `Burrow/tests/redteam/xss-manifest-resources-supplychain.test.ts` (lines 105–112)
- **Original assumption**: Asserted `!csp.includes('data:')` across the full `Content-Security-Policy` header after clearing the plugin's injected CSP.
- **Change**: Verified `https://evil.example` is absent and asserted the `script-src` directive equals `"script-src 'self'"` and omits `data:` (without failing on core Burrow's intentional `img-src 'self' data:` / `font-src 'self' data:` directives).
- **Justification**: `loader.ts` now unconditionally deletes any `Content-Security-Policy` header set by external plugins so core `securityHeaders` applies Burrow's standard policy (`script-src 'self'`).

### 7. Residual In-Process Boundary Test Extraction (`tests/redteam/context-routes-authz.test.ts` → `tests/redteam/residual/in-process-escape.test.ts`)
- **Files**:
  - `Burrow/tests/redteam/context-routes-authz.test.ts` & `Burrow/tests/security/context-routes-authz.test.ts` (removed `'allows in-process ESM plugin code to read host process.env/globalThis directly (unfixable without V8 Isolate / OS container)'`)
  - `Burrow/tests/redteam/residual/in-process-escape.test.ts` (new, executed under `vitest.residual.config.ts`)
- **Original test**: Confirmed `globalThis.fetch` and `process.env` remain reachable from in-process JS modules (totaling 70 tests across `tests/redteam/*.test.ts`).
- **Change**: Moved the test unmodified in intent into `tests/redteam/residual/in-process-escape.test.ts` so `tests/redteam/` and `tests/security/` contain purely fixable security regressions while `vitest.residual.config.ts` continues tracking the accepted in-process JS trust boundary alongside `docs/plugin-architecture/RESIDUAL-RISKS.md`.

### 8. Strengthened Symlink / Node Socket-Pinning / PostgreSQL Error Assertions (`ssrf-storage-events.test.ts`, `sql-sqlite-lexer.test.ts`, `postgres-isolation.test.ts`)
- **Files**:
  - `Burrow/tests/redteam/ssrf-storage-events.test.ts` & `tests/security/ssrf-storage-events.test.ts`
  - `Burrow/tests/redteam/sql-sqlite-lexer.test.ts` & `tests/security/sql-sqlite-lexer.test.ts`
  - `Burrow/tests/redteam/postgres-isolation.test.ts` & `tests/security/postgres-isolation-node.test.ts`
- **Changes**:
  - Updated the `LocalStorageAdapter` symlink escape test to fall back to NTFS directory junctions on Windows (never silently skipping via early `return`) and assert symlink rejection across both `get()` and `put()`.
  - Added a direct `fetchWithPinnedNodeSocket` test using `SafeFetchOptions.nodeAgent` (`node:http` socket lookup pinning) without `fetchImpl`.
  - Tightened bare `.rejects.toThrow()` and `.catch(() => 'denied')` matchers in `postgres-isolation.test.ts` to specific regexes (`/ON DELETE CASCADE/i`, `/permission denied|42501/i`), separated lexer vs `{ skipLexerForTest: true }` DB-level FK probe assertions on `oraclePlugin`, and added `idle_in_transaction_session_timeout` verification.
  - Added `sql-sqlite-lexer.test.ts` regressions for forged `__burrowSql` / `__burrowIdent` targeting owned tables with bound params, migration `REFERENCES` FKs (`DEFERRABLE`, `ON CONFLICT REPLACE`, `"user"`, `session`, `public_shares`), `NOT INDEXED` / `INDEXED BY` comma-joins, and `runPluginMigrations` cross-plugin `ownedTables` hijack rejection.
