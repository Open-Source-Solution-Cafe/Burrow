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
