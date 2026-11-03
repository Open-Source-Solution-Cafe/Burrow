import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../core/adapters/db/d1/schema';
import type { NodeDb } from '../core/adapters/db/d1/client';
import { openSqliteDatabase } from './sqlite';

export interface OpenDbResult {
  sqlite: InstanceType<typeof Database>;
  db: NodeDb;
}

/**
 * Open (creating parent dirs) the better-sqlite3 file, enable WAL +
 * foreign_keys, and apply `migrations/*.sql` in lexical order, tracking
 * applied filenames in `_migrations` so restarts are idempotent.
 *
 * Whole-file `exec()` works because drizzle-kit separates statements with
 * `--> statement-breakpoint` markers, which are plain `--` SQL comments.
 */
export function openNodeDb(sqlitePath: string, migrationsDir: string): OpenDbResult {
  const sqlite = openSqliteDatabase(sqlitePath, migrationsDir);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
