import { expect, it } from 'vitest';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

const id = () => crypto.randomUUID();

async function ensureScopeUser(query: Query) {
  try {
    const existing = await query('SELECT id FROM "user" WHERE id = ?', ['scope-test-user']);
    if (existing.length) return;
  } catch {}
  try {
    await query(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
      ['scope-test-user', 'Scope User', 'scope@test.com', 0, 1, 1],
    );
  } catch {
    try {
      await query(
        "INSERT INTO \"user\" (id, name, email, email_verified, created_at, updated_at) VALUES ('scope-test-user', 'Scope User', 'scope@test.com', false, now(), now())",
      );
    } catch {}
  }
}

async function createWorkspaceAndProject(query: Query, workspaceId = id(), projectId = id()) {
  await ensureScopeUser(query);
  const now = Date.now();
  if (!(await query('SELECT id FROM workspaces WHERE id = ?', [workspaceId])).length) {
    await query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'Structural scope', 'scope-test-user', now],
    );
  }
  await query(
    'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [projectId, workspaceId, 'Structural scope', 'a0', now, now],
  );
  return { workspaceId, projectId };
}

async function createNotepad(
  query: Query,
  args: { id?: string; workspaceId: string; projectId: string; parentId?: string | null; kind?: string },
) {
  await ensureScopeUser(query);
  const noteId = args.id ?? id();
  const now = Date.now();
  await query(
    'INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, content, version, position, is_favorite, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      noteId,
      args.workspaceId,
      args.projectId,
      args.parentId ?? null,
      args.kind ?? 'notepad',
      'Scope note',
      '[]',
      1,
      'a0',
      0,
      'scope-test-user',
      now,
      now,
    ],
  );
  return noteId;
}

async function createBoard(query: Query, workspaceId: string, projectId: string) {
  const boardId = id();
  const now = Date.now();
  await query(
    'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [boardId, workspaceId, projectId, 'Scope board', 'a0', now, now],
  );
  return boardId;
}

async function createColumn(query: Query, boardId: string) {
  const columnId = id();
  await query(
    'INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)',
    [columnId, boardId, 'Scope column', 'a0'],
  );
  return columnId;
}

async function createCard(query: Query, args: { boardId: string; columnId: string; notepadId: string }) {
  const cardId = id();
  await query(
    'INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [cardId, args.boardId, args.columnId, args.notepadId, 'a0', Date.now()],
  );
  return cardId;
}

async function rowCount(query: Query, table: string, idValue: string) {
  const rows = await query(`SELECT id FROM ${table} WHERE id = ?`, [idValue]);
  return rows.length;
}

/** Existing corruption must block parent FK cascades; clean valid cascades still work. */
export function structuralScopeDeleteCases(fixture: () => { query: Query }) {
  it('rejects cross-scope inserts and scope-changing updates', async () => {
    const { query } = fixture();
    const own = await createWorkspaceAndProject(query);
    const other = await createWorkspaceAndProject(query);
    const parent = await createNotepad(query, own);

    await expect(createNotepad(query, {
      workspaceId: other.workspaceId,
      projectId: own.projectId,
    })).rejects.toThrow('scope_write_conflict');
    await expect(createNotepad(query, {
      workspaceId: own.workspaceId,
      projectId: other.projectId,
      parentId: parent,
    })).rejects.toThrow('scope_write_conflict');

    const board = await createBoard(query, own.workspaceId, own.projectId);
    const foreignBoard = await createBoard(query, other.workspaceId, other.projectId);
    await expect(query('UPDATE boards SET workspace_id = ? WHERE id = ?', [other.workspaceId, board]))
      .rejects.toThrow('scope_write_conflict');
    await expect(query('UPDATE projects SET workspace_id = ? WHERE id = ?', [other.workspaceId, own.projectId]))
      .rejects.toThrow('scope_write_conflict');

    const column = await createColumn(query, board);
    const body = await createNotepad(query, { ...own, kind: 'card' });
    await expect(createCard(query, { boardId: board, columnId: column, notepadId: parent }))
      .rejects.toThrow('scope_write_conflict');
    const card = await createCard(query, { boardId: board, columnId: column, notepadId: body });
    const foreignColumn = await createColumn(query, foreignBoard);
    await expect(query('UPDATE cards SET column_id = ? WHERE id = ?', [foreignColumn, card]))
      .rejects.toThrow('scope_write_conflict');

    const tagId = id();
    await query('INSERT INTO tags (id, project_id, name) VALUES (?, ?, ?)', [tagId, other.projectId, 'foreign']);
    await expect(query('INSERT INTO notepad_tags (notepad_id, tag_id) VALUES (?, ?)', [parent, tagId]))
      .rejects.toThrow('scope_write_conflict');
    const ownTagId = id();
    await query('INSERT INTO tags (id, project_id, name) VALUES (?, ?, ?)', [ownTagId, own.projectId, 'own']);
    await query('INSERT INTO notepad_tags (notepad_id, tag_id) VALUES (?, ?)', [parent, ownTagId]);
    await expect(query('UPDATE tags SET project_id = ? WHERE id = ?', [other.projectId, ownTagId]))
      .rejects.toThrow('scope_write_conflict');
  });

  it('allows valid same-project subtree and project cascades', async () => {
    const { query } = fixture();
    const { workspaceId, projectId } = await createWorkspaceAndProject(query);
    const root = await createNotepad(query, { workspaceId, projectId });
    const child = await createNotepad(query, { workspaceId, projectId, parentId: root });

    await query('DELETE FROM notepads WHERE id = ?', [root]);
    expect(await rowCount(query, 'notepads', root)).toBe(0);
    expect(await rowCount(query, 'notepads', child)).toBe(0);

    const boardFixture = await createWorkspaceAndProject(query);
    const emptyBoard = await createBoard(query, boardFixture.workspaceId, boardFixture.projectId);
    const emptyColumn = await createColumn(query, emptyBoard);
    await query('DELETE FROM boards WHERE id = ?', [emptyBoard]);
    expect(await rowCount(query, 'boards', emptyBoard)).toBe(0);
    expect(await rowCount(query, 'board_columns', emptyColumn)).toBe(0);

    const columnFixture = await createWorkspaceAndProject(query);
    const boardWithEmptyColumn = await createBoard(
      query,
      columnFixture.workspaceId,
      columnFixture.projectId,
    );
    const deletableColumn = await createColumn(query, boardWithEmptyColumn);
    await query('DELETE FROM board_columns WHERE id = ?', [deletableColumn]);
    expect(await rowCount(query, 'board_columns', deletableColumn)).toBe(0);
    expect(await rowCount(query, 'boards', boardWithEmptyColumn)).toBe(1);

    const projectFixture = await createWorkspaceAndProject(query);
    const note = await createNotepad(query, projectFixture);
    const board = await createBoard(query, projectFixture.workspaceId, projectFixture.projectId);
    const column = await createColumn(query, board);
    const body = await createNotepad(query, { ...projectFixture, kind: 'card' });
    const card = await createCard(query, { boardId: board, columnId: column, notepadId: body });

    await query('DELETE FROM projects WHERE id = ?', [projectFixture.projectId]);
    const removedRows: Array<[string, string]> = [
      ['projects', projectFixture.projectId],
      ['notepads', note],
      ['notepads', body],
      ['boards', board],
      ['board_columns', column],
      ['cards', card],
    ];
    for (const [table, rowId] of removedRows) {
      expect(await rowCount(query, table, rowId)).toBe(0);
    }
  });

  it('rejects a cross-project or cross-workspace parent edge without deleting either note', async () => {
    const { query } = fixture();
    const { workspaceId, projectId: parentProject } = await createWorkspaceAndProject(query);
    const { projectId: childProject } = await createWorkspaceAndProject(query, workspaceId);
    const parent = await createNotepad(query, { workspaceId, projectId: parentProject });
    await expect(createNotepad(query, {
      workspaceId,
      projectId: childProject,
      parentId: parent,
    })).rejects.toThrow('scope_write_conflict');

    const otherWorkspace = await createWorkspaceAndProject(query);
    const foreignParent = await createNotepad(query, { workspaceId, projectId: parentProject });
    await expect(createNotepad(query, {
      workspaceId: otherWorkspace.workspaceId,
      projectId: otherWorkspace.projectId,
      parentId: foreignParent,
    })).rejects.toThrow('scope_write_conflict');
  });

  it('rejects project deletion when a child board or note disagrees with project workspace', async () => {
    const { query } = fixture();
    const project = await createWorkspaceAndProject(query);
    const foreign = await createWorkspaceAndProject(query);
    await expect(createNotepad(query, {
      workspaceId: foreign.workspaceId,
      projectId: project.projectId,
    })).rejects.toThrow('scope_write_conflict');
    await expect(query(
      'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id(), foreign.workspaceId, project.projectId, 'Foreign board', 'a0', Date.now(), Date.now()],
    )).rejects.toThrow('scope_write_conflict');
  });

  it('rejects board deletion when a card body belongs to another project', async () => {
    const { query } = fixture();
    const { workspaceId, projectId } = await createWorkspaceAndProject(query);
    const { projectId: foreignProject } = await createWorkspaceAndProject(query, workspaceId);
    const board = await createBoard(query, workspaceId, projectId);
    const column = await createColumn(query, board);
    const foreignBody = await createNotepad(query, {
      workspaceId,
      projectId: foreignProject,
      kind: 'card',
    });
    await expect(createCard(query, { boardId: board, columnId: column, notepadId: foreignBody }))
      .rejects.toThrow('scope_write_conflict');
  });

  it('rejects deleting a column that owns a cross-board card reference', async () => {
    const { query } = fixture();
    const { workspaceId, projectId } = await createWorkspaceAndProject(query);
    const boardA = await createBoard(query, workspaceId, projectId);
    const boardB = await createBoard(query, workspaceId, projectId);
    const columnB = await createColumn(query, boardB);
    const body = await createNotepad(query, { workspaceId, projectId, kind: 'card' });
    await expect(createCard(query, { boardId: boardA, columnId: columnB, notepadId: body }))
      .rejects.toThrow('scope_write_conflict');
  });
}
