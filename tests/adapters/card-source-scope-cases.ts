import { expect } from 'vitest';
import type { IBoardRepository, ICardRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

export async function assertCardSourceScope(
  repos: { cards: ICardRepository; boards: IBoardRepository },
  query: Query,
  dialect: 'sqlite' | 'postgres',
) {
  const id = () => crypto.randomUUID();
  const user = id(),
    workspace = id(),
    foreignWorkspace = id();
  const project = id(),
    foreignProject = id();
  const now = Date.now();
  const columns = dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const time = dialect === 'postgres' ? new Date(now).toISOString() : now;
  await query(`INSERT INTO "user" (id, name, email, ${columns}) VALUES (?, 'Owner', ?, ?, ?)`, [
    user,
    `${user}@card-scope.test`,
    time,
    time,
  ]);
  for (const ws of [workspace, foreignWorkspace])
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      ws,
      'Workspace',
      user,
      now,
    ]);
  await query(
    "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
    [workspace, user, now],
  );
  await query(
    "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'viewer', ?)",
    [foreignWorkspace, user, now],
  );
  for (const [proj, ws] of [
    [project, workspace],
    [foreignProject, foreignWorkspace],
  ])
    await query(
      "INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
      [proj!, ws!, now, now],
    );

  const board = async (ws: string, proj: string, deletedAt: number | null = null) => {
    const boardId = id(),
      columnId = id();
    await query(
      "INSERT INTO boards (id, workspace_id, project_id, name, position, deleted_at, created_at, updated_at) VALUES (?, ?, ?, 'Board', 'a0', ?, ?, ?)",
      [boardId, ws, proj, deletedAt, now, now],
    );
    await query(
      "INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Todo', 'a0')",
      [columnId, boardId],
    );
    return { boardId, columnId };
  };
  const local = await board(workspace, project);
  const deletedBoard = await board(workspace, project, now);
  const foreign = await board(foreignWorkspace, foreignProject);
  const card = async (
    container: typeof local,
    opts: { ws?: string; proj?: string; column?: string; kind?: string; deleted?: boolean } = {},
  ) => {
    const cardId = id(),
      bodyId = id();
    await query(
      "INSERT INTO notepads (id, workspace_id, project_id, kind, title, position, created_by, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'Scope card', 'a0', ?, ?, ?, ?)",
      [
        bodyId,
        opts.ws ?? workspace,
        opts.proj ?? project,
        opts.kind ?? 'card',
        user,
        opts.deleted ? now : null,
        now,
        now,
      ],
    );
    await query(
      "INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, 'a0', ?)",
      [cardId, container.boardId, opts.column ?? container.columnId, bodyId, now],
    );
    await query('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', [cardId, user]);
    return cardId;
  };
  const valid = await card(local);
  const trash = await card(local, { deleted: true });
  const onDeletedBoard = await card(deletedBoard);
  // Foreign data is valid within its own workspace and must remain invisible to this caller.
  const foreignCard = await card(foreign, { ws: foreignWorkspace, proj: foreignProject });
  const scope = { workspaceId: workspace, projectId: project };
  const foreignScope = { workspaceId: foreignWorkspace, projectId: foreignProject };
  expect((await repos.cards.findByIdInScope(scope, valid))?.id).toBe(valid);
  expect((await repos.cards.findByIdInScope(scope, trash))?.id).toBe(trash);
  expect((await repos.cards.findByIdInScope(scope, onDeletedBoard))?.id).toBe(onDeletedBoard);
  expect(await repos.cards.findByIdInScope(scope, foreignCard)).toBeNull();
  expect((await repos.cards.findByIdInScope(foreignScope, foreignCard))?.id).toBe(foreignCard);
  expect(await repos.cards.getCardWithDetails(foreignScope, valid)).toBeNull();
  expect((await repos.cards.getCardWithDetails(scope, valid))?.id).toBe(valid);
  expect(await repos.cards.getCardWithDetails(scope, trash)).toBeNull();
  expect(await repos.cards.getCardWithDetails(scope, onDeletedBoard)).toBeNull();
  expect((await repos.boards.findByIdInScope(scope, local.boardId))?.id).toBe(local.boardId);
  expect(await repos.boards.findByIdInScope(scope, foreign.boardId)).toBeNull();
  expect((await repos.boards.findColumnByIdInScope(scope, local.columnId))?.id).toBe(local.columnId);
  expect(await repos.boards.findColumnByIdInScope(scope, foreign.columnId)).toBeNull();
  expect((await repos.cards.listByColumn(scope, local.columnId)).map((row) => row.id)).toEqual([valid]);
  expect(await repos.cards.listByColumn(scope, deletedBoard.columnId)).toEqual([]);
  expect(await repos.cards.listByColumn(scope, foreign.columnId)).toEqual([]);
  expect((await repos.boards.listColumns(scope, local.boardId)).map((row) => row.id)).toEqual([
    local.columnId,
  ]);
  expect(await repos.boards.listColumns(scope, foreign.boardId)).toEqual([]);
  expect(await repos.boards.getBoardWithDetails({ workspaceId: foreignWorkspace, projectId: foreignProject }, local.boardId)).toBeNull();

  const bodyId = (await query('SELECT notepad_id AS id FROM cards WHERE id = ?', [valid]))[0]!.id as string;
  const foreignBodyId = (await query('SELECT notepad_id AS id FROM cards WHERE id = ?', [foreignCard]))[0]!.id as string;
  const subtaskId = id();
  await query(
    'INSERT INTO card_subtasks (id, card_id, title, completed, position, created_at) VALUES (?, ?, ?, 0, ?, ?)',
    [subtaskId, valid, 'Local', 'a0', now],
  );
  const commentId = id();
  await query(
    'INSERT INTO card_comments (id, card_id, user_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [commentId, valid, user, 'Local', now, now],
  );
  const foreignCommentId = id();
  await query(
    'INSERT INTO card_comments (id, card_id, user_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [foreignCommentId, foreignCard, user, 'Foreign', now, now],
  );
  expect((await repos.cards.listSubtasks(scope, valid)).map((row) => row.id)).toEqual([subtaskId]);
  expect(await repos.cards.listSubtasks(scope, foreignCard)).toEqual([]);
  expect((await repos.cards.listComments(scope, valid)).map((row) => row.id)).toEqual([commentId]);
  expect(await repos.cards.listComments(scope, foreignCard)).toEqual([]);
  expect((await repos.cards.getComment(scope, commentId, valid))?.id).toBe(commentId);
  expect(await repos.cards.getComment({ workspaceId: foreignWorkspace, projectId: foreignProject }, commentId, valid)).toBeNull();
  expect(await repos.cards.getComment(scope, foreignCommentId, foreignCard)).toBeNull();
  expect((await repos.cards.getComment({ workspaceId: foreignWorkspace, projectId: foreignProject }, foreignCommentId, foreignCard))?.id).toBe(foreignCommentId);
  expect((await repos.cards.listAssignees(scope, valid)).map((row) => row.userId)).toEqual([user]);
  expect(await repos.cards.listAssignees(scope, foreignCard)).toEqual([]);
  expect(await repos.cards.listTagIds(scope, foreignBodyId)).toEqual([]);
  expect(await repos.cards.listTagIds({ workspaceId: foreignWorkspace, projectId: foreignProject }, bodyId)).toEqual([]);
  expect((await repos.cards.findByPattern(scope, 'Scope card', 50)).map((row) => row.id)).toEqual(
    [valid],
  );
  expect(
    await repos.cards.findByPattern(
      { workspaceId: foreignWorkspace, projectId: project },
      'Scope card',
      50,
    ),
  ).toEqual([]);
  expect((await repos.cards.getMyTasks(workspace, user, {})).map((row) => row.id)).toEqual([valid]);
  expect(
    (await repos.boards.getBoardWithDetails(scope, local.boardId))?.columns
      .flatMap((column) => column.cards)
      .map((row) => row.id),
  ).toEqual([valid]);
}
