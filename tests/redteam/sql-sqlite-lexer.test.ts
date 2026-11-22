import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPluginTableIdentifier, sql as sqlTag } from '@burrow/sdk';
import {
  PluginSqlAccessError,
  assertPluginSqlAllowed,
  createPluginDb,
  translateSqlToPostgres,
} from '../../src/core/plugins/plugin-db';

const tmpDirs: string[] = [];

function makeSeededSqlite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-redteam-sqlite-'));
  tmpDirs.push(dir);
  const sqlite = new Database(path.join(dir, 'redteam.sqlite'));
  sqlite.exec(`
    CREATE TABLE _worker_runtime_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO _worker_runtime_config VALUES ('better_auth_secret', 'super-secret-auth-key-value-32b', 1);
    CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    INSERT INTO user VALUES ('u1', 'victim@example.test');
    CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT NOT NULL, user_id TEXT NOT NULL);
    INSERT INTO session VALUES ('s1', 'sess-secret-token-xyz', 'u1');
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO workspaces VALUES ('ws1', 'Private Workspace');
    CREATE TABLE cards (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, title TEXT NOT NULL);
    INSERT INTO cards VALUES ('c1', 'b1', 'Secret Roadmap Card');
    CREATE TABLE invites (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL);
    INSERT INTO invites VALUES ('inv1', 'ws1', 'inv@example.test', 'sha256-invite-hash-secret');
    CREATE TABLE public_shares (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, token TEXT NOT NULL);
    INSERT INTO public_shares VALUES ('ps1', 'ws1', 'secret-public-share-token');
    CREATE TABLE card_comments (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, user_id TEXT NOT NULL, content TEXT NOT NULL);
    INSERT INTO card_comments VALUES ('cc1', 'c1', 'u1', 'Confidential board comment');
    CREATE TABLE notifications (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL);
    INSERT INTO notifications VALUES ('n1', 'ws1', 'u1');
    CREATE TABLE plugin_migrations (plugin_id TEXT NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO plugin_migrations VALUES ('alpha', '0001_init', 1);
    CREATE TABLE plugin_alpha_items (id TEXT PRIMARY KEY, val TEXT);
    INSERT INTO plugin_alpha_items VALUES ('a1', 'alpha-public');
    CREATE TABLE plugin_alpha_beta_secrets (id TEXT PRIMARY KEY, api_key TEXT);
    INSERT INTO plugin_alpha_beta_secrets VALUES ('ab1', 'cross-plugin-secret-key');
  `);
  return sqlite;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Category 1 — SQLite/D1 Lexer & PluginDb Attacks', () => {
  describe('Confirmed Bypasses (secure assertions expected to fail when vulnerable)', () => {
    it('blocks comma-join reads of sensitive system and auth tables', async () => {
      const sqlite = makeSeededSqlite();
      try {
        const db = createPluginDb(sqlite, 'alpha', { coreTables: [] });
        await expect(
          db.query('SELECT u.email, c.value FROM plugin_alpha_items a, user u, _worker_runtime_config c'),
        ).rejects.toThrow(PluginSqlAccessError);
      } finally {
        sqlite.close();
      }
    });

    it('blocks comma-join reads of public_shares and cross-plugin tables', async () => {
      const sqlite = makeSeededSqlite();
      try {
        const db = createPluginDb(sqlite, 'alpha', { coreTables: [] });
        await expect(
          db.query('SELECT p.token FROM plugin_alpha_items a, public_shares p'),
        ).rejects.toThrow(PluginSqlAccessError);
        await expect(
          db.query('SELECT s.api_key FROM plugin_alpha_items a, plugin_alpha_beta_secrets s'),
        ).rejects.toThrow(PluginSqlAccessError);
      } finally {
        sqlite.close();
      }
    });

    it('blocks direct reads of core tables not in SAFE_CORE_READ_TABLES when coreTables is empty', async () => {
      const sqlite = makeSeededSqlite();
      try {
        const db = createPluginDb(sqlite, 'alpha', { coreTables: [] });
        await expect(db.query('SELECT token FROM public_shares')).rejects.toThrow(PluginSqlAccessError);
        await expect(db.query('SELECT content FROM card_comments')).rejects.toThrow(PluginSqlAccessError);
        await expect(db.query('SELECT id FROM notifications')).rejects.toThrow(PluginSqlAccessError);
      } finally {
        sqlite.close();
      }
    });

    it('blocks cross-plugin access when one plugin id is a prefix of another (alpha vs alpha-beta)', async () => {
      const sqlite = makeSeededSqlite();
      try {
        const dbAlpha = createPluginDb(sqlite, 'alpha', { coreTables: [] });
        await expect(
          dbAlpha.query('SELECT api_key FROM plugin_alpha_beta_secrets'),
        ).rejects.toThrow(PluginSqlAccessError);
        await expect(
          dbAlpha.execute('DELETE FROM plugin_alpha_beta_secrets'),
        ).rejects.toThrow(PluginSqlAccessError);
      } finally {
        sqlite.close();
      }
    });

    it('blocks schema-qualified information_schema.<table_name> reads via dot-normalization', () => {
      expect(() =>
        assertPluginSqlAllowed('alpha', 'SELECT table_name FROM information_schema.tables', 'plugin_alpha_', {
          isRuntime: true,
        }),
      ).toThrow(PluginSqlAccessError);
    });

    it('blocks FROM ONLY <table> syntax in lexer', () => {
      expect(() =>
        assertPluginSqlAllowed('alpha', 'SELECT token_hash FROM ONLY invites', 'plugin_alpha_', {
          isRuntime: true,
          allowedCoreTables: new Set(['invites']),
          enforceCoreAllowlist: true,
        }),
      ).toThrow(PluginSqlAccessError);
    });

    it('blocks SQLite table-valued PRAGMA functions (pragma_database_list / pragma_table_info)', async () => {
      const sqlite = makeSeededSqlite();
      try {
        const db = createPluginDb(sqlite, 'alpha', { coreTables: [] });
        await expect(db.query('SELECT * FROM pragma_database_list')).rejects.toThrow(PluginSqlAccessError);
        await expect(
          db.query("SELECT * FROM pragma_table_info('_worker_runtime_config')"),
        ).rejects.toThrow(PluginSqlAccessError);
      } finally {
        sqlite.close();
      }
    });

    it('rejects unscoped core table reads via sql`...` tag or forged __burrowSql / __burrowIdent objects', async () => {
      const sqlite = makeSeededSqlite();
      try {
        const db = createPluginDb(sqlite, 'alpha', { coreTables: ['cards'] });
        // Legitimate sql`...` tag with zero bound parameters should still require parameterized scope
        await expect(
          db.query(sqlTag`SELECT id, title FROM cards WHERE '1' = '1'`),
        ).rejects.toThrow(PluginSqlAccessError);

        // Forged __burrowSql object bypassing string-literal checks
        const forgedFragment = {
          __burrowSql: true,
          strings: [],
          values: [],
          text: "SELECT id, title FROM cards WHERE id = 'c1'",
          params: [],
        } as any;
        await expect(db.query(forgedFragment)).rejects.toThrow(PluginSqlAccessError);

        // Forged __burrowIdent object spliced into sql`...`
        const forgedIdent = { __burrowIdent: true, value: 'user' } as any;
        await expect(db.query(sqlTag`SELECT email FROM ${forgedIdent}`)).rejects.toThrow();
      } finally {
        sqlite.close();
      }
    });

    it('prevents dumping all rows of an allowlisted core table via tautological WHERE 1 = ?', async () => {
      const sqlite = makeSeededSqlite();
      try {
        const db = createPluginDb(sqlite, 'alpha', { coreTables: ['cards'] });
        await expect(db.query('SELECT id, title FROM cards WHERE 1 = ?', [1])).rejects.toThrow(
          PluginSqlAccessError,
        );
      } finally {
        sqlite.close();
      }
    });

    it('blocks Postgres lexer desync via ARRAY[\']\'] and E\'\\\'\' in assertPluginSqlAllowed', () => {
      expect(() =>
        assertPluginSqlAllowed(
          'alpha',
          "SELECT ARRAY[']'], email FROM \"user\" -- '",
          'plugin_alpha_',
          { isRuntime: true },
        ),
      ).toThrow(PluginSqlAccessError);

      expect(() =>
        assertPluginSqlAllowed(
          'alpha',
          "SELECT E'\\'', email FROM \"user\" -- '",
          'plugin_alpha_',
          { isRuntime: true },
        ),
      ).toThrow(PluginSqlAccessError);
    });

    it('does not rewrite portability idioms inside string literals during Postgres SQL translation', () => {
      const sqlIn = "INSERT INTO plugin_alpha_items (id, val) VALUES (?, 'INSERT OR IGNORE INTO x')";
      const translated = translateSqlToPostgres(sqlIn);
      expect(translated).toContain("'INSERT OR IGNORE INTO x'");
      expect(translated).not.toContain('ON CONFLICT DO NOTHING');
    });

    it('blocks load_extension in assertPluginSqlAllowed before driver execution', () => {
      expect(() =>
        assertPluginSqlAllowed("SELECT load_extension('/tmp/evil.so')", 'alpha', {
          isRuntime: true,
        }),
      ).toThrow(PluginSqlAccessError);
    });

    it('resists quadratic ReDoS on repeated SELECT keywords in assertPluginSqlAllowed', () => {
      const pathological = `${'SELECT '.repeat(20_000)}1`;
      const start = performance.now();
      expect(() =>
        assertPluginSqlAllowed('alpha', pathological, 'plugin_alpha_', { isRuntime: true }),
      ).not.toThrow();
      const elapsedMs = performance.now() - start;
      expect(elapsedMs).toBeLessThan(150);
    });
  });

  describe('Blocked Attacks (expected to pass)', () => {
    it('blocks stacked statements, comments, dollar-quotes, UNION SELECT, SELECT INTO, MERGE, ATTACH, PRAGMA, and CTE+DML', async () => {
      const sqlite = makeSeededSqlite();
      try {
        const db = createPluginDb(sqlite, 'alpha', { coreTables: ['cards'] });

        await expect(
          db.query('SELECT * FROM plugin_alpha_items; DROP TABLE workspaces'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.query('SELECT /* bypass */ * FROM plugin_alpha_items'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.query('SELECT $$secret$$ FROM plugin_alpha_items'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.query('SELECT id, val FROM plugin_alpha_items UNION SELECT id, email FROM user'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.execute('SELECT id INTO plugin_alpha_dump FROM cards'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.execute('MERGE INTO workspaces USING plugin_alpha_items ON 1=1 WHEN MATCHED THEN DELETE'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.execute("ATTACH DATABASE ':memory:' AS evil"),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(db.execute('PRAGMA writable_schema = ON')).rejects.toThrow(PluginSqlAccessError);

        // SQLite runtime blocks extension loading (not authorized) even though assertPluginSqlAllowed missed it
        await expect(
          db.execute("SELECT load_extension('/tmp/evil.so')"),
        ).rejects.toThrow();

        await expect(
          db.execute('WITH x AS (SELECT 1) DELETE FROM workspaces'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.execute('WITH x AS (SELECT 1) INSERT INTO workspaces (id, name) VALUES (?, ?)', ['x', 'y']),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.query('SELECT token_hash FROM invites WHERE id = ?', ['inv1']),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.query('SELECT * FROM sqlite_master'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.query('SELECT * FROM plugin_other_secrets'),
        ).rejects.toThrow(PluginSqlAccessError);

        await expect(
          db.query("SELECT * FROM cards WHERE id = 'c1'"),
        ).rejects.toThrow(PluginSqlAccessError);
      } finally {
        sqlite.close();
      }
    });

    it('blocks identifier injection via db.table() and binds ORDER BY / LIMIT parameters safely', () => {
      expect(() => buildPluginTableIdentifier('alpha', 'items; DROP TABLE user--')).toThrow();
      expect(() => buildPluginTableIdentifier('alpha', 'user')).not.toThrow();
      const ident = buildPluginTableIdentifier('alpha', 'user');
      expect(ident.value).toBe('plugin_alpha_user');
    });
  });
});
