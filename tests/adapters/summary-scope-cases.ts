import { expect } from 'vitest';
import type { ICardRepository } from '../../src/core/infrastructure/types';

type Query = (
  text: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

/** One scope/relationship contract for real D1, Node/SQLite and PostgreSQL. */
export async function assertCardSummaryScope(
  repository: Pick<ICardRepository, 'getCardsSummary'>,
  query: Query,
  dialect: 'sqlite' | 'postgres',
): Promise<void> {
  const id = () => crypto.randomUUID();
  const workspaceId = id(),
    foreignWorkspace = id(),
    projectId = id(),
    otherProject = id(),
    foreignProject = id();
  const userId = id(),
    foreignUser = id(),
    now = Date.now();
  const scope = { workspaceId, projectId };
  for (const [user, name] of [
    [userId, 'Local assignee'],
    [foreignUser, 'Foreign assignee'],
  ] as const) {
    const columns = dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
    const time = dialect === 'postgres' ? new Date(now).toISOString() : now;
    await query(`INSERT INTO "user" (id, name, email, ${columns}) VALUES (?, ?, ?, ?, ?)`, [
      user,
      name,
      `${user}@summary.test`,
      time,
      time,
    ]);
  }
  for (const workspace of [workspaceId, foreignWorkspace]) {
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      workspace,
      'Summary workspace',
      userId,
      now,
    ]);
  }
  for (const [workspace, user] of [
    [workspaceId, userId],
    [foreignWorkspace, foreignUser],
  ] as const) {
    await query(
      "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
      [workspace, user, now],
    );
  }
  for (const [project, workspace] of [
    [projectId, workspaceId],
    [otherProject, workspaceId],
    [foreignProject, foreignWorkspace],
  ] as const) {
    await query(
      "INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
      [project, workspace, now, now],
    );
  }
  const board = async (workspace: string, project: string, deletedAt: number | null = null) => {
    const boardId = id(),
      columnId = id();
    await query(
      "INSERT INTO boards (id, workspace_id, project_id, name, position, deleted_at, created_at, updated_at) VALUES (?, ?, ?, 'Board', 'a0', ?, ?, ?)",
      [boardId, workspace, project, deletedAt, now, now],
    );
    await query(
      "INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Column', 'a0')",
      [columnId, boardId],
    );
    return { workspaceId: workspace, projectId: project, boardId, columnId };
  };
  const local = await board(workspaceId, projectId),
    other = await board(workspaceId, otherProject),
    foreign = await board(foreignWorkspace, foreignProject);
  const card = async (
    container: typeof local,
    overrides: {
      workspaceId?: string;
      projectId?: string;
      columnId?: string;
      kind?: 'notepad' | 'card';
      deletedAt?: number;
    } = {},
  ) => {
    const cardId = id(),
      notepadId = id();
    await query(
      "INSERT INTO notepads (id, workspace_id, project_id, kind, title, position, created_by, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'Local card', 'a0', ?, ?, ?, ?)",
      [
        notepadId,
        overrides.workspaceId ?? container.workspaceId,
        overrides.projectId ?? container.projectId,
        overrides.kind ?? 'card',
        userId,
        overrides.deletedAt ?? null,
        now,
        now,
      ],
    );
    await query(
      "INSERT INTO cards (id, board_id, column_id, notepad_id, position, priority, due_date, created_at) VALUES (?, ?, ?, ?, 'a0', 'high', ?, ?)",
      [
        cardId,
        container.boardId,
        overrides.columnId ?? container.columnId,
        notepadId,
        now + 1_000,
        now,
      ],
    );
    return { cardId, notepadId };
  };
  const first = await card(local),
    otherCard = await card(other),
    foreignCard = await card(foreign);
  const excluded = [otherCard.cardId, foreignCard.cardId];
  excluded.push((await card(local, { deletedAt: now })).cardId);
  for (const overrides of [
    { kind: 'notepad' as const },
    { columnId: other.columnId },
    { projectId: otherProject },
    { workspaceId: foreignWorkspace },
  ]) {
    await expect(card(local, overrides)).rejects.toThrow('scope_write_conflict');
  }
  excluded.push((await card(await board(workspaceId, projectId, now))).cardId);
  const orphanBody = id();
  await query(
    "INSERT INTO notepads (id, workspace_id, project_id, kind, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'card', 'Orphan body', 'a0', ?, ?, ?)",
    [orphanBody, workspaceId, projectId, userId, now, now],
  );
  excluded.push(orphanBody, id());

  // Direct repository calls have no API cap; exercise six D1 summary/assignee chunks.
  const validIds = [first.cardId];
  for (let offset = 0; offset < 509; offset += 10) {
    const rows = Array.from({ length: Math.min(10, 509 - offset) }, () => ({
      cardId: id(),
      notepadId: id(),
    }));
    await query(
      `INSERT INTO notepads (id, workspace_id, project_id, kind, title, position, created_by, created_at, updated_at)
      VALUES ${rows.map(() => "(?, ?, ?, 'card', 'Bulk card', 'a0', ?, ?, ?)").join(', ')}`,
      rows.flatMap((row) => [row.notepadId, workspaceId, projectId, userId, now, now]),
    );
    await query(
      `INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at)
      VALUES ${rows.map(() => "(?, ?, ?, ?, 'a0', ?)").join(', ')}`,
      rows.flatMap((row) => [row.cardId, local.boardId, local.columnId, row.notepadId, now]),
    );
    validIds.push(...rows.map((row) => row.cardId));
  }
  for (const [cardId, user] of [
    [first.cardId, userId],
    [validIds[150]!, userId],
  ] as const) {
    await query('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', [cardId, user]);
  }
  for (const user of [foreignUser, id()]) {
    await expect(
      query('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', [first.cardId, user]),
    ).rejects.toThrow('scope_write_conflict');
  }
  expect(await repository.getCardsSummary(scope, [])).toEqual([]);
  const requested = [...validIds, ...excluded, first.cardId];
  const summaries = await repository.getCardsSummary(scope, requested);
  expect(summaries.map((row) => row.id).sort()).toEqual([...validIds].sort());
  expect(summaries.find((row) => row.id === first.cardId)).toEqual({
    id: first.cardId,
    notepadId: first.notepadId,
    title: 'Local card',
    boardId: local.boardId,
    boardName: 'Board',
    columnId: local.columnId,
    columnName: 'Column',
    priority: 'high',
    dueDate: now + 1_000,
    assignees: [{ userId, name: 'Local assignee', image: null }],
  });
  expect(summaries.find((row) => row.id === validIds[150])?.assignees).toEqual([
    { userId, name: 'Local assignee', image: null },
  ]);
  expect(summaries.find((row) => row.id === validIds[500])?.assignees).toEqual([]);
  expect(
    (await repository.getCardsSummary({ workspaceId, projectId: otherProject }, requested)).map(
      (row) => row.id,
    ),
  ).toEqual([otherCard.cardId]);
  expect(
    (
      await repository.getCardsSummary(
        { workspaceId: foreignWorkspace, projectId: foreignProject },
        requested,
      )
    ).map((row) => row.id),
  ).toEqual([foreignCard.cardId]);
  expect(
    await repository.getCardsSummary({ workspaceId: foreignWorkspace, projectId }, requested),
  ).toEqual([]);
  expect(
    await repository.getCardsSummary({ workspaceId, projectId: foreignProject }, requested),
  ).toEqual([]);
}
