import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { BurrowServerPlugin } from '@burrow/sdk';
import { applyPostgresMigrations } from '../../src/core/adapters/db/postgres';
import { createPluginDb } from '../../src/core/plugins/plugin-db';
import { runPluginMigrations } from '../../src/core/plugins/migrations';
import {
  provisionPluginPostgresIsolation,
  withPluginPostgresRole,
} from '../../src/core/plugins/postgres-isolation';

describe('Category 1 & 2 — PostgreSQL 17 Role Containment & DB-Level Isolation', () => {
  let sql: ReturnType<typeof postgres>;
  let dbUrl: string;

  beforeAll(async () => {
    dbUrl = inject('postgresTestUrl');
    sql = postgres(dbUrl, { max: 5, onnotice: () => {} });
    await applyPostgresMigrations(sql);
    await sql`
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('u_victim', 'Victim', 'victim@redteam.test', true, now(), now())
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO workspaces (id, name, created_by, created_at)
      VALUES ('ws_victim', 'Victim Workspace', 'u_victim', 1000)
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, expires_at, created_at)
      VALUES ('inv_1', 'ws_victim', 'x@redteam.test', 'editor', 'secret-invite-hash-pg', 'u_victim', 9999999999999, 1000)
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  describe('Confirmed Database Isolation Escapes & Abuses', () => {
    it('prevents RESET ROLE escape from plugin_<id>_role back to session_user inside withPluginPostgresRole (DB-level / enforceLexer: false)', async () => {
      const db = createPluginDb(sql, 'evilpg', { coreTables: [], enforceLexer: false });
      await expect(
        db.query('RESET ROLE; SELECT email FROM public."user"'),
      ).rejects.toThrow();
    });

    it('prevents RESET ROLE escape via ARRAY[\']\'] lexer desync even with enforceLexer: true', async () => {
      const db = createPluginDb(sql, 'evillexer', { coreTables: [] });
      await expect(
        db.query("SELECT ARRAY[']']; RESET ROLE; SELECT email FROM public.\"user\" -- '"),
      ).rejects.toThrow();
    });

    it('prevents RESET ROLE inside migration DDL even when skipLexerForTest is active', async () => {
      const hostileMigrationPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'evilmig',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
        },
        migrations: [
          {
            name: '0001_escape.sql',
            dialect: 'postgres',
            sql: 'RESET ROLE; CREATE TABLE IF NOT EXISTS public.plugin_escape_proof (x text);',
          },
        ],
        setup() {},
      };

      await expect(
        runPluginMigrations(sql, [hostileMigrationPlugin], { skipLexerForTest: true }),
      ).rejects.toThrow();

      const leaked = await sql`SELECT to_regclass('public.plugin_escape_proof') AS reg`;
      expect(leaked[0]?.reg).toBeNull();
    });

    it('prevents plugin role from re-granting CREATE on its own schema after migration completes', async () => {
      const initPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'regrant',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
        },
        migrations: [
          {
            name: '0001_init.sql',
            dialect: 'postgres',
            sql: 'CREATE TABLE IF NOT EXISTS plugin_regrant_t (id TEXT PRIMARY KEY)',
          },
        ],
        setup() {},
      };
      await runPluginMigrations(sql, [initPlugin]);

      const dbNoLexer = createPluginDb(sql, 'regrant', { coreTables: [], enforceLexer: false });
      // Because plugin_regrant_role owns schema plugin_regrant, GRANT CREATE ON SCHEMA plugin_regrant TO plugin_regrant_role succeeds!
      await expect(
        dbNoLexer.execute(
          'GRANT CREATE ON SCHEMA plugin_regrant TO plugin_regrant_role; CREATE TABLE plugin_regrant.sneaky (id text);',
        ),
      ).rejects.toThrow();
    });

    it('prevents plugins from creating FKs without ON DELETE CASCADE that permanently block core user/workspace deletion', async () => {
      const fkLockPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'fklock',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
        },
        migrations: [
          {
            name: '0001_lock.sql',
            dialect: 'postgres',
            sql: `CREATE TABLE IF NOT EXISTS plugin_fklock_refs (
              id TEXT PRIMARY KEY,
              ws_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT
            )`,
          },
        ],
        setup() {},
      };
      await runPluginMigrations(sql, [fkLockPlugin]);

      const tempWsId = `ws_lock_${randomUUID().slice(0, 8)}`;
      await sql`INSERT INTO workspaces (id, name, created_by, created_at) VALUES (${tempWsId}, 'Disposable', 'u_victim', 2000)`;

      const db = createPluginDb(sql, 'fklock', { coreTables: [] });
      await db.execute('INSERT INTO plugin_fklock_refs (id, ws_id) VALUES (?, ?)', ['r1', tempWsId]);

      // Core workspace deletion must NOT be blockable by a plugin's ON DELETE RESTRICT foreign key
      await expect(sql`DELETE FROM workspaces WHERE id = ${tempWsId}`).resolves.toBeDefined();
    });

    it('prevents plugins with coreTables: [] from using REFERENCES(id) to probe existence of core user/workspace IDs', async () => {
      const oraclePlugin: BurrowServerPlugin = {
        manifest: {
          id: 'fkoracle',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
          coreTables: [],
        },
        migrations: [
          {
            name: '0001_oracle.sql',
            dialect: 'postgres',
            sql: `CREATE TABLE IF NOT EXISTS plugin_fkoracle_probe (
              id TEXT PRIMARY KEY,
              uid TEXT REFERENCES "user"(id) ON DELETE CASCADE
            )`,
          },
        ],
        setup() {},
      };
      await runPluginMigrations(sql, [oraclePlugin]);
      const db = createPluginDb(sql, 'fkoracle', { coreTables: [] });

      // Attacker can distinguish existing 'u_victim' (succeeds) from non-existent 'u_missing' (23503)
      const insertExisting = await db
        .execute('INSERT INTO plugin_fkoracle_probe (id, uid) VALUES (?, ?)', ['p1', 'u_victim'])
        .then(() => 'existed')
        .catch(() => 'denied');
      const insertMissing = await db
        .execute('INSERT INTO plugin_fkoracle_probe (id, uid) VALUES (?, ?)', ['p2', 'u_does_not_exist'])
        .then(() => 'existed')
        .catch(() => 'denied');
      expect(insertExisting).toBe(insertMissing);
    });

    it('prevents plugin queries from holding core advisory locks (burrow:migrations / burrow:plugin_migrations)', async () => {
      const db = createPluginDb(sql, 'advlock', { coreTables: [], enforceLexer: false });
      await provisionPluginPostgresIsolation(sql, 'advlock', { coreTables: [] });
      await expect(
        db.query("SELECT pg_advisory_lock(hashtext('burrow:migrations'))"),
      ).rejects.toThrow();
      await sql`SELECT pg_advisory_unlock_all()`;
    });

    it('sets PostgreSQL statement_timeout inside withPluginPostgresRole so slow queries do not linger in the DB pool', async () => {
      await provisionPluginPostgresIsolation(sql, 'timeoutpg', { coreTables: [] });
      const timeoutSetting = await withPluginPostgresRole(sql, 'timeoutpg', async (roleTx) => {
        const rows = await roleTx.unsafe("SELECT current_setting('statement_timeout') AS st");
        return rows[0]?.st;
      });
      expect(timeoutSetting).not.toBe('0');
    });

    it('blocks information_schema.tables and pg_roles reads both in lexer and DB role', async () => {
      const db = createPluginDb(sql, 'catpg', { coreTables: [] });
      await expect(
        db.query('SELECT table_name FROM information_schema.tables WHERE table_schema = ?', ['public']),
      ).rejects.toThrow();
      await expect(
        db.query("SELECT ARRAY[']'], rolname FROM pg_roles -- '"),
      ).rejects.toThrow();
    });

    it('blocks CREATE FUNCTION and CREATE TRIGGER inside plugin DDL event triggers (exposes SECURITY DEFINER current_user bug)', async () => {
      await provisionPluginPostgresIsolation(sql, 'pgddlfn', { coreTables: [], allowSchemaCreate: true });

      const triggers = await sql<{ evtname: string; evtenabled: string }[]>`
        SELECT evtname, evtenabled FROM pg_event_trigger WHERE evtname LIKE 'burrow_%'
      `;
      expect(triggers.length).toBeGreaterThanOrEqual(3);

      // Because public.burrow_enforce_plugin_ddl() is SECURITY DEFINER, current_user inside the trigger
      // evaluates to the definer (superuser), causing IF current_user NOT LIKE 'plugin\_%\_role' to RETURN immediately!
      await expect(
        withPluginPostgresRole(
          sql,
          'pgddlfn',
          async (roleTx) => {
            await roleTx.unsafe(
              'CREATE FUNCTION plugin_pgddlfn.evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
            );
            await roleTx.unsafe('CREATE TABLE plugin_pgddlfn.t (id text);');
            await roleTx.unsafe(
              'CREATE FUNCTION plugin_pgddlfn.trigfn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
            );
            await roleTx.unsafe(
              'CREATE TRIGGER evil_trig BEFORE INSERT ON plugin_pgddlfn.t FOR EACH ROW EXECUTE FUNCTION plugin_pgddlfn.trigfn()',
            );
          },
          { allowMigrationDdl: true },
        ),
      ).rejects.toThrow();
    });
  });

  describe('Blocked Attacks on Postgres 17 (expected to pass)', () => {
    it('blocks direct SELECT on public."user", session, and unallowlisted core tables at the DB role level', async () => {
      const db = createPluginDb(sql, 'pgblock', { coreTables: [], enforceLexer: false });
      await expect(db.query('SELECT * FROM public."user"')).rejects.toThrow();
      await expect(db.query('SELECT * FROM public.session')).rejects.toThrow();
      await expect(db.query('SELECT * FROM public.workspaces')).rejects.toThrow();
      await expect(db.query('SELECT * FROM public.plugin_migrations')).rejects.toThrow();
    });

    it('blocks reading invites.token_hash even when invites IS in coreTables (DB column grant protection)', async () => {
      const db = createPluginDb(sql, 'pginv', { coreTables: ['invites'], enforceLexer: false });
      const safeCols = await db.query<{ id: string }>(
        'SELECT id, email FROM public.invites WHERE workspace_id = $1',
        ['ws_victim'],
      );
      expect(safeCols).toHaveLength(1);
      await expect(
        db.query('SELECT token_hash FROM public.invites WHERE workspace_id = $1', ['ws_victim']),
      ).rejects.toThrow();
    });

    it('blocks cross-plugin schema access at the PostgreSQL role level', async () => {
      const victimPlugin: BurrowServerPlugin = {
        manifest: {
          id: 'pgvictim',
          version: '0.1.0',
          sdkVersion: '^0.4.0',
          permissions: ['db:own'],
          dialects: ['postgres'],
        },
        migrations: [
          {
            name: '0001_init.sql',
            dialect: 'postgres',
            sql: 'CREATE TABLE IF NOT EXISTS plugin_pgvictim_secrets (id TEXT PRIMARY KEY, secret TEXT)',
          },
        ],
        setup() {},
      };
      await runPluginMigrations(sql, [victimPlugin]);
      const victimDb = createPluginDb(sql, 'pgvictim');
      await victimDb.execute('INSERT INTO plugin_pgvictim_secrets (id, secret) VALUES (?, ?)', ['1', 'top-secret']);

      const attackerDb = createPluginDb(sql, 'pgattacker', { coreTables: [], enforceLexer: false });
      await expect(
        attackerDb.query('SELECT * FROM plugin_pgvictim.plugin_pgvictim_secrets'),
      ).rejects.toThrow();
    });

    it('blocks CREATE EXTENSION, CREATE ROLE, COPY, and pg_notify via PostgreSQL role privileges and revokes', async () => {
      await provisionPluginPostgresIsolation(sql, 'pgddl', { coreTables: [], allowSchemaCreate: true });
      const db = createPluginDb(sql, 'pgddl', { coreTables: [], enforceLexer: false });

      const probes: Array<[string, () => Promise<unknown>]> = [
        [
          'CREATE EXTENSION',
          () =>
            withPluginPostgresRole(
              sql,
              'pgddl',
              (roleTx) => roleTx.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto'),
              { allowMigrationDdl: true },
            ),
        ],
        [
          'CREATE ROLE',
          () =>
            withPluginPostgresRole(
              sql,
              'pgddl',
              (roleTx) => roleTx.unsafe('CREATE ROLE rogue_admin'),
              { allowMigrationDdl: true },
            ),
        ],
        ['pg_notify', () => db.query("SELECT pg_notify('chan', 'msg')")],
        ['COPY', () => db.execute("COPY public.\"user\" TO '/tmp/leak.csv'")],
      ];

      const outcomes: Array<{ op: string; blocked: boolean }> = [];
      for (const [op, run] of probes) {
        try {
          await run();
          outcomes.push({ op, blocked: false });
        } catch {
          outcomes.push({ op, blocked: true });
        }
      }

      expect(outcomes).toEqual(probes.map(([op]) => ({ op, blocked: true })));
    });

    it('blocks DDL inside public schema from a plugin role', async () => {
      await provisionPluginPostgresIsolation(sql, 'pgpub', { coreTables: [], allowSchemaCreate: true });
      await expect(
        withPluginPostgresRole(
          sql,
          'pgpub',
          (roleTx) => roleTx.unsafe('CREATE TABLE public.plugin_rogue (id text)'),
          { allowMigrationDdl: true },
        ),
      ).rejects.toThrow();
    });
  });
});
