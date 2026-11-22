import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import type { BurrowServerPlugin } from '@burrow/sdk';
import { applyPostgresMigrations } from '../../src/core/adapters/db/postgres';
import {
  PluginSqlAccessError,
  createPluginDb,
  runPluginMigrations,
  translateSqlToPostgres,
} from '../../src/core';
import { openNodeDb } from '../../src/server/db';
import path from 'node:path';

interface DialectPluginHandle {
  client: unknown;
  queryRaw(sqlText: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

async function openPluginDialectHandle(kind: 'sqlite' | 'postgres', pgUrl?: string): Promise<{
  handle: DialectPluginHandle;
  admin?: ReturnType<typeof postgres>;
  database?: string;
}> {
  if (kind === 'sqlite') {
    const { sqlite } = openNodeDb(':memory:', path.resolve('migrations'));
    return {
      handle: {
        client: sqlite,
        async queryRaw(sqlText) {
          return sqlite.prepare(sqlText).all() as Array<Record<string, unknown>>;
        },
        async close() {
          sqlite.close();
        },
      },
    };
  }

  const admin = postgres(pgUrl!, { max: 2, onnotice: () => {} });
  const database = `plugin_pg_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const testUrl = new URL(pgUrl!);
  testUrl.pathname = `/${database}`;
  const client = postgres(testUrl.toString(), { max: 4, onnotice: () => {} });
  await applyPostgresMigrations(client);

  return {
    admin,
    database,
    handle: {
      client,
      async queryRaw(sqlText) {
        return Array.from(await client.unsafe(sqlText));
      },
      async close() {
        await client.end();
      },
    },
  };
}

describe.each(['sqlite', 'postgres'] as const)('%s plugin runtime contract', (kind) => {
  let handle: DialectPluginHandle;
  let admin: ReturnType<typeof postgres> | undefined;
  let database: string | undefined;

  beforeEach(async () => {
    const pgUrl = kind === 'postgres' ? inject('postgresTestUrl') : undefined;
    const opened = await openPluginDialectHandle(kind, pgUrl);
    handle = opened.handle;
    admin = opened.admin;
    database = opened.database;
  });

  afterEach(async () => {
    await handle?.close();
    if (admin && database) {
      await admin.unsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    }
    await admin?.end();
  });

  it('applies idempotent migrations, enforces dialect support, and translates queries via PluginDb', async () => {
    const samplePlugin: BurrowServerPlugin = {
      manifest: {
        id: 'notes-sync',
        version: '0.1.0',
        sdkVersion: '^0.4.0',
        permissions: ['db:own'],
        dialects: ['sqlite', 'postgres'],
      },
      migrations: [
        {
          name: '0001_init.sql',
          sql: `CREATE TABLE IF NOT EXISTS plugin_notes_sync_items (
  id TEXT PRIMARY KEY,
  counter INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);`,
        },
      ],
      setup() {},
    };

    // Concurrent migration calls succeed idempotently (advisory-locked on Postgres)
    const [firstRun, secondRun] = await Promise.all([
      runPluginMigrations(handle.client, [samplePlugin]),
      runPluginMigrations(handle.client, [samplePlugin]),
    ]);
    const combinedApplied = [...firstRun, ...secondRun];
    expect(combinedApplied).toEqual(['notes-sync:0001_init.sql']);

    const ledgerRows = await handle.queryRaw('SELECT plugin_id, name FROM plugin_migrations');
    expect(ledgerRows).toHaveLength(1);

    if (kind === 'postgres') {
      const schemaRows = await handle.queryRaw(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'plugin_notes_sync'",
      );
      expect(schemaRows).toHaveLength(1);
    }

    const db = createPluginDb(handle.client, 'notes-sync');
    const tbl = db.table('items');

    // INSERT OR IGNORE translates cleanly to ON CONFLICT DO NOTHING on Postgres
    await db.execute(
      `INSERT OR IGNORE INTO plugin_notes_sync_items (id, counter, updated_at) VALUES (?, ?, ?)`,
      ['item_1', 10, 1700000000000],
    );
    await db.execute(
      `INSERT OR IGNORE INTO plugin_notes_sync_items (id, counter, updated_at) VALUES (?, ?, ?)`,
      ['item_1', 99, 1700000000001],
    );
    // MAX(0, ...) translates to GREATEST(0, ...) on Postgres
    await db.execute(
      `UPDATE plugin_notes_sync_items SET counter = MAX(0, counter - ?) WHERE id = ?`,
      [25, 'item_1'],
    );

    const row = await db.first<{ id: string; counter: string | number }>(
      db.sql`SELECT id, counter FROM ${tbl} WHERE id = ${'item_1'}`,
    );
    expect(row?.id).toBe('item_1');
    expect(Number(row?.counter)).toBe(0);

    // Dialect refusal: SQLite-only plugin refuses to migrate against active Postgres, and vice versa
    const wrongDialectPlugin: BurrowServerPlugin = {
      manifest: {
        id: 'other-dialect',
        version: '0.1.0',
        sdkVersion: '^0.4.0',
        permissions: ['db:own'],
        dialects: [kind === 'postgres' ? 'sqlite' : 'postgres'],
      },
      migrations: [
        {
          name: '0001_init.sql',
          sql: 'CREATE TABLE IF NOT EXISTS plugin_other_dialect_t (id TEXT PRIMARY KEY);',
        },
      ],
      setup() {},
    };
    await expect(runPluginMigrations(handle.client, [wrongDialectPlugin])).rejects.toThrow(
      /does not support active database dialect/,
    );

    // Core table tampering remains rejected by PluginDb on both SQLite and Postgres
    await expect(db.query('SELECT id FROM user WHERE id = ?', ['u1'])).rejects.toThrow(PluginSqlAccessError);
    expect(translateSqlToPostgres('SELECT * FROM plugin_notes_sync_items WHERE id = ?')).toContain('$1');
  });
});
