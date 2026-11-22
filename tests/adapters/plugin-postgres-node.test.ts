import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import type { BurrowServerPlugin } from '@burrow/sdk';
import { applyPostgresMigrations } from '../../src/core/adapters/db/postgres';
import {
  PluginSqlAccessError,
  createPluginDb,
  pluginPostgresRoleName,
  pluginPostgresSchemaName,
  provisionPluginPostgresIsolation,
  runPluginMigrations,
  translateSqlToPostgres,
  withPluginPostgresRole,
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
      /does not support active dialect/,
    );

    // Core table tampering remains rejected by PluginDb on both SQLite and Postgres
    await expect(db.query('SELECT id FROM user WHERE id = ?', ['u1'])).rejects.toThrow(PluginSqlAccessError);
    expect(translateSqlToPostgres('SELECT * FROM plugin_notes_sync_items WHERE id = ?')).toContain('$1');
  });

  if (kind === 'postgres') {
    it('enforces database-level PostgreSQL role, schema, search_path, and privilege isolation when the JS lexer is bypassed', async () => {
      const pgClient = handle.client as ReturnType<typeof postgres>;
      const now = Date.now();

      // Seed core tables + sensitive auth/invite rows and a sibling plugin schema/table
      await pgClient.unsafe(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ($1, $2, $3, true, NOW(), NOW())`,
        ['u_db_1', 'Owner', 'dbowner@example.com'],
      );
      await pgClient.unsafe(
        `INSERT INTO workspaces (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)`,
        ['ws_db_1', 'DB Isolation Workspace', 'u_db_1', now],
      );
      await pgClient.unsafe(
        `INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, expires_at, created_at)
         VALUES ($1, $2, $3, 'editor', $4, $5, $6, $7)`,
        ['inv_db_1', 'ws_db_1', 'invitee@example.com', 'secret_token_hash_xyz', 'u_db_1', now + 60_000, now],
      );

      const siblingPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'sibling',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
        },
        migrations: [
          {
            name: '0001_init.sql',
            sql: 'CREATE TABLE IF NOT EXISTS plugin_sibling_secrets (id TEXT PRIMARY KEY, secret TEXT NOT NULL);',
          },
        ],
        setup() {},
      };

      const isolatedPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'isolated',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
          coreTables: ['workspaces'],
        },
        migrations: [
          {
            name: '0001_init.sql',
            sql: `CREATE TABLE IF NOT EXISTS plugin_isolated_notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  body TEXT NOT NULL
);`,
          },
        ],
        setup() {},
      };

      const invitesReaderPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'inv-reader',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
          coreTables: ['invites'],
        },
        setup() {},
      };

      await runPluginMigrations(pgClient, [siblingPlugin, isolatedPlugin, invitesReaderPlugin]);

      const siblingDb = createPluginDb(pgClient, 'sibling');
      await siblingDb.execute('INSERT INTO plugin_sibling_secrets (id, secret) VALUES (?, ?)', [
        's_1',
        'top_secret_sibling',
      ]);

      // Verify schema & role metadata created in PostgreSQL
      const isoSchema = pluginPostgresSchemaName('isolated');
      const isoRole = pluginPostgresRoleName('isolated');
      const roleRows = await pgClient.unsafe(
        'SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1',
        [isoRole],
      );
      expect(roleRows[0]).toEqual({ rolsuper: false, rolcanlogin: false });

      // Bypass JS lexer completely via raw driver inside `withPluginPostgresRole` AND `enforceLexer: false`
      const bypassedDb = createPluginDb(pgClient, 'isolated', {
        enforceLexer: false,
        coreTables: ['workspaces'],
      });
      await bypassedDb.execute(
        'INSERT INTO plugin_isolated_notes (id, workspace_id, body) VALUES (?, ?, ?)',
        ['n_1', 'ws_db_1', 'isolated note'],
      );
      // Allowlisted core table SELECT succeeds
      const allowedWs = await bypassedDb.query<{ id: string }>(
        'SELECT id FROM public.workspaces WHERE id = ?',
        ['ws_db_1'],
      );
      expect(allowedWs).toEqual([{ id: 'ws_db_1' }]);

      // 1. Reading core unapproved tables fails in Postgres itself (42501 permission denied)
      await expect(bypassedDb.query('SELECT email FROM public."user"')).rejects.toThrow();
      await expect(bypassedDb.query('SELECT id FROM public.session')).rejects.toThrow();
      await expect(bypassedDb.query('SELECT token_hash FROM public.invites')).rejects.toThrow();
      await expect(bypassedDb.query('SELECT user_id FROM public.members')).rejects.toThrow();

      // Column-level ACL on invites: plugin with `coreTables: ['invites']` can read email but NOT token_hash
      const invBypassedDb = createPluginDb(pgClient, 'inv-reader', {
        enforceLexer: false,
        coreTables: ['invites'],
      });
      const safeInviteCols = await invBypassedDb.query<{ id: string; email: string }>(
        'SELECT id, email FROM public.invites WHERE workspace_id = ?',
        ['ws_db_1'],
      );
      expect(safeInviteCols).toEqual([{ id: 'inv_db_1', email: 'invitee@example.com' }]);
      await expect(invBypassedDb.query('SELECT token_hash FROM public.invites')).rejects.toThrow();

      // 2-8. Raw driver calls directly inside the plugin role fail at DB level across all breakout vectors
      const rawAttacks: Array<[string, string]> = [
        ['read sibling plugin schema', 'SELECT secret FROM plugin_sibling.plugin_sibling_secrets'],
        ['drop sibling plugin table', 'DROP TABLE plugin_sibling.plugin_sibling_secrets'],
        ['read pg_catalog.pg_authid', 'SELECT rolname, rolpassword FROM pg_catalog.pg_authid'],
        ['RESET ROLE', 'RESET ROLE'],
        ['SET ROLE postgres', 'SET ROLE postgres'],
        ['SET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION burrow_test'],
        [
          'CREATE FUNCTION in plugin schema',
          `CREATE FUNCTION ${isoSchema}.evil_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
        ],
        [
          'CREATE TRIGGER on core table',
          'CREATE TRIGGER evil_trig BEFORE DELETE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.burrow_enforce_plugin_ddl()',
        ],
        ['COPY ... TO PROGRAM', "COPY (SELECT 1) TO PROGRAM 'id'"],
        ['LISTEN command', 'LISTEN secret_channel'],
        ['NOTIFY command', "NOTIFY secret_channel, 'exfil'"],
        ['pg_catalog.pg_notify()', "SELECT pg_catalog.pg_notify('secret_channel', 'exfil')"],
      ];

      for (const [label, sqlText] of rawAttacks) {
        await expect(
          withPluginPostgresRole(
            pgClient,
            'isolated',
            (roleTx) => roleTx.unsafe(sqlText),
            { coreTables: ['workspaces'] },
          ),
          `Expected PostgreSQL DB engine to reject "${label}"`,
        ).rejects.toThrow();
      }

      // 9. Malicious migration running as plugin_<id>_role (with JS lexer explicitly skipped) is blocked by Postgres itself
      const evilMigratorPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'evil-mig',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
        },
        migrations: [
          {
            name: '0001_drop_core.sql',
            sql: 'DROP TABLE public.workspaces;',
          },
        ],
        setup() {},
      };
      await provisionPluginPostgresIsolation(pgClient, 'evil-mig', { allowSchemaCreate: true });
      await expect(
        runPluginMigrations(pgClient, [evilMigratorPlugin], { skipLexerForTest: true }),
      ).rejects.toThrow();

      // Core tables & sibling tables remain completely intact
      const wsRemaining = await pgClient.unsafe('SELECT id FROM public.workspaces');
      expect(wsRemaining).toEqual([{ id: 'ws_db_1' }]);
    });
  }
});
