import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase } from '../../src/server/sqlite';
import { splitSqlStatements } from '../../src/server/sql-statements';

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

  it('backfills safe legacy covers without rewriting invalid or shared references', () => {
    const { migrations, filename } = temporaryDatabase();
    for (const file of fs
      .readdirSync(path.join(root, 'migrations'))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name) && name < '0010_')) {
      fs.copyFileSync(path.join(root, 'migrations', file), path.join(migrations, file));
    }
    const migrationFile = '0010_legacy_cover_file_registrations.sql';
    const first = openSqliteDatabase(filename, migrations);
    try {
      first
        .prepare(
          'INSERT INTO "user" (id, name, email, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
        )
        .run('cover-owner', 'Cover Owner', 'cover-owner@example.test', 100, 100);
      first
        .prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run('cover-ws-a', 'Workspace A', 'cover-owner', 101);
      first
        .prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run('cover-ws-b', 'Workspace B', 'cover-owner', 102);
      const insertProject = first.prepare(
        'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      insertProject.run('cover-project-a', 'cover-ws-a', 'Project A', 'a0', 103, 103);
      insertProject.run('cover-project-b', 'cover-ws-a', 'Project B', 'a1', 104, 104);
      const insertNotepad = first.prepare(
        `INSERT INTO notepads
          (id, workspace_id, project_id, kind, title, cover_key, content, version, position,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'notepad', ?, ?, '[]', 1, ?, 'cover-owner', ?, ?)`,
      );
      const notes = [
        ['cover-note-a', 'cover-ws-a', 'cover-project-a', 'cover-ws-a/shared.PNG', 'a0', 201],
        ['cover-note-b', 'cover-ws-a', 'cover-project-b', 'cover-ws-a/shared.PNG', 'a0', 202],
        ['cover-note-octet', 'cover-ws-a', 'cover-project-a', 'cover-ws-a/legacy.bin', 'a1', 203],
        ['cover-note-cross-scope', 'cover-ws-b', 'cover-project-a', 'cover-ws-b/foreign.jpg', 'a2', 204],
        ['cover-note-cross-key', 'cover-ws-a', 'cover-project-a', 'cover-ws-b/foreign.png', 'a3', 205],
        ['cover-note-traversal', 'cover-ws-a', 'cover-project-a', 'cover-ws-a/../escape.png', 'a4', 206],
      ] as const;
      for (const [id, workspaceId, projectId, coverKey, position, createdAt] of notes) {
        insertNotepad.run(id, workspaceId, projectId, id, coverKey, position, createdAt, createdAt);
      }
    } finally {
      first.close();
    }

    fs.copyFileSync(
      path.join(root, 'migrations', migrationFile),
      path.join(migrations, migrationFile),
    );
    const upgraded = openSqliteDatabase(filename, migrations);
    try {
      expect(
        upgraded
          .prepare(
            'SELECT project_id, storage_key, content_type, created_by, created_at FROM project_files ORDER BY project_id, storage_key',
          )
          .all(),
      ).toEqual([
        {
          project_id: 'cover-project-a',
          storage_key: 'cover-ws-a/legacy.bin',
          content_type: 'application/octet-stream',
          created_by: 'cover-owner',
          created_at: 203,
        },
        {
          project_id: 'cover-project-a',
          storage_key: 'cover-ws-a/shared.PNG',
          content_type: 'image/png',
          created_by: 'cover-owner',
          created_at: 201,
        },
        {
          project_id: 'cover-project-b',
          storage_key: 'cover-ws-a/shared.PNG',
          content_type: 'image/png',
          created_by: 'cover-owner',
          created_at: 202,
        },
      ]);
      expect(
        upgraded
          .prepare('SELECT id, cover_key FROM notepads WHERE cover_key IS NOT NULL ORDER BY id')
          .all(),
      ).toHaveLength(6);

      const invariantSql = fs.readFileSync(path.join(root, 'scripts/check-invariants.sql'), 'utf8');
      const i13Sql = invariantSql.slice(invariantSql.indexOf('-- I13:')).replace(/^--.*\r?\n/gm, '').trim();
      expect(upgraded.prepare(i13Sql).all()).toEqual([
        { invariant: 'I13', subject: 'cover-note-cross-scope', detail: 'cover notepad workspace != project workspace' },
        { invariant: 'I13', subject: 'cover-note-cross-key', detail: 'cover key workspace prefix mismatch' },
        { invariant: 'I13', subject: 'cover-note-traversal', detail: 'cover key is not a safe storage key' },
      ]);
    } finally {
      upgraded.close();
    }
    const restarted = openSqliteDatabase(filename, migrations);
    try {
      expect(restarted.prepare('SELECT count(*) AS count FROM project_files').get()).toEqual({
        count: 3,
      });
    } finally {
      restarted.close();
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
