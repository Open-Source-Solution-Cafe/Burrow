import { expect } from 'vitest';
import type { IBoardRepository, ICardRepository } from '../../src/core/infrastructure/types';

type Query = (
  text: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

export async function assertAssigneeScope(
  repos: { boards: IBoardRepository; cards: ICardRepository },
  query: Query,
  dialect: 'sqlite' | 'postgres',
) {
  const id = () => crypto.randomUUID();
  const workspace = id(),
    foreignWorkspace = id(),
    project = id(),
    board = id(),
    column = id(),
    card = id(),
    note = id();
  const local = id(),
    foreign = id(),
    noMembership = id(),
    now = Date.now();
  const scope = { workspaceId: workspace, projectId: project };
  const userColumns =
    dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const time = dialect === 'postgres' ? new Date(now).toISOString() : now;
  for (const [userId, name] of [
    [local, 'Local member'],
    [foreign, 'Foreign member'],
    [noMembership, 'No membership'],
  ]) {
    await query(`INSERT INTO "user" (id, name, email, ${userColumns}) VALUES (?, ?, ?, ?, ?)`, [
      userId!,
      name!,
      `${userId}@scope.test`,
      time,
      time,
    ]);
  }
  for (const ws of [workspace, foreignWorkspace])
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      ws,
      'Workspace',
      local,
      now,
    ]);
  for (const [ws, userId] of [
    [workspace, local],
    [foreignWorkspace, foreign],
  ])
    await query(
      "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
      [ws!, userId!, now],
    );
  await query(
    "INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
    [project, workspace, now, now],
  );
  await query(
    "INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 'Board', 'a0', ?, ?)",
    [board, workspace, project, now, now],
  );
  await query(
    "INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Todo', 'a0')",
    [column, board],
  );
  await query(
    "INSERT INTO notepads (id, workspace_id, project_id, kind, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'card', 'Card', 'a0', ?, ?, ?)",
    [note, workspace, project, local, now, now],
  );
  await query(
    "INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, 'a0', ?)",
    [card, board, column, note, now],
  );
  await query('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', [card, local]);
  for (const userId of [foreign, noMembership]) {
    await expect(
      query('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', [card, userId]),
    ).rejects.toThrow('scope_write_conflict');
  }
  const assignees = async () => {
    const detail = await repos.cards.getCardWithDetails(scope, card);
    const boardDetail = await repos.boards.getBoardWithDetails(scope, board);
    return [
      detail!.assignees,
      boardDetail!.columns.flatMap((c) => c.cards).find((c) => c.id === card)!.assignees,
    ];
  };
  for (const values of await assignees()) expect(values.map((a) => a.userId)).toEqual([local]);
  await query(
    'INSERT INTO edit_locks (notepad_id, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)',
    [note, foreign, 'foreign-client', now + 60_000],
  );
  expect((await repos.cards.getCardWithDetails(scope, card))?.lock).toMatchObject({
    name: 'Someone',
    expiresAt: now + 60_000,
  });
  expect((await repos.cards.getCardWithDetails(scope, card))?.lock?.userId).toBeUndefined();
  expect((await repos.cards.getCardWithDetails(scope, card))?.lock?.clientId).toBeUndefined();
  await query('UPDATE edit_locks SET user_id = ?, client_id = ? WHERE notepad_id = ?', [
    local,
    'local-client',
    note,
  ]);
  expect((await repos.cards.getCardWithDetails(scope, card))?.lock).toMatchObject({
    userId: local,
    clientId: 'local-client',
    name: 'Local member',
    expiresAt: now + 60_000,
  });
  await query('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', [workspace, local]);
  for (const values of await assignees()) expect(values).toEqual([]);
  expect((await repos.cards.getCardWithDetails(scope, card))?.lock?.userId).toBeUndefined();
}
