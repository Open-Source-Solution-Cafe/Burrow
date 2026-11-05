import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Infrastructure } from '../../../infrastructure/types';
import { schema } from './schema';
import type { ServerConfig } from '../../../../server/config';
import { PostgresWorkspaceRepository } from './repositories/workspace';
import { PostgresProjectRepository } from './repositories/project';
import { PostgresProjectFileRepository } from './repositories/project-file';
import { PostgresBoardRepository } from './repositories/board';
import { PostgresCardRepository } from './repositories/card';
import { PostgresNotepadRepository } from './repositories/notepad';
import { PostgresTagRepository } from './repositories/tag';
import { PostgresNotificationRepository } from './repositories/notification';
import { PostgresMemberRepository } from './repositories/member';
import { PostgresInviteRepository } from './repositories/invite';
import { PostgresSearchAdapter } from './search';
import { PostgresLockAdapter } from './lock';
import { createPostgresAuthProvider } from './auth';
import { createEmailFromEnv } from '../../email/factory';
import { createStorageFromEnv } from '../../storage/factory';

/**
 * Postgres database instance type
 */
export type PostgresDb = PostgresJsDatabase<typeof schema>;

/**
 * Create the full PostgreSQL infrastructure bundle for the core app.
 * Opens pg connection, runs migrations, returns Infrastructure with all adapters.
 */
export async function createPostgresInfrastructure(
  config: ServerConfig,
  options: { runMigrations?: boolean; migrationsDir?: string } = {},
): Promise<Infrastructure> {
  if (!config.DATABASE_URL?.match(/^postgres(ql)?:\/\//)) {
    throw new Error('PostgreSQL requires a postgres:// or postgresql:// DATABASE_URL');
  }
  const client = postgres(config.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  const runMigrations = options.runMigrations ?? true;
  const migrationsDir = options.migrationsDir ?? join(process.cwd(), 'migrations/postgres');
  if (runMigrations) {
    try {
      await applyPostgresMigrations(client, migrationsDir);
    } catch (error) {
      await client.end();
      throw error;
    }
  }
  const db = drizzle(client, { schema });

  // Create repositories
  const repositories = {
    workspaces: new PostgresWorkspaceRepository(db),
    projects: new PostgresProjectRepository(db),
    projectFiles: new PostgresProjectFileRepository(db),
    boards: new PostgresBoardRepository(db),
    cards: new PostgresCardRepository(db),
    notepads: new PostgresNotepadRepository(db),
    tags: new PostgresTagRepository(db),
    notifications: new PostgresNotificationRepository(db),
    members: new PostgresMemberRepository(db),
    invites: new PostgresInviteRepository(db),
  };

  // Create storage adapter (local for now, can be extended to S3)
  const storage = createStorageFromEnv(config);

  // Create search adapter
  const search = new PostgresSearchAdapter(db);

  // Create lock adapter
  const locks = new PostgresLockAdapter(db);

  // Create email adapter
  const email = createEmailFromEnv({
    RESEND_API_KEY: config.RESEND_API_KEY,
    EMAIL_FROM: config.EMAIL_FROM,
  });

  // Create auth provider
  const authSecret =
    config.BETTER_AUTH_SECRET ||
    (process.env.NODE_ENV === 'production' ? '' : 'local-dev-secret-change-me');
  if (process.env.NODE_ENV === 'production' && !authSecret) {
    throw new Error('BETTER_AUTH_SECRET must be set in production');
  }

  const auth = createPostgresAuthProvider(
    db,
    authSecret,
    config.BETTER_AUTH_URL ?? 'http://localhost:3005',
  );

  return {
    repositories,
    storage,
    search,
    locks,
    auth,
    email,
    bootstrapToken: config.BOOTSTRAP_TOKEN,
    appUrl: config.BETTER_AUTH_URL,
  };
}

/**
 * Apply PostgreSQL migrations atomically with their ledger. The transaction lock
 * serializes concurrent startup; SQLite migrations are never read here.
 */
export async function applyPostgresMigrations(
  client: ReturnType<typeof postgres>,
  migrationsDir = join(process.cwd(), 'migrations/postgres'),
): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  await client.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('burrow:migrations'))`;
    await tx`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`;
    const applied = new Set(
      (await tx<{ filename: string }[]>`SELECT filename FROM _migrations`).map(
        (row) => row.filename,
      ),
    );
    for (const file of files) {
      if (applied.has(file)) continue;
      await tx.unsafe(readFileSync(join(migrationsDir, file), 'utf8'));
      await tx`INSERT INTO _migrations (filename, applied_at) VALUES (${file}, ${Date.now()})`;
    }
  });
}
