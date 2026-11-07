import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { openSqliteDatabase } from '../../src/server/sqlite';
import * as d1Schema from '../../src/core/adapters/db/d1/schema';
import * as pgSchema from '../../src/core/adapters/db/postgres/schema';
import { getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core';

const directories: string[] = [];
function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-schema-parity-'));
  directories.push(directory);
  const migrations = path.join(directory, 'migrations');
  fs.mkdirSync(migrations);
  return { directory, migrations, filename: path.join(directory, 'db.sqlite') };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function getSqliteTables() {
  const result: { exportName: string; name: string; config: ReturnType<typeof getSqliteTableConfig> }[] = [];
  for (const [exportName, val] of Object.entries(d1Schema)) {
    try {
      const config = getSqliteTableConfig(val as any);
      if (config && config.name) {
        result.push({ exportName, name: config.name, config });
      }
    } catch {
      // not a table
    }
  }
  return result;
}

function getPgTables() {
  const result: { exportName: string; name: string; config: ReturnType<typeof getPgTableConfig> }[] = [];
  for (const [exportName, val] of Object.entries(pgSchema)) {
    try {
      const config = getPgTableConfig(val as any);
      if (config && config.name) {
        result.push({ exportName, name: config.name, config });
      }
    } catch {
      // not a table
    }
  }
  return result;
}

describe('Schema Parity: Migrations from Scratch vs Drizzle Definitions', () => {
  it('creates tables, columns, foreign keys, unique constraints, and triggers matching SQLite Drizzle schema', () => {
    const { migrations, filename } = temporaryDatabase();
    const rootMigrations = path.resolve('migrations');

    // Copy squashed baseline migrations
    for (const file of fs.readdirSync(rootMigrations).filter((n) => n.endsWith('.sql'))) {
      fs.copyFileSync(path.join(rootMigrations, file), path.join(migrations, file));
    }

    const sqlite = openSqliteDatabase(filename, migrations);
    try {
      // 1. Table Parity
      const drizzleTables = getSqliteTables();
      const drizzleTableNames = drizzleTables.map((t) => t.name);

      const dbTables = (
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'notepads_fts_%' AND name <> '_migrations'",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);

      for (const expectedTable of drizzleTableNames) {
        expect(dbTables, `Table ${expectedTable} should exist in migrated SQLite database`).toContain(
          expectedTable,
        );
      }

      // 2. Column Parity
      for (const { name: tableName, config } of drizzleTables) {
        const tableInfo = sqlite.prepare(`PRAGMA table_info('${tableName}')`).all() as {
          name: string;
          notnull: number;
          pk: number;
        }[];

        const dbColumnMap = new Map(tableInfo.map((c) => [c.name, c]));

        for (const col of config.columns) {
          const colName = col.name;
          const dbCol = dbColumnMap.get(colName);
          expect(dbCol, `Column ${tableName}.${colName} should exist in DB`).toBeDefined();

          if (col.notNull) {
            expect(dbCol!.notnull, `Column ${tableName}.${colName} should be NOT NULL`).toBe(1);
          }
          if (col.primary) {
            expect(dbCol!.pk, `Column ${tableName}.${colName} should be PRIMARY KEY`).toBeGreaterThanOrEqual(1);
          }
        }
      }

      // 3. Composite & Direct Foreign Key Parity
      const checkFk = (
        table: string,
        fromCols: string[],
        refTable: string,
        toCols: string[],
        onDelete: string,
      ) => {
        const fks = sqlite.prepare(`PRAGMA foreign_key_list('${table}')`).all() as {
          id: number;
          seq: number;
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }[];

        const grouped = new Map<number, { table: string; from: string[]; to: string[]; onDelete: string }>();
        for (const row of fks) {
          if (!grouped.has(row.id)) {
            grouped.set(row.id, { table: row.table, from: [], to: [], onDelete: row.on_delete });
          }
          const entry = grouped.get(row.id)!;
          entry.from.push(row.from);
          entry.to.push(row.to);
        }

        const match = Array.from(grouped.values()).find(
          (g) =>
            g.table === refTable &&
            g.onDelete.toUpperCase() === onDelete.toUpperCase() &&
            fromCols.every((c) => g.from.includes(c)) &&
            toCols.every((c) => g.to.includes(c)),
        );

        expect(
          match,
          `Expected FK on ${table}(${fromCols.join(', ')}) -> ${refTable}(${toCols.join(', ')}) ON DELETE ${onDelete}`,
        ).toBeDefined();
      };

      // Composite FK checks
      checkFk('notepads', ['project_id', 'workspace_id'], 'projects', ['id', 'workspace_id'], 'CASCADE');
      checkFk('boards', ['project_id', 'workspace_id'], 'projects', ['id', 'workspace_id'], 'CASCADE');
      checkFk('cards', ['column_id', 'board_id'], 'board_columns', ['id', 'board_id'], 'CASCADE');
      checkFk('cards', ['notepad_id', 'kind'], 'notepads', ['id', 'kind'], 'CASCADE');

      // User FK checks (authorship SET NULL, memberships/assignees/locks CASCADE)
      checkFk('workspaces', ['created_by'], 'user', ['id'], 'SET NULL');
      checkFk('project_files', ['created_by'], 'user', ['id'], 'SET NULL');
      checkFk('notepads', ['created_by'], 'user', ['id'], 'SET NULL');
      checkFk('invites', ['invited_by'], 'user', ['id'], 'SET NULL');
      checkFk('members', ['user_id'], 'user', ['id'], 'CASCADE');
      checkFk('card_assignees', ['user_id'], 'user', ['id'], 'CASCADE');
      checkFk('edit_locks', ['user_id'], 'user', ['id'], 'CASCADE');

      // 4. Unique Constraints & Indexes Parity
      const checkUnique = (table: string, cols: string[]) => {
        const indexes = sqlite.prepare(`PRAGMA index_list('${table}')`).all() as {
          name: string;
          unique: number;
        }[];
        const uniqueIndexes = indexes.filter((i) => i.unique === 1);

        let found = false;
        for (const idx of uniqueIndexes) {
          const idxCols = (
            sqlite.prepare(`PRAGMA index_info('${idx.name}')`).all() as { name: string }[]
          ).map((c) => c.name);

          if (cols.length === idxCols.length && cols.every((c) => idxCols.includes(c))) {
            found = true;
            break;
          }
        }
        expect(found, `Expected unique constraint/index on ${table}(${cols.join(', ')})`).toBe(true);
      };

      checkUnique('projects', ['id', 'workspace_id']);
      checkUnique('board_columns', ['id', 'board_id']);
      checkUnique('notepads', ['id', 'kind']);
      checkUnique('cards', ['notepad_id']);
      checkUnique('tags', ['project_id', 'name']);
      checkUnique('invites', ['token_hash']);

      // 5. Guard Triggers Parity
      const triggers = (
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);

      const expectedTriggers = [
        'projects_scope_delete_guard',
        'notepads_scope_delete_guard',
        'boards_scope_delete_guard',
        'board_columns_scope_delete_guard',
        'notepads_scope_insert_guard',
        'notepads_scope_update_guard',
        'projects_scope_update_guard',
        'boards_scope_insert_guard',
        'boards_scope_update_guard',
        'cards_scope_insert_guard',
        'cards_scope_update_guard',
        'notepad_tags_scope_insert_guard',
        'notepad_tags_scope_update_guard',
        'tags_scope_update_guard',
        'notepad_links_scope_insert_guard',
        'notepad_links_scope_update_guard',
        'card_assignees_scope_insert_guard',
        'card_assignees_scope_update_guard',
        'card_comments_scope_insert_guard',
        'card_comments_scope_update_guard',
        'notifications_scope_insert_guard',
        'notifications_scope_update_guard',
        'user_delete_cascades',
        'notepads_cleanup_links',
        'cards_cleanup_links',
        'boards_cleanup_links',
        'members_cleanup_workspace_assignments',
      ];

      for (const trg of expectedTriggers) {
        expect(triggers, `Expected trigger ${trg} to be defined in SQLite`).toContain(trg);
      }
    } finally {
      sqlite.close();
    }
  });

  it('creates tables, columns, foreign keys, unique constraints, and triggers matching PostgreSQL Drizzle schema', async () => {
    const adminUrl =
      process.env.BURROW_TEST_POSTGRES_URL ||
      'postgres://burrow_test:burrow_test@127.0.0.1:49817/postgres';

    let admin: postgres.Sql | undefined;
    let client: postgres.Sql | undefined;
    const testDb = `parity_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    try {
      admin = postgres(adminUrl, { max: 1, onnotice: () => {}, connect_timeout: 2 });
      await admin.unsafe(`CREATE DATABASE "${testDb}"`);

      const dbUrl = new URL(adminUrl);
      dbUrl.pathname = `/${testDb}`;
      client = postgres(dbUrl.toString(), { max: 2, onnotice: () => {} });

      // Run squashed PostgreSQL baseline migration
      const pgBaselinePath = path.resolve('migrations/postgres/0000_baseline.sql');
      const pgSql = fs.readFileSync(pgBaselinePath, 'utf8');
      await client.unsafe(pgSql);

      // 1. Table Parity
      const drizzleTables = getPgTables();
      const drizzleTableNames = drizzleTables.map((t) => t.name);

      const dbTables = (
        await client<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `
      ).map((r) => r.table_name);

      for (const expectedTable of drizzleTableNames) {
        expect(dbTables, `Table ${expectedTable} should exist in migrated PostgreSQL database`).toContain(
          expectedTable,
        );
      }

      // 2. Foreign Key Parity (Composite and Direct)
      const fks = await client<{
        conname: string;
        relname: string;
        confrelname: string;
        confdeltype: string;
      }[]>`
        SELECT 
          c.conname,
          src.relname,
          dst.relname as confrelname,
          c.confdeltype::text
        FROM pg_constraint c
        JOIN pg_class src ON src.oid = c.conrelid
        JOIN pg_class dst ON dst.oid = c.confrelid
        WHERE c.contype = 'f' AND src.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      `;

      // Check specific FKs exist
      expect(fks.some((f) => f.relname === 'notepads' && f.confrelname === 'projects' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'boards' && f.confrelname === 'projects' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'cards' && f.confrelname === 'board_columns' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'cards' && f.confrelname === 'notepads' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'card_assignees' && f.confrelname === 'user' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'members' && f.confrelname === 'user' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'workspaces' && f.confrelname === 'user' && f.confdeltype === 'n')).toBe(true);

      // 3. Unique Constraints
      const uqs = await client<{ conname: string; relname: string }[]>`
        SELECT c.conname, src.relname
        FROM pg_constraint c
        JOIN pg_class src ON src.oid = c.conrelid
        WHERE c.contype = 'u' AND src.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      `;

      expect(uqs.some((u) => u.relname === 'projects' && u.conname === 'projects_id_workspace_uq')).toBe(true);
      expect(uqs.some((u) => u.relname === 'notepads' && u.conname === 'notepads_id_kind_uq')).toBe(true);
      expect(uqs.some((u) => u.relname === 'board_columns' && u.conname === 'board_columns_id_board_uq')).toBe(true);

      // 4. Triggers
      const triggers = (
        await client<{ tgname: string }[]>`
          SELECT tgname FROM pg_trigger
          WHERE NOT tgisinternal AND tgrelid IN (
            SELECT oid FROM pg_class WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
          )
        `
      ).map((t) => t.tgname);

      const expectedPgTriggers = [
        'projects_scope_delete_guard',
        'notepads_scope_delete_guard',
        'boards_scope_delete_guard',
        'board_columns_scope_delete_guard',
        'notepads_scope_write_guard',
        'projects_scope_write_guard',
        'boards_scope_write_guard',
        'cards_scope_write_guard',
        'notepad_tags_scope_write_guard',
        'tags_scope_write_guard',
        'notepad_links_scope_write_guard',
        'card_assignees_scope_write_guard',
        'card_comments_scope_write_guard',
        'notifications_scope_write_guard',
        'notepads_cleanup_links',
        'cards_cleanup_links',
        'boards_cleanup_links',
        'user_cleanup_links',
        'members_cleanup_workspace_assignments',
      ];

      for (const trg of expectedPgTriggers) {
        expect(triggers, `Expected PostgreSQL trigger ${trg} to be defined`).toContain(trg);
      }
    } finally {
      if (client) await client.end();
      if (admin) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
        await admin.end();
      }
    }
  });
});
