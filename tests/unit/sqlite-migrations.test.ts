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
