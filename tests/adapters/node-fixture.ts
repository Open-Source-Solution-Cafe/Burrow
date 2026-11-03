import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { openNodeDb } from '../../src/server/db';
import { createDb, wrapNodeDb, type DB } from '../../src/core/adapters/db/d1/client';
import { createCardRepository } from '../../src/core/adapters/db/d1/repositories/card';
import { createBoardRepository } from '../../src/core/adapters/db/d1/repositories/board';
import { createNotepadRepository } from '../../src/core/adapters/db/d1/repositories/notepad';
import { createTagRepository } from '../../src/core/adapters/db/d1/repositories/tag';
import { createNotificationRepository } from '../../src/core/adapters/db/d1/repositories/notification';
import { createMemberRepository } from '../../src/core/adapters/db/d1/repositories/member';
import { createWorkspaceRepository } from '../../src/core/adapters/db/d1/repositories/workspace';
import { createInviteRepository } from '../../src/core/adapters/db/d1/repositories/invite';
import { createProjectRepository } from '../../src/core/adapters/db/d1/repositories/project';
import { createProjectFileRepository } from '../../src/core/adapters/db/d1/repositories/project-file';
import { SqliteFtsSearchAdapter } from '../../src/core/adapters/db/d1/adapters/search/sqlite-fts';
import { PostgresCardRepository } from '../../src/core/adapters/db/postgres/repositories/card';
import { PostgresBoardRepository } from '../../src/core/adapters/db/postgres/repositories/board';
import { PostgresNotepadRepository } from '../../src/core/adapters/db/postgres/repositories/notepad';
import { PostgresTagRepository } from '../../src/core/adapters/db/postgres/repositories/tag';
import { PostgresNotificationRepository } from '../../src/core/adapters/db/postgres/repositories/notification';
import { PostgresMemberRepository } from '../../src/core/adapters/db/postgres/repositories/member';
import { PostgresWorkspaceRepository } from '../../src/core/adapters/db/postgres/repositories/workspace';
import { PostgresInviteRepository } from '../../src/core/adapters/db/postgres/repositories/invite';
import { PostgresProjectRepository } from '../../src/core/adapters/db/postgres/repositories/project';
import { PostgresProjectFileRepository } from '../../src/core/adapters/db/postgres/repositories/project-file';
import { PostgresSearchAdapter } from '../../src/core/adapters/db/postgres/search';
import { PostgresLockAdapter } from '../../src/core/adapters/db/postgres/lock';
import { SqlLockAdapter } from '../../src/core/adapters/db/d1/adapters/lock/sql-lock';
import type { ILockAdapter } from '../../src/core/adapters/lock';
import { applyPostgresMigrations } from '../../src/core/adapters/db/postgres';
import { schema } from '../../src/core/adapters/db/postgres/schema';
import type {
  ICardRepository,
  IBoardRepository,
  INotepadRepository,
  ITagRepository,
  INotificationRepository,
  IMemberRepository,
  IWorkspaceRepository,
  IInviteRepository,
  IProjectRepository,
  IProjectFileRepository,
} from '../../src/core/infrastructure/types';
import type { ISearchAdapter } from '../../src/core/adapters/search';

export interface PersistenceFixture {
  cards: ICardRepository;
  boards: IBoardRepository;
  notepads: INotepadRepository;
  tags: ITagRepository;
  notifications: INotificationRepository;
  createMembers(): IMemberRepository;
  search: ISearchAdapter;
  locks: ILockAdapter;
  workspaces: IWorkspaceRepository;
  invites: IInviteRepository;
  projects: IProjectRepository;
  projectFiles: IProjectFileRepository;
  query(text: string, params?: Array<string | number | null>): Promise<Record<string, unknown>[]>;
  rejectLockInsert(notepadId: string): Promise<void>;
  close(): Promise<void>;
}

export async function openPersistence(
  kind: 'sqlite' | 'postgres',
  url: string,
): Promise<PersistenceFixture> {
  if (kind === 'sqlite') {
    const { sqlite, db: node } = openNodeDb(':memory:', path.resolve('migrations'));
    // Production uses the same lazy SQLite query-builder surface behind the D1 repositories.
    const db = createDb(wrapNodeDb(node)) as unknown as DB;
    return {
      cards: createCardRepository(db),
      boards: createBoardRepository(db),
      notepads: createNotepadRepository(db),
      tags: createTagRepository(db),
      notifications: createNotificationRepository(db),
      createMembers: () => createMemberRepository(db),
      search: new SqliteFtsSearchAdapter(db),
      locks: new SqlLockAdapter(db),
      workspaces: createWorkspaceRepository(db),
      invites: createInviteRepository(db),
      projects: createProjectRepository(db),
      projectFiles: createProjectFileRepository(db),
      async query(text, params = []) {
        const statement = sqlite.prepare(text);
        if (statement.reader) return statement.all(...params) as Record<string, unknown>[];
        statement.run(...params);
        return [];
      },
      async rejectLockInsert(id) {
        sqlite.exec(`CREATE TRIGGER reject_save BEFORE INSERT ON edit_locks
          WHEN NEW.notepad_id = '${id}'
            AND EXISTS (SELECT 1 FROM notepads WHERE id = NEW.notepad_id AND version = 2)
            AND EXISTS (SELECT 1 FROM notifications WHERE notepad_id = NEW.notepad_id)
          BEGIN SELECT RAISE(ABORT, 'forced_save_failure'); END`);
      },
      async close() {
        sqlite.close();
      },
    };
  }
  const client = postgres(url, { max: 4, onnotice: () => {} });
  try {
    await applyPostgresMigrations(client);
    const db = drizzle(client, { schema });
    return {
      cards: new PostgresCardRepository(db),
      boards: new PostgresBoardRepository(db),
      notepads: new PostgresNotepadRepository(db),
      tags: new PostgresTagRepository(db),
      notifications: new PostgresNotificationRepository(db),
      createMembers: () => new PostgresMemberRepository(db),
      search: new PostgresSearchAdapter(db),
      locks: new PostgresLockAdapter(db),
      workspaces: new PostgresWorkspaceRepository(db),
      invites: new PostgresInviteRepository(db),
      projects: new PostgresProjectRepository(db),
      projectFiles: new PostgresProjectFileRepository(db),
      async query(text, params = []) {
        let index = 0;
        return Array.from(
          await client.unsafe(
            text.replace(/\?/g, () => `$${++index}`),
            params,
          ),
        );
      },
      async rejectLockInsert(id) {
        const name = `reject_${id.replaceAll('-', '')}`;
        await client.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.notepad_id = '${id}'
              AND EXISTS (SELECT 1 FROM notepads WHERE id = NEW.notepad_id AND version = 2)
              AND EXISTS (SELECT 1 FROM notifications WHERE notepad_id = NEW.notepad_id)
            THEN RAISE EXCEPTION 'forced_save_failure'; END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER ${name} BEFORE INSERT ON edit_locks FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      },
      close: () => client.end(),
    };
  } catch (error) {
    await client.end();
    throw error;
  }
}
