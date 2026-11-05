import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName, isTable } from 'drizzle-orm';
import * as d1Schema from '../../src/core/adapters/db/d1/schema';
import * as postgresSchema from '../../src/core/adapters/db/postgres/schema';

describe('schema parity between D1 and Postgres', () => {
  // Collect all D1 tables
  const d1Tables = new Map<string, { exportName: string; table: any }>();
  for (const [exportName, val] of Object.entries(d1Schema)) {
    if (isTable(val)) {
      const tableName = getTableName(val);
      d1Tables.set(tableName, { exportName, table: val });
    }
  }

  // Collect all Postgres tables
  const pgTables = new Map<string, { exportName: string; table: any }>();
  for (const [exportName, val] of Object.entries(postgresSchema)) {
    if (isTable(val)) {
      const tableName = getTableName(val);
      pgTables.set(tableName, { exportName, table: val });
    }
  }

  it('contains matching table definitions for all core application tables', () => {
    // Dialect-specific tables to ignore (e.g. SQLite FTS5 virtual table notepads_fts)
    const dialectSpecificTables = new Set(['notepads_fts']);

    for (const [tableName, { exportName }] of d1Tables.entries()) {
      if (dialectSpecificTables.has(tableName)) continue;

      expect(
        pgTables.has(tableName),
        `Expected Postgres schema to define table "${tableName}" (exported as ${exportName})`,
      ).toBe(true);
    }
  });

  it('ensures all core application table columns in D1 exist in Postgres', () => {
    // Better Auth tables use camelCase column names in SQLite and snake_case in Postgres,
    // but share identical TypeScript property keys.
    const authTables = new Set(['user', 'session', 'account', 'verification']);
    const dialectSpecificTables = new Set(['notepads_fts']);

    for (const [tableName, { table: d1Table }] of d1Tables.entries()) {
      if (dialectSpecificTables.has(tableName) || authTables.has(tableName)) continue;

      const pgEntry = pgTables.get(tableName);
      expect(pgEntry, `Postgres table "${tableName}" should exist`).toBeDefined();

      const d1Columns = Object.values(getTableColumns(d1Table)).map((col: any) => col.name);
      const pgColumns = new Set(
        Object.values(getTableColumns(pgEntry!.table)).map((col: any) => col.name),
      );

      for (const colName of d1Columns) {
        expect(
          pgColumns.has(colName),
          `Expected table "${tableName}" in Postgres to have column "${colName}"`,
        ).toBe(true);
      }
    }
  });

  it('ensures all table property keys in D1 exist in Postgres tables', () => {
    const dialectSpecificTables = new Set(['notepads_fts']);

    for (const [tableName, { table: d1Table }] of d1Tables.entries()) {
      if (dialectSpecificTables.has(tableName)) continue;

      const pgEntry = pgTables.get(tableName);
      expect(pgEntry, `Postgres table "${tableName}" should exist`).toBeDefined();

      const d1Keys = Object.keys(getTableColumns(d1Table));
      const pgKeys = new Set(Object.keys(getTableColumns(pgEntry!.table)));

      for (const key of d1Keys) {
        expect(
          pgKeys.has(key),
          `Expected table "${tableName}" in Postgres to have property key "${key}"`,
        ).toBe(true);
      }
    }
  });

  it('ensures project_files in Postgres defines filename and byte_size columns', () => {
    const pgProjectFiles = pgTables.get('project_files');
    expect(pgProjectFiles).toBeDefined();

    const columns = getTableColumns(pgProjectFiles!.table);
    expect(columns).toHaveProperty('filename');
    expect(columns).toHaveProperty('byteSize');

    const colNames = Object.values(columns).map((c: any) => c.name);
    expect(colNames).toContain('filename');
    expect(colNames).toContain('byte_size');
  });
});
