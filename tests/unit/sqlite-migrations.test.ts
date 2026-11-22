import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPostgresMigrations } from '../../src/core/adapters/db/postgres/index';
import { openSqliteDatabase } from '../../src/server/sqlite';
import { splitSqlStatements } from '../../src/server/sql-statements';
import { D1_MIGRATIONS } from '../../src/worker/d1-migrations';
import {
  deriveWorkerAuthUrl,
  ensureWorkerRuntimeEnv,
} from '../../src/worker/bootstrap';

const exec = promisify(execFile);
const docker = async (...args: string[]) =>
  (await exec('docker', args, { windowsHide: true, timeout: 120_000 })).stdout.trim();

const directories: string[] = [];
const root = path.resolve('.');
function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-migrations-'));
  directories.push(directory);
  const migrations = path.join(directory, 'migrations');
  fs.mkdirSync(migrations);
  return { directory, migrations, filename: path.join(directory, 'db.sqlite') };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('canonical SQLite migration execution', () => {
  it('keeps PostgreSQL invariant SQL portable across the current relational schema', () => {
    const { migrations, filename } = temporaryDatabase();
    for (const file of fs
      .readdirSync(path.join(root, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      fs.copyFileSync(path.join(root, 'migrations', file), path.join(migrations, file));
    }
    const sqlite = openSqliteDatabase(filename, migrations);
    try {
      sqlite.exec('ALTER TABLE notepads ADD COLUMN search_vector TEXT');
      const sql = fs.readFileSync(path.join(root, 'scripts/check-invariants.postgres.sql'), 'utf8');
      const checks = splitSqlStatements(sql);
      expect(checks).toHaveLength(13);
      expect(checks.flatMap((statement) => sqlite.prepare(statement).all())).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('orders migrations, enables constraints, and does not reapply them on restart', () => {
    const { migrations, filename } = temporaryDatabase();
    fs.writeFileSync(
      path.join(migrations, '0001_insert.sql'),
      "INSERT INTO notes VALUES ('first');",
    );
    fs.writeFileSync(path.join(migrations, '0000_create.sql'), 'CREATE TABLE notes (title TEXT);');
    const first = openSqliteDatabase(filename, migrations);
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1);
    first.close();
    const second = openSqliteDatabase(filename, migrations);
    try {
      expect(second.prepare('SELECT title FROM notes').all()).toEqual([{ title: 'first' }]);
      expect(second.prepare('SELECT count(*) AS count FROM _migrations').get()).toEqual({
        count: 2,
      });
    } finally {
      second.close();
    }
  });

  it('strictly rejects foreign key violations on Node SQLite database', () => {
    const { migrations, filename } = temporaryDatabase();
    fs.writeFileSync(
      path.join(migrations, '0000_create.sql'),
      `CREATE TABLE parents (id TEXT PRIMARY KEY);
       CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE);`,
    );
    const db = openSqliteDatabase(filename, migrations);
    try {
      expect(() => {
        db.prepare("INSERT INTO children (id, parent_id) VALUES ('c1', 'missing-parent')").run();
      }).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });

  it('rolls back failed schema changes and their ledger while keeping prior migrations', () => {
    const { migrations, filename } = temporaryDatabase();
    fs.writeFileSync(path.join(migrations, '0000_create.sql'), 'CREATE TABLE notes (title TEXT);');
    openSqliteDatabase(filename, migrations).close();
    fs.writeFileSync(
      path.join(migrations, '0001_fail.sql'),
      'CREATE TABLE partial (id INTEGER); INSERT INTO missing VALUES (1);',
    );
    expect(() => openSqliteDatabase(filename, migrations)).toThrow('no such table');
    const sqlite = new Database(filename, { readonly: true });
    try {
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get(),
      ).toBeUndefined();
      expect(sqlite.prepare('SELECT filename FROM _migrations').all()).toEqual([
        { filename: '0000_create.sql' },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

describe('local database CLI integration', () => {
  function command(script: string, filename: string) {
    return spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '', SQLITE_PATH: filename },
    });
  }

  it('seeds and checks the selected Node file, then reports an invariant violation', () => {
    const { filename } = temporaryDatabase();
    const seeded = command('seed.mjs', filename);
    expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0);
    expect(seeded.stdout).toContain('all invariants hold');
    const sqlite = new Database(filename);
    sqlite.exec("DELETE FROM notepads_fts WHERE notepad_id = 'np_roadmap'");
    sqlite.close();
    const checked = command('check-data.mjs', filename);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toContain('missing fts row');
  });

  it('does not create or migrate a missing database while checking data', () => {
    const { filename } = temporaryDatabase();
    expect(command('check-data.mjs', filename).status).not.toBe(0);
    expect(fs.existsSync(filename)).toBe(false);
  });
});

describe('database upgrade migration preservation (SQLite & PostgreSQL)', () => {
  it('preserves existing workspace data, roles, content, and invariants across a forward SQLite upgrade', () => {
    const { migrations, filename } = temporaryDatabase();
    for (const file of fs
      .readdirSync(path.join(root, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      fs.copyFileSync(path.join(root, 'migrations', file), path.join(migrations, file));
    }

    const now = Date.now();
    const sqliteInitial = openSqliteDatabase(filename, migrations);
    try {
      sqliteInitial.exec(`
        INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES
          ('usr_owner', 'Owner User', 'owner@upgrade.test', 1, ${now}, ${now}),
          ('usr_editor', 'Editor User', 'editor@upgrade.test', 1, ${now}, ${now}),
          ('usr_viewer', 'Viewer User', 'viewer@upgrade.test', 1, ${now}, ${now});

        INSERT INTO workspaces (id, name, created_by, created_at)
        VALUES ('ws_upgrade', 'Upgrade Test Workspace', 'usr_owner', ${now});

        INSERT OR REPLACE INTO bootstrap_state (id, status, claim_email, user_id, workspace_id)
        VALUES (1, 'complete', 'owner@upgrade.test', 'usr_owner', 'ws_upgrade');

        INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES
          ('ws_upgrade', 'usr_owner', 'owner', ${now}),
          ('ws_upgrade', 'usr_editor', 'editor', ${now}),
          ('ws_upgrade', 'usr_viewer', 'viewer', ${now});

        INSERT INTO projects (id, workspace_id, name, icon, color, position, created_at, updated_at)
        VALUES ('proj_1', 'ws_upgrade', 'Core Upgrade Project', '🚀', '#8b5cf6', 'a0', ${now}, ${now});

        INSERT INTO tags (id, project_id, name, color)
        VALUES ('tag_1', 'proj_1', 'release', '#3b82f6');

        INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, icon, content, version, position, is_favorite, created_by, created_at, updated_at)
        VALUES ('np_1', 'ws_upgrade', 'proj_1', NULL, 'notepad', 'Upgrade Safety Note', '📝', '[{"type":"paragraph","content":[{"type":"text","text":"Critical pre-upgrade workspace content."}]}]', 2, 'a0', 1, 'usr_owner', ${now}, ${now});

        INSERT INTO notepads_fts (notepad_id, project_id, title, body)
        VALUES ('np_1', 'proj_1', 'Upgrade Safety Note', 'Critical pre-upgrade workspace content.');

        INSERT INTO notepad_tags (notepad_id, tag_id) VALUES ('np_1', 'tag_1');

        INSERT INTO boards (id, workspace_id, project_id, name, icon, position, created_at, updated_at)
        VALUES ('board_1', 'ws_upgrade', 'proj_1', 'Upgrade Board', '📋', 'a0', ${now}, ${now});

        INSERT INTO board_columns (id, board_id, name, position)
        VALUES ('col_1', 'board_1', 'In progress', 'a0');

        INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, icon, content, version, position, is_favorite, created_by, created_at, updated_at)
        VALUES ('np_card_1', 'ws_upgrade', 'proj_1', NULL, 'card', 'Upgrade Card Task', '🔖', '[{"type":"paragraph","content":[{"type":"text","text":"Verify task survives schema upgrade."}]}]', 1, 'a0', 0, 'usr_editor', ${now}, ${now});

        INSERT INTO notepads_fts (notepad_id, project_id, title, body)
        VALUES ('np_card_1', 'proj_1', 'Upgrade Card Task', 'Verify task survives schema upgrade.');

        INSERT INTO cards (id, board_id, column_id, notepad_id, position, priority, created_at)
        VALUES ('card_1', 'board_1', 'col_1', 'np_card_1', 'a0', 'high', ${now});

        INSERT INTO card_assignees (card_id, user_id) VALUES ('card_1', 'usr_editor');
        INSERT INTO card_subtasks (id, card_id, title, completed, position, created_at)
        VALUES ('sub_1', 'card_1', 'Verify permissions intact', 1, 'a0', ${now});
        INSERT INTO notepad_links (source_id, target_type, target_id)
        VALUES ('np_card_1', 'notepad', 'np_1');
      `);
    } finally {
      sqliteInitial.close();
    }

    // Add a non-destructive forward upgrade migration
    fs.writeFileSync(
      path.join(migrations, '0002_add_project_archived_note.sql'),
      `ALTER TABLE projects ADD COLUMN upgrade_marker TEXT;
       UPDATE projects SET upgrade_marker = 'v2-migrated' WHERE id = 'proj_1';`,
    );

    const sqliteUpgraded = openSqliteDatabase(filename, migrations);
    try {
      const ledger = sqliteUpgraded
        .prepare('SELECT filename FROM _migrations ORDER BY filename')
        .all() as { filename: string }[];
      expect(ledger.map((r) => r.filename)).toEqual([
        '0000_baseline.sql',
        '0001_rate_limits_and_cleanup.sql',
        '0002_add_project_archived_note.sql',
        '0003_add_workspace_feature_flags.sql',
        '0004_add_public_shares.sql',
        '0005_add_public_share_enabled.sql',
        '0006_add_card_type.sql',
      ]);

      const roles = sqliteUpgraded
        .prepare('SELECT user_id, role FROM members WHERE workspace_id = ? ORDER BY user_id')
        .all('ws_upgrade');
      expect(roles).toEqual([
        { user_id: 'usr_editor', role: 'editor' },
        { user_id: 'usr_owner', role: 'owner' },
        { user_id: 'usr_viewer', role: 'viewer' },
      ]);

      const project = sqliteUpgraded
        .prepare('SELECT name, upgrade_marker FROM projects WHERE id = ?')
        .get('proj_1');
      expect(project).toEqual({ name: 'Core Upgrade Project', upgrade_marker: 'v2-migrated' });

      expect(
        sqliteUpgraded.prepare('SELECT title, version FROM notepads WHERE id = ?').get('np_1'),
      ).toEqual({ title: 'Upgrade Safety Note', version: 2 });
      expect(
        sqliteUpgraded
          .prepare('SELECT notepad_id FROM notepads_fts WHERE notepads_fts MATCH ?')
          .all('"pre-upgrade"'),
      ).toEqual([{ notepad_id: 'np_1' }]);
      expect(sqliteUpgraded.prepare('SELECT priority FROM cards WHERE id = ?').get('card_1')).toEqual({
        priority: 'high',
      });
      expect(
        sqliteUpgraded.prepare('SELECT user_id FROM card_assignees WHERE card_id = ?').all('card_1'),
      ).toEqual([{ user_id: 'usr_editor' }]);
      expect(
        sqliteUpgraded.prepare('SELECT title, completed FROM card_subtasks WHERE id = ?').get('sub_1'),
      ).toEqual({ title: 'Verify permissions intact', completed: 1 });
      expect(
        sqliteUpgraded
          .prepare('SELECT target_type, target_id FROM notepad_links WHERE source_id = ?')
          .all('np_card_1'),
      ).toEqual([{ target_type: 'notepad', target_id: 'np_1' }]);

      const invariantSql = fs.readFileSync(path.join(root, 'scripts/check-invariants.sql'), 'utf8');
      const offenders = splitSqlStatements(invariantSql).flatMap((stmt) =>
        sqliteUpgraded.prepare(stmt).all(),
      );
      expect(offenders).toEqual([]);
    } finally {
      sqliteUpgraded.close();
    }
  });

  it.skipIf(process.env.BURROW_TEST_SQLITE_ONLY === '1')(
    'preserves existing workspace data, roles, content, and invariants across a forward PostgreSQL upgrade',
    async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-pg-upgrade-'));
      directories.push(directory);
      const pgMigrations = path.join(directory, 'postgres');
      fs.mkdirSync(pgMigrations);
      for (const file of fs
        .readdirSync(path.join(root, 'migrations/postgres'))
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        fs.copyFileSync(path.join(root, 'migrations/postgres', file), path.join(pgMigrations, file));
      }

      let container: string | undefined;
      let adminUrl = process.env.BURROW_TEST_POSTGRES_URL;
      let admin: postgres.Sql | undefined;
      let client: postgres.Sql | undefined;
      const testDb = `upgrade_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      try {
        if (!adminUrl) {
          const candidateContainer = `burrow-test-upgrade-${randomUUID()}`;
          await docker(
            'run',
            '--detach',
            '--rm',
            '--name',
            candidateContainer,
            '--publish',
            '127.0.0.1::5432',
            '--env',
            'POSTGRES_USER=burrow_test',
            '--env',
            'POSTGRES_PASSWORD=burrow_test',
            '--env',
            'POSTGRES_DB=postgres',
            'postgres:17',
          );
          container = candidateContainer;
          const address = await docker('port', container, '5432/tcp');
          const port = /^127\.0\.0\.1:(\d+)$/.exec(address)?.[1];
          if (!port) throw new Error('Disposable PostgreSQL did not publish a loopback port');
          adminUrl = `postgres://burrow_test:burrow_test@127.0.0.1:${port}/postgres`;
        }

        admin = postgres(adminUrl, { max: 1, onnotice: () => {}, connect_timeout: 2 });
        for (let attempt = 0; ; attempt++) {
          try {
            await admin`SELECT 1`;
            break;
          } catch (error) {
            if (attempt === 39) throw error;
            await setTimeout(250);
          }
        }
        await admin.unsafe(`CREATE DATABASE "${testDb}"`);

        const dbUrl = new URL(adminUrl);
        dbUrl.pathname = `/${testDb}`;
        client = postgres(dbUrl.toString(), { max: 2, onnotice: () => {} });

        await applyPostgresMigrations(client, pgMigrations);

        const nowMs = Date.now();
        await client.unsafe(`
          INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES
            ('usr_owner', 'Owner User', 'owner@upgrade.test', true, now(), now()),
            ('usr_editor', 'Editor User', 'editor@upgrade.test', true, now(), now()),
            ('usr_viewer', 'Viewer User', 'viewer@upgrade.test', true, now(), now());

          INSERT INTO workspaces (id, name, created_by, created_at)
          VALUES ('ws_upgrade', 'Upgrade Test Workspace', 'usr_owner', ${nowMs});

          UPDATE bootstrap_state
          SET status = 'complete', claim_email = 'owner@upgrade.test', user_id = 'usr_owner', workspace_id = 'ws_upgrade'
          WHERE id = 1;

          INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES
            ('ws_upgrade', 'usr_owner', 'owner', ${nowMs}),
            ('ws_upgrade', 'usr_editor', 'editor', ${nowMs}),
            ('ws_upgrade', 'usr_viewer', 'viewer', ${nowMs});

          INSERT INTO projects (id, workspace_id, name, icon, color, position, created_at, updated_at)
          VALUES ('proj_1', 'ws_upgrade', 'Core Upgrade Project', '🚀', '#8b5cf6', 'a0', ${nowMs}, ${nowMs});

          INSERT INTO tags (id, project_id, name, color)
          VALUES ('tag_1', 'proj_1', 'release', '#3b82f6');

          INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, icon, content, version, position, is_favorite, created_by, created_at, updated_at)
          VALUES ('np_1', 'ws_upgrade', 'proj_1', NULL, 'notepad', 'Upgrade Safety Note', '📝', '[{"type":"paragraph","content":[{"type":"text","text":"Critical pre-upgrade workspace content."}]}]', 2, 'a0', true, 'usr_owner', ${nowMs}, ${nowMs});

          INSERT INTO notepad_tags (notepad_id, tag_id) VALUES ('np_1', 'tag_1');

          INSERT INTO boards (id, workspace_id, project_id, name, icon, position, created_at, updated_at)
          VALUES ('board_1', 'ws_upgrade', 'proj_1', 'Upgrade Board', '📋', 'a0', ${nowMs}, ${nowMs});

          INSERT INTO board_columns (id, board_id, name, position)
          VALUES ('col_1', 'board_1', 'In progress', 'a0');

          INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, icon, content, version, position, is_favorite, created_by, created_at, updated_at)
          VALUES ('np_card_1', 'ws_upgrade', 'proj_1', NULL, 'card', 'Upgrade Card Task', '🔖', '[{"type":"paragraph","content":[{"type":"text","text":"Verify task survives schema upgrade."}]}]', 1, 'a0', false, 'usr_editor', ${nowMs}, ${nowMs});

          INSERT INTO cards (id, board_id, column_id, notepad_id, position, priority, created_at)
          VALUES ('card_1', 'board_1', 'col_1', 'np_card_1', 'a0', 'high', ${nowMs});

          INSERT INTO card_assignees (card_id, user_id) VALUES ('card_1', 'usr_editor');
          INSERT INTO card_subtasks (id, card_id, title, completed, position, created_at)
          VALUES ('sub_1', 'card_1', 'Verify permissions intact', true, 'a0', ${nowMs});
          INSERT INTO notepad_links (source_id, target_type, target_id, target_notepad_id)
          VALUES ('np_card_1', 'notepad', 'np_1', 'np_1');
        `);

        fs.writeFileSync(
          path.join(pgMigrations, '0002_add_project_archived_note.sql'),
          `ALTER TABLE projects ADD COLUMN upgrade_marker TEXT;
           UPDATE projects SET upgrade_marker = 'v2-migrated' WHERE id = 'proj_1';`,
        );

        await applyPostgresMigrations(client, pgMigrations);

        const ledger = await client<{ filename: string }[]>`
          SELECT filename FROM _migrations ORDER BY filename
        `;
        expect(ledger.map((r) => r.filename)).toEqual([
          '0000_baseline.sql',
          '0001_rate_limits_and_cleanup.sql',
          '0002_add_project_archived_note.sql',
          '0003_add_workspace_feature_flags.sql',
          '0004_add_public_shares.sql',
          '0005_add_public_share_enabled.sql',
          '0006_add_card_type.sql',
        ]);

        const roles = await client<{ user_id: string; role: string }[]>`
          SELECT user_id, role::text FROM members WHERE workspace_id = 'ws_upgrade' ORDER BY user_id
        `;
        expect(roles).toEqual([
          { user_id: 'usr_editor', role: 'editor' },
          { user_id: 'usr_owner', role: 'owner' },
          { user_id: 'usr_viewer', role: 'viewer' },
        ]);

        const project = await client<{ name: string; upgrade_marker: string }[]>`
          SELECT name, upgrade_marker FROM projects WHERE id = 'proj_1'
        `;
        expect(project).toEqual([{ name: 'Core Upgrade Project', upgrade_marker: 'v2-migrated' }]);

        const pgInvariants = fs.readFileSync(
          path.join(root, 'scripts/check-invariants.postgres.sql'),
          'utf8',
        );
        for (const stmt of splitSqlStatements(pgInvariants)) {
          expect(await client.unsafe(stmt)).toEqual([]);
        }
      } finally {
        if (client) await client.end();
        if (admin) {
          try {
            await admin.unsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
          } finally {
            await admin.end();
          }
        }
        if (container) {
          await docker('rm', '--force', container);
        }
      }
    },
    120_000,
  );
});

describe('Worker first-boot D1 auto-initialization (Deploy to Cloudflare)', () => {
  function createSqliteBackedD1(sqlite: InstanceType<typeof Database>): D1Database {
    const createStatement = (sqlText: string, params: unknown[] = []) => ({
      bind: (...nextParams: unknown[]) => createStatement(sqlText, nextParams),
      first: async <T = unknown>() =>
        (sqlite.prepare(sqlText).get(...params) as T | undefined) ?? null,
      all: async <T = unknown>() => ({
        results: sqlite.prepare(sqlText).all(...params) as T[],
        success: true,
        meta: {},
      }),
      run: async () => {
        const info = sqlite.prepare(sqlText).run(...params);
        return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
      },
    });
    return {
      prepare: (sqlText: string) => createStatement(sqlText),
      batch: async (stmts: Array<{ run: () => Promise<any> }>) => {
        const results = [];
        const tx = sqlite.transaction(() => {});
        void tx;
        sqlite.exec('BEGIN');
        try {
          for (const stmt of stmts) {
            results.push(await stmt.run());
          }
          sqlite.exec('COMMIT');
        } catch (err) {
          sqlite.exec('ROLLBACK');
          throw err;
        }
        return results;
      },
    } as unknown as D1Database;
  }

  it('keeps D1_MIGRATIONS byte-for-byte synced with migrations/*.sql', () => {
    const diskFiles = fs
      .readdirSync(path.join(root, 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(D1_MIGRATIONS.map((m) => m.name)).toEqual(diskFiles);
    for (const entry of D1_MIGRATIONS) {
      expect(entry.sql).not.toContain('\r');
      const diskContent = fs
        .readFileSync(path.join(root, 'migrations', entry.name), 'utf8')
        .replace(/\r\n/g, '\n');
      expect(entry.sql).toBe(diskContent);
    }
  });

  it('derives BETTER_AUTH_URL safely for HTTPS and localhost when omitted', () => {
    expect(
      deriveWorkerAuthUrl('https://notes.example.com', 'https://other.workers.dev/api/health'),
    ).toBe('https://notes.example.com');
    expect(deriveWorkerAuthUrl(undefined, 'https://burrow.myacct.workers.dev/api/health')).toBe(
      'https://burrow.myacct.workers.dev',
    );
    expect(
      deriveWorkerAuthUrl('http://localhost:3005', 'https://burrow.example.workers.dev/api/auth/config'),
    ).toBe('https://burrow.example.workers.dev');
    expect(deriveWorkerAuthUrl('', 'http://localhost:8787/api/auth/config')).toBe(
      'http://localhost:8787',
    );
    expect(deriveWorkerAuthUrl('', 'http://evil.example/api/auth/config')).toBe('');
  });

  it('auto-migrates a fresh D1 database, persists a CSPRNG secret, and holds all invariants', async () => {
    const { directory, filename } = temporaryDatabase();
    void directory;
    const sqlite = new Database(filename);
    try {
      sqlite.pragma('foreign_keys = ON');
      const d1 = createSqliteBackedD1(sqlite);
      const env1 = await ensureWorkerRuntimeEnv(
        {
          DB: d1,
          FILES: {} as R2Bucket,
          BETTER_AUTH_SECRET: '',
          BETTER_AUTH_URL: '',
          BOOTSTRAP_TOKEN: 'boot-token-123456',
        },
        new Request('https://fresh-burrow.example.workers.dev/api/health'),
      );

      expect(env1.BETTER_AUTH_URL).toBe('https://fresh-burrow.example.workers.dev');
      expect(env1.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
      expect(env1.BOOTSTRAP_TOKEN).toBe('boot-token-123456');

      const appliedRows = sqlite
        .prepare('SELECT name FROM d1_migrations ORDER BY name')
        .all() as Array<{ name: string }>;
      expect(appliedRows.map((r) => r.name)).toEqual(D1_MIGRATIONS.map((m) => m.name));

      const wsCols = sqlite
        .prepare("PRAGMA table_info('workspaces')")
        .all() as Array<{ name: string }>;
      expect(wsCols.some((c) => c.name === 'feature_flags')).toBe(true);

      const psCols = sqlite
        .prepare("PRAGMA table_info('public_shares')")
        .all() as Array<{ name: string }>;
      expect(psCols.some((c) => c.name === 'enabled')).toBe(true);

      // Re-running on a fresh DB handle (simulating cold isolate restart) reuses the exact persisted secret
      const d1ColdRestart = createSqliteBackedD1(sqlite);
      const env2 = await ensureWorkerRuntimeEnv(
        {
          DB: d1ColdRestart,
          FILES: {} as R2Bucket,
          BETTER_AUTH_SECRET: '',
          BETTER_AUTH_URL: '',
          BOOTSTRAP_TOKEN: '',
        },
        new Request('https://fresh-burrow.example.workers.dev/api/auth/config'),
      );
      expect(env2.BETTER_AUTH_SECRET).toBe(env1.BETTER_AUTH_SECRET);

      const invariantSql = fs.readFileSync(path.join(root, 'scripts/check-invariants.sql'), 'utf8');
      const offenders = splitSqlStatements(invariantSql).flatMap((stmt) =>
        sqlite.prepare(stmt).all(),
      );
      expect(offenders).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
