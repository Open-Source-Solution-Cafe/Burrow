import { expect } from 'vitest';
import type {
  IBoardRepository,
  ICardRepository,
  INotepadRepository,
  ITagRepository,
} from '../../src/core/infrastructure/types';

type Query = (
  text: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

export async function assertTagScope(
  repos: { boards: IBoardRepository; cards: ICardRepository; notepads: INotepadRepository; tags: ITagRepository },
  query: Query,
  dialect: 'sqlite' | 'postgres',
) {
  const id = () => crypto.randomUUID();
  const workspace = id(),
    foreignWorkspace = id(),
    project = id(),
    otherProject = id(),
    foreignProject = id();
  const user = id(),
    board = id(),
    column = id(),
    card = id(),
    note = id(),
    emptyCard = id(),
    emptyNote = id();
  const localTag = id(),
    otherTag = id(),
    foreignTag = id(),
    now = Date.now();
  const userColumns =
    dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const time = dialect === 'postgres' ? new Date(now).toISOString() : now;
  await query(`INSERT INTO "user" (id, name, email, ${userColumns}) VALUES (?, 'User', ?, ?, ?)`, [
    user,
    `${user}@tags.test`,
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
    "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
    [workspace, user, now],
  );
  for (const [p, ws] of [
    [project, workspace],
    [otherProject, workspace],
    [foreignProject, foreignWorkspace],
  ])
    await query(
      "INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
      [p!, ws!, now, now],
    );
  await query(
    "INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 'Board', 'a0', ?, ?)",
    [board, workspace, project, now, now],
  );
  await query(
    "INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Todo', 'a0')",
    [column, board],
  );
  for (const [c, n] of [
    [card, note],
    [emptyCard, emptyNote],
  ]) {
    await query(
      "INSERT INTO notepads (id, workspace_id, project_id, kind, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'card', 'Card', 'a0', ?, ?, ?)",
      [n!, workspace, project, user, now, now],
    );
    await query(
      "INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, 'a0', ?)",
      [c!, board, column, n!, now],
    );
    await query('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', [c!, user]);
  }
  for (const [tag, p, name] of [
    [localTag, project, 'Local'],
    [otherTag, otherProject, 'Other'],
    [foreignTag, foreignProject, 'Foreign'],
  ]) {
    await query('INSERT INTO tags (id, project_id, name) VALUES (?, ?, ?)', [tag!, p!, name!]);
  }
  await query('INSERT INTO notepad_tags (notepad_id, tag_id) VALUES (?, ?)', [note, localTag]);
  const scope = { workspaceId: workspace, projectId: project };
  expect((await repos.tags.listByProject(scope)).map((tag) => tag.id)).toEqual([localTag]);
  expect((await repos.tags.findByIdInScope(scope, localTag))?.id).toBe(localTag);
  expect((await repos.tags.findByName(scope, 'Local'))?.id).toBe(localTag);
  expect(await repos.tags.findByName(scope, 'Foreign')).toBeNull();
  expect(await repos.tags.findByName({ workspaceId: workspace, projectId: otherProject }, 'Local')).toBeNull();
  expect(await repos.tags.findByName({ workspaceId: foreignWorkspace, projectId: foreignProject }, 'Foreign')).toMatchObject({ id: foreignTag });
  expect(await repos.tags.validateByProject(scope, [localTag, otherTag, foreignTag])).toEqual([{ id: localTag }]);
  expect(await repos.tags.validateByProject({ workspaceId: foreignWorkspace, projectId: foreignProject }, [localTag, foreignTag])).toEqual([{ id: foreignTag }]);
  expect(await repos.tags.findByIdInScope(scope, otherTag)).toBeNull();
  expect(await repos.tags.findByIdInScope({ workspaceId: foreignWorkspace, projectId: project }, localTag)).toBeNull();
  expect((await repos.tags.findByIdInScope({ workspaceId: foreignWorkspace, projectId: foreignProject }, foreignTag))?.id).toBe(foreignTag);
  expect(await repos.tags.listByProject({ workspaceId: foreignWorkspace, projectId: project })).toEqual([]);
  expect((await repos.tags.listByProject({ workspaceId: workspace, projectId: otherProject })).map((tag) => tag.id)).toEqual([otherTag]);
  expect((await repos.tags.findByPattern(scope, 'Local', 8)).map((tag) => tag.id)).toEqual([localTag]);
  expect(await repos.tags.findByPattern({ workspaceId: foreignWorkspace, projectId: project }, 'Local', 8)).toEqual([]);
  expect(await repos.cards.listTagIds(scope, note)).toEqual([localTag]);
  expect(await repos.cards.listTagIds({ workspaceId: foreignWorkspace, projectId: foreignProject }, note)).toEqual([]);
  expect(await repos.notepads.listTagIds(scope, note)).toEqual([localTag]);
  expect(await repos.notepads.listTagIds({ workspaceId: foreignWorkspace, projectId: foreignProject }, note)).toEqual([]);
  expect((await repos.cards.getCardWithDetails(scope, card))?.tags.map((t) => t.id)).toEqual([
    localTag,
  ]);
  expect((await repos.cards.getCardWithDetails(scope, emptyCard))?.tags).toEqual([]);
  const details = await repos.boards.getBoardWithDetails(scope, board);
  const boardCards = details!.columns.flatMap((c) => c.cards);
  expect(boardCards.find((c) => c.id === card)?.tags.map((t) => t.id)).toEqual([localTag]);
  expect(boardCards.find((c) => c.id === emptyCard)?.tags).toEqual([]);
  const tasks = await repos.cards.getMyTasks(workspace, user, {});
  expect(tasks.find((c) => c.id === card)?.tags.map((t) => t.id)).toEqual([localTag]);
  expect(tasks.find((c) => c.id === emptyCard)?.tags).toEqual([]);
}
