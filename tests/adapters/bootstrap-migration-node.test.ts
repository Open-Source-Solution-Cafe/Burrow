import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { describe, expect, inject, it } from 'vitest';
import { openSqliteDatabase } from '../../src/server/sqlite';
import { applyPostgresMigrations } from '../../src/core/adapters/db/postgres';

type Scenario = 'fresh' | 'populated' | 'orphan';
const sqliteMigration = '0004_bootstrap_state.sql';
const postgresMigration = '0001_left_black_queen.sql';

describe.each(['fresh', 'populated', 'orphan'] as const)(
  'bootstrap migration with %s database',
  (scenario: Scenario) => {
    it('migrates or rolls back atomically on SQLite', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-bootstrap-sqlite-'));
      const migrationDir = path.join(directory, 'migrations');
      const filename = path.join(directory, 'database.sqlite');
      fs.mkdirSync(migrationDir);
      try {
        for (const file of fs.readdirSync('migrations').filter((name) => name.endsWith('.sql'))) {
          if (file !== sqliteMigration)
            fs.copyFileSync(path.join('migrations', file), path.join(migrationDir, file));
        }
        const db = openSqliteDatabase(filename, migrationDir);
        try {
          if (scenario !== 'fresh') {
            db.prepare(
              'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, 1, 1)',
            ).run('u', 'User', 'u@example.com');
          }
          if (scenario === 'populated') {
            db.prepare(
              'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, 1)',
            ).run('w', 'Workspace', 'u');
          }
        } finally {
          db.close();
        }
        fs.copyFileSync(
          path.join('migrations', sqliteMigration),
          path.join(migrationDir, sqliteMigration),
        );
        if (scenario === 'orphan') {
          expect(() => openSqliteDatabase(filename, migrationDir)).toThrow('bootstrap_state_valid');
          const reopened = new Database(filename, { readonly: true });
          try {
            expect(
              reopened
                .prepare("SELECT name FROM sqlite_master WHERE name = 'bootstrap_state'")
                .get(),
            ).toBeUndefined();
            expect(
              reopened
                .prepare('SELECT filename FROM _migrations WHERE filename = ?')
                .get(sqliteMigration),
            ).toBeUndefined();
          } finally {
            reopened.close();
          }
        } else {
          const migrated = openSqliteDatabase(filename, migrationDir);
          try {
            expect(
              migrated
                .prepare('SELECT status, claim_email, user_id, workspace_id FROM bootstrap_state')
                .get(),
            ).toEqual({
              status: scenario === 'fresh' ? 'empty' : 'complete',
              claim_email: null,
              user_id: null,
              workspace_id: null,
            });
          } finally {
            migrated.close();
          }
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('migrates or rolls back atomically on PostgreSQL', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-bootstrap-pg-'));
      const schemaName = `bootstrap_${randomUUID().replaceAll('-', '')}`;
      const admin = postgres(inject('postgresTestUrl'), { max: 1, onnotice: () => {} });
      let client: ReturnType<typeof postgres> | undefined;
      try {
        await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
        client = postgres(inject('postgresTestUrl'), {
          max: 1,
          onnotice: () => {},
          connection: { search_path: schemaName },
        });
        await client`CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL, email_verified boolean NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL)`;
        await client`CREATE TABLE workspaces (id text PRIMARY KEY, name text NOT NULL, created_by text NOT NULL, created_at bigint NOT NULL)`;
        await client`CREATE TABLE _migrations (filename text PRIMARY KEY, applied_at bigint NOT NULL)`;
        await client`INSERT INTO _migrations VALUES ('0000_puzzling_longshot.sql', 1)`;
        if (scenario !== 'fresh') {
          await client`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u', 'User', 'u@example.com', false, now(), now())`;
        }
        if (scenario === 'populated') {
          await client`INSERT INTO workspaces (id, name, created_by, created_at) VALUES ('w', 'Workspace', 'u', 1)`;
        }
        fs.copyFileSync(
          path.join('migrations/postgres', postgresMigration),
          path.join(directory, postgresMigration),
        );
        if (scenario === 'orphan') {
          await expect(applyPostgresMigrations(client, directory)).rejects.toThrow(
            'bootstrap_state_valid',
          );
          const table = await client`SELECT to_regclass('bootstrap_state') AS name`;
          expect(table[0]?.name).toBeNull();
          const ledger =
            await client`SELECT filename FROM _migrations WHERE filename = ${postgresMigration}`;
          expect(ledger).toHaveLength(0);
        } else {
          await applyPostgresMigrations(client, directory);
          const rows =
            await client`SELECT status, claim_email, user_id, workspace_id FROM bootstrap_state`;
          expect(Array.from(rows)).toEqual([
            {
              status: scenario === 'fresh' ? 'empty' : 'complete',
              claim_email: null,
              user_id: null,
              workspace_id: null,
            },
          ]);
        }
      } finally {
        await client?.end();
        await admin.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        await admin.end();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  },
);
