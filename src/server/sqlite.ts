import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

/** The same migrated SQLite handle is used by the server and local CLI scripts. */
export function openSqliteDatabase(
  sqlitePath: string,
  migrationsDir: string,
): InstanceType<typeof Database> {
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const sqlite = new Database(sqlitePath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite
      .transaction(() => {
        sqlite.exec(
          'CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
        );
        const applied = new Set(
          (sqlite.prepare('SELECT filename FROM _migrations').all() as { filename: string }[]).map(
            (row) => row.filename,
          ),
        );
        for (const file of readdirSync(migrationsDir)
          .filter((name) => name.endsWith('.sql'))
          .sort()) {
          if (applied.has(file)) continue;
          sqlite.exec(readFileSync(join(migrationsDir, file), 'utf8'));
          sqlite
            .prepare('INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)')
            .run(file, Date.now());
        }
      })
      .immediate();
    return sqlite;
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
