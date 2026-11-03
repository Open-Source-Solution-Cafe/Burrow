import { expect } from 'vitest';
import type { IBoardRepository, INotepadRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

type Dialect = 'sqlite' | 'postgres';

async function seedBase(query: Query, dialect: Dialect) {
  const id = () => crypto.randomUUID();
  const owner = id();
  const workspaceId = id();
  const projectId = id();
  const now = Date.now();
  const userTimes = dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const time = dialect === 'postgres' ? new Date(now).toISOString() : now;

  await query(`INSERT INTO "user" (id, name, email, ${userTimes}) VALUES (?, 'Owner', ?, ?, ?)`, [
    owner,
    `${owner}@deletion-operation.test`,
    time,
    time,
  ]);
  await query(
    'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
    [workspaceId, 'Deletion operation', owner, now],
  );
  await query(
    'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [projectId, workspaceId, 'Deletion operation', 'a0', now, now],
  );
  await query('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    [workspaceId, owner, 'owner', now]);

  return { id, owner, workspaceId, projectId, now };
}

async function insertNotepad(
  query: Query,
  args: {
    id: string;
    owner: string;
    workspaceId: string;
    projectId: string;
    now: number;
    parentId?: string | null;
    kind?: 'notepad' | 'card';
  },
) {
  await query(
    'INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, content, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      args.id,
      args.workspaceId,
      args.projectId,
      args.parentId ?? null,
      args.kind ?? 'notepad',
      `Note ${args.id}`,
      '[]',
      'a0',
      args.owner,
      args.now,
      args.now,
    ],
  );
}

async function deletedAt(query: Query, id: string): Promise<number | null> {
  const rows = await query('SELECT deleted_at FROM notepads WHERE id = ?', [id]);
  return rows[0]?.deleted_at === null || rows[0]?.deleted_at === undefined
    ? null
    : Number(rows[0].deleted_at);
}

/** Same-timestamp deletes must retain operation identity on every adapter. */
export async function assertNotepadDeletionOperations(
  notepads: INotepadRepository,
  query: Query,
  dialect: Dialect,
) {
  const base = await seedBase(query, dialect);
  const firstRoot = base.id();
  const firstLiveChild = base.id();
  const independentlyDeletedChild = base.id();
  const secondRoot = base.id();
  await insertNotepad(query, { ...base, id: firstRoot });
  await insertNotepad(query, { ...base, id: firstLiveChild, parentId: firstRoot });
  await insertNotepad(query, {
    ...base,
    id: independentlyDeletedChild,
    parentId: firstRoot,
  });
  await insertNotepad(query, { ...base, id: secondRoot });

  const sameTimestamp = base.now + 10_000;
  const noteScope = { workspaceId: base.workspaceId, projectId: base.projectId, actorUserId: base.owner, minimumRole: 'owner' as const };
  await notepads.softDelete(independentlyDeletedChild, sameTimestamp, noteScope);
  await notepads.softDelete(firstRoot, sameTimestamp, noteScope);
  await notepads.softDelete(secondRoot, sameTimestamp, noteScope);
  await notepads.restore(firstRoot, sameTimestamp, noteScope);

  expect(await deletedAt(query, firstRoot)).toBeNull();
  expect(await deletedAt(query, firstLiveChild)).toBeNull();
  expect(await deletedAt(query, independentlyDeletedChild)).toBe(sameTimestamp);
  expect(await deletedAt(query, secondRoot)).toBe(sameTimestamp);

  const legacyRoot = base.id();
  const legacyPeer = base.id();
  await insertNotepad(query, { ...base, id: legacyRoot });
  await insertNotepad(query, { ...base, id: legacyPeer });
  const legacyTimestamp = base.now + 20_000;
  await notepads.softDelete(legacyRoot, legacyTimestamp, noteScope);
  await notepads.softDelete(legacyPeer, legacyTimestamp, noteScope);
  await query(
    'UPDATE notepads SET deleted_at = ?, deletion_operation_id = NULL WHERE id IN (?, ?)',
    [legacyTimestamp, legacyRoot, legacyPeer],
  );

  await expect(notepads.restore(legacyRoot, legacyTimestamp, noteScope)).rejects.toMatchObject({
    message: 'ambiguous_delete_group',
  });
}

export async function assertBoardDeletionOperations(
  boards: IBoardRepository,
  notepads: INotepadRepository,
  query: Query,
  dialect: Dialect,
) {
  const base = await seedBase(query, dialect);
  const boardId = base.id();
  const columnId = base.id();
  const independentCardBody = base.id();
  const boardCardBody = base.id();
  const independentCardId = base.id();
  const boardCardId = base.id();
  const now = base.now;
  const sameTimestamp = now + 30_000;

  await query(
    'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [boardId, base.workspaceId, base.projectId, 'Board', 'a0', now, now],
  );
  await query(
    'INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)',
    [columnId, boardId, 'To do', 'a0'],
  );
  await insertNotepad(query, {
    ...base,
    id: independentCardBody,
    kind: 'card',
  });
  await insertNotepad(query, { ...base, id: boardCardBody, kind: 'card' });
  await query(
    'INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [independentCardId, boardId, columnId, independentCardBody, 'a0', now],
  );
  await query(
    'INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [boardCardId, boardId, columnId, boardCardBody, 'a1', now],
  );

  const noteScope = { workspaceId: base.workspaceId, projectId: base.projectId, actorUserId: base.owner, minimumRole: 'owner' as const };
  await notepads.softDelete(independentCardBody, sameTimestamp, noteScope);
  const scope = { workspaceId: base.workspaceId, actorUserId: base.owner, minimumRole: 'editor' as const };
  await boards.softDeleteGuarded(boardId, sameTimestamp, scope);
  await boards.restoreGuarded(boardId, scope);

  expect(await deletedAt(query, independentCardBody)).toBe(sameTimestamp);
  expect(await deletedAt(query, boardCardBody)).toBeNull();
}
