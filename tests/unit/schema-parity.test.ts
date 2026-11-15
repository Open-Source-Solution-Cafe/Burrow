import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { openSqliteDatabase } from '../../src/server/sqlite';
import * as d1Schema from '../../src/core/adapters/db/d1/schema';
import * as pgSchema from '../../src/core/adapters/db/postgres/schema';
import { getTableConfig as getSqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { getTableConfig as getPgTableConfig } from 'drizzle-orm/pg-core';

const exec = promisify(execFile);
const docker = async (...args: string[]) =>
  (await exec('docker', args, { windowsHide: true, timeout: 120_000 })).stdout.trim();

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
        const tableInfo = sqlite.prepare(`PRAGMA table_xinfo('${tableName}')`).all() as {
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
      checkFk('bootstrap_state', ['user_id'], 'user', ['id'], 'SET NULL');
      checkFk('bootstrap_state', ['workspace_id'], 'workspaces', ['id'], 'SET NULL');
      checkFk('project_files', ['created_by'], 'user', ['id'], 'SET NULL');
      checkFk('notepads', ['created_by'], 'user', ['id'], 'SET NULL');
      checkFk('invites', ['invited_by'], 'user', ['id'], 'SET NULL');
      checkFk('members', ['user_id'], 'user', ['id'], 'CASCADE');
      checkFk('card_assignees', ['user_id'], 'user', ['id'], 'CASCADE');
      checkFk('edit_locks', ['user_id'], 'user', ['id'], 'CASCADE');

      // Notifications & Notepad Links FK checks
      checkFk('notifications', ['workspace_id'], 'workspaces', ['id'], 'CASCADE');
      checkFk('notifications', ['user_id'], 'user', ['id'], 'CASCADE');
      checkFk('notifications', ['actor_id'], 'user', ['id'], 'SET NULL');
      checkFk('notepad_links', ['source_id'], 'notepads', ['id'], 'CASCADE');
      checkFk('notepad_links', ['target_user_id'], 'user', ['id'], 'CASCADE');
      checkFk('notepad_links', ['target_notepad_id'], 'notepads', ['id'], 'CASCADE');
      checkFk('notepad_links', ['target_card_id'], 'cards', ['id'], 'CASCADE');
      checkFk('notepad_links', ['target_board_id'], 'boards', ['id'], 'CASCADE');

      // Single-target CHECK constraint & actor ON DELETE SET NULL behavior (SQLite)
      const notepadLinksDdl = (
        sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notepad_links'")
          .get() as { sql: string }
      ).sql;
      expect(notepadLinksDdl).toContain('notepad_links_single_target_chk');

      sqlite.exec(`
        INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
        VALUES ('u-owner', 'Owner', 'owner@test.local', 1, 1000, 1000),
               ('u-actor', 'Actor', 'actor@test.local', 1, 1000, 1000);
        INSERT INTO workspaces (id, name, created_by, created_at)
        VALUES ('w-1', 'WS', 'u-owner', 1000);
        INSERT INTO members (workspace_id, user_id, role, joined_at)
        VALUES ('w-1', 'u-owner', 'owner', 1000), ('w-1', 'u-actor', 'editor', 1000);
        INSERT INTO notifications (id, workspace_id, user_id, type, actor_id, created_at)
        VALUES ('n-1', 'w-1', 'u-owner', 'mention', 'u-actor', 1000);
        DELETE FROM "user" WHERE id = 'u-actor';
      `);
      const survivingNotif = sqlite
        .prepare("SELECT id, actor_id FROM notifications WHERE id = 'n-1'")
        .get() as { id: string; actor_id: string | null } | undefined;
      expect(survivingNotif).toEqual({ id: 'n-1', actor_id: null });

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
        'trg_prevent_sole_owner_user_delete',
      ];

      for (const trg of expectedTriggers) {
        expect(triggers, `Expected trigger ${trg} to be defined in SQLite`).toContain(trg);
      }
    } finally {
      sqlite.close();
    }
  });

  it.skipIf(process.env.BURROW_TEST_SQLITE_ONLY === '1')(
    'creates tables, columns, foreign keys, unique constraints, and triggers matching PostgreSQL Drizzle schema',
    async () => {
    let container: string | undefined;
    let adminUrl = process.env.BURROW_TEST_POSTGRES_URL;
    let admin: postgres.Sql | undefined;
    let client: postgres.Sql | undefined;
    const testDb = `parity_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    try {
      if (!adminUrl) {
        const candidateContainer = `burrow-test-parity-${randomUUID()}`;
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

      // Run all PostgreSQL migrations in sorted order
      const pgMigrationsDir = path.resolve('migrations/postgres');
      for (const file of fs
        .readdirSync(pgMigrationsDir)
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        await client.unsafe(fs.readFileSync(path.join(pgMigrationsDir, file), 'utf8'));
      }

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
        from_col: string;
        confrelname: string;
        confdeltype: string;
      }[]>`
        SELECT 
          c.conname,
          src.relname,
          a.attname AS from_col,
          dst.relname AS confrelname,
          c.confdeltype::text
        FROM pg_constraint c
        JOIN pg_class src ON src.oid = c.conrelid
        JOIN pg_class dst ON dst.oid = c.confrelid
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
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
      expect(fks.some((f) => f.relname === 'bootstrap_state' && f.from_col === 'user_id' && f.confrelname === 'user' && f.confdeltype === 'n')).toBe(true);
      expect(fks.some((f) => f.relname === 'bootstrap_state' && f.from_col === 'workspace_id' && f.confrelname === 'workspaces' && f.confdeltype === 'n')).toBe(true);
      expect(fks.some((f) => f.relname === 'notifications' && f.from_col === 'workspace_id' && f.confrelname === 'workspaces' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'notifications' && f.from_col === 'actor_id' && f.confrelname === 'user' && f.confdeltype === 'n')).toBe(true);
      expect(fks.some((f) => f.relname === 'notepad_links' && f.from_col === 'target_user_id' && f.confrelname === 'user' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'notepad_links' && f.from_col === 'target_notepad_id' && f.confrelname === 'notepads' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'notepad_links' && f.from_col === 'target_card_id' && f.confrelname === 'cards' && f.confdeltype === 'c')).toBe(true);
      expect(fks.some((f) => f.relname === 'notepad_links' && f.from_col === 'target_board_id' && f.confrelname === 'boards' && f.confdeltype === 'c')).toBe(true);

      // Single-target CHECK constraint & actor ON DELETE SET NULL behavior (Postgres)
      const checkConstraints = (
        await client<{ conname: string; relname: string }[]>`
          SELECT c.conname, src.relname
          FROM pg_constraint c
          JOIN pg_class src ON src.oid = c.conrelid
          WHERE c.contype = 'c' AND src.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        `
      );
      expect(
        checkConstraints.some(
          (c) => c.relname === 'notepad_links' && c.conname === 'notepad_links_single_target_chk',
        ),
      ).toBe(true);

      await client.unsafe(`
        INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
        VALUES ('u-owner', 'Owner', 'owner@test.local', true, now(), now()),
               ('u-actor', 'Actor', 'actor@test.local', true, now(), now());
        INSERT INTO workspaces (id, name, created_by, created_at)
        VALUES ('w-1', 'WS', 'u-owner', 1000);
        INSERT INTO members (workspace_id, user_id, role, joined_at)
        VALUES ('w-1', 'u-owner', 'owner', 1000), ('w-1', 'u-actor', 'editor', 1000);
        INSERT INTO notifications (id, workspace_id, user_id, type, actor_id, created_at)
        VALUES ('n-1', 'w-1', 'u-owner', 'mention', 'u-actor', 1000);
        DELETE FROM "user" WHERE id = 'u-actor';
      `);
      const pgSurvivingNotif = await client<{ id: string; actor_id: string | null }[]>`
        SELECT id, actor_id FROM notifications WHERE id = 'n-1'
      `;
      expect(pgSurvivingNotif).toEqual([{ id: 'n-1', actor_id: null }]);

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
        'trg_prevent_sole_owner_user_delete',
      ];

      for (const trg of expectedPgTriggers) {
        expect(triggers, `Expected PostgreSQL trigger ${trg} to be defined`).toContain(trg);
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
  });
});
