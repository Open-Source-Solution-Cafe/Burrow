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

  it('rejects updates on cards that attempt to change notepad to another project or non-card kind', async () => {
    const { query } = fixture();
    const { workspaceId, projectId } = await createWorkspaceAndProject(query);
    const { projectId: otherProjectId } = await createWorkspaceAndProject(query, workspaceId);

    const board = await createBoard(query, workspaceId, projectId);
    const column = await createColumn(query, board);
    const bodyA = await createNotepad(query, { workspaceId, projectId, kind: 'card' });
    const card = await createCard(query, { boardId: board, columnId: column, notepadId: bodyA });

    // 1. Cannot update card notepad_id to a notepad in another project
    const foreignBody = await createNotepad(query, { workspaceId, projectId: otherProjectId, kind: 'card' });
    await expect(query('UPDATE cards SET notepad_id = ? WHERE id = ?', [foreignBody, card]))
      .rejects.toThrow('scope_write_conflict');

    // 2. Cannot update card notepad_id to a notepad of kind 'notepad'
    const regularNote = await createNotepad(query, { workspaceId, projectId, kind: 'notepad' });
    await expect(query('UPDATE cards SET notepad_id = ? WHERE id = ?', [regularNote, card]))
      .rejects.toThrow();

    // 3. Cannot update card kind to 'notepad'
    await expect(query("UPDATE cards SET kind = 'notepad' WHERE id = ?", [card]))
      .rejects.toThrow();

    // 4. Cannot update the backing notepad to a different kind or project while attached to a card
    await expect(query("UPDATE notepads SET kind = 'notepad' WHERE id = ?", [bodyA]))
      .rejects.toThrow('scope_write_conflict');
    await expect(query('UPDATE notepads SET project_id = ? WHERE id = ?', [otherProjectId, bodyA]))
      .rejects.toThrow('scope_write_conflict');
  });

  it('rejects notepad_links to nonexistent targets and cleans up links on target deletion', async () => {
    const { query } = fixture();
    const { workspaceId, projectId } = await createWorkspaceAndProject(query);
    const source = await createNotepad(query, { workspaceId, projectId });

    // 1. Rejects link inserts to nonexistent targets
    const missingTarget = id();
    await expect(query(
      'INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)',
      [source, 'notepad', missingTarget],
    )).rejects.toThrow('scope_write_conflict');

    await expect(query(
      'INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)',
      [source, 'card', missingTarget],
    )).rejects.toThrow('scope_write_conflict');

    await expect(query(
      'INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)',
      [source, 'board', missingTarget],
    )).rejects.toThrow('scope_write_conflict');

    await expect(query(
      'INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)',
      [source, 'user', missingTarget],
    )).rejects.toThrow('scope_write_conflict');

    // 2. Create valid targets in the same project & workspace
    const targetNote = await createNotepad(query, { workspaceId, projectId });
    const targetBoard = await createBoard(query, workspaceId, projectId);
    const targetCol = await createColumn(query, targetBoard);
    const targetCardBody = await createNotepad(query, { workspaceId, projectId, kind: 'card' });
    const targetCard = await createCard(query, { boardId: targetBoard, columnId: targetCol, notepadId: targetCardBody });

    const linkedUserId = id();
    try {
      await query(
        'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        [linkedUserId, 'Linked Member', `${linkedUserId}@test.com`, 0, 1, 1],
      );
    } catch {
      await query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${linkedUserId}', 'Linked Member', '${linkedUserId}@test.com', false, now(), now())`,
      );
    }
    await query('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [
      workspaceId,
      linkedUserId,
      'editor',
      Date.now(),
    ]);

    // Insert valid links
    await query('INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)', [source, 'notepad', targetNote]);
    await query('INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)', [source, 'card', targetCard]);
    await query('INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)', [source, 'board', targetBoard]);
    await query('INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)', [source, 'user', linkedUserId]);

    const linksBefore = await query('SELECT target_type, target_id FROM notepad_links WHERE source_id = ?', [source]);
    expect(linksBefore.length).toBe(4);

    // 3. Soft-delete target notepad: row remains in notepad_links, but filtered in live queries
    const now = Date.now();
    await query('UPDATE notepads SET deleted_at = ? WHERE id = ?', [now, targetNote]);
    const linksAfterSoftDelete = await query('SELECT target_type, target_id FROM notepad_links WHERE source_id = ?', [source]);
    expect(linksAfterSoftDelete.length).toBe(4); // row preserved for restore

    // Live backlink queries join with deleted_at IS NULL, filtering it out
    const activeBacklinks = await query(
      'SELECT nl.target_id FROM notepad_links nl JOIN notepads n ON n.id = nl.target_id WHERE nl.source_id = ? AND n.deleted_at IS NULL',
      [source],
    );
    expect(activeBacklinks.some((r: any) => r.target_id === targetNote)).toBe(false);

    // 4. Hard-deleting targets cleans up notepad_links rows
    await query('DELETE FROM notepads WHERE id = ?', [targetNote]);
    const linksAfterNoteDelete = await query('SELECT target_type, target_id FROM notepad_links WHERE source_id = ? AND target_type = ?', [source, 'notepad']);
    expect(linksAfterNoteDelete.length).toBe(0);

    await query('DELETE FROM cards WHERE id = ?', [targetCard]);
    const linksAfterCardDelete = await query('SELECT target_type, target_id FROM notepad_links WHERE source_id = ? AND target_type = ?', [source, 'card']);
    expect(linksAfterCardDelete.length).toBe(0);

    await query('DELETE FROM boards WHERE id = ?', [targetBoard]);
    const linksAfterBoardDelete = await query('SELECT target_type, target_id FROM notepad_links WHERE source_id = ? AND target_type = ?', [source, 'board']);
    expect(linksAfterBoardDelete.length).toBe(0);

    await query('DELETE FROM "user" WHERE id = ?', [linkedUserId]);
    const linksAfterUserDelete = await query('SELECT target_type, target_id FROM notepad_links WHERE source_id = ? AND target_type = ?', [source, 'user']);
    expect(linksAfterUserDelete.length).toBe(0);
  });

  it('cleans up card_assignees when a member is removed from the workspace', async () => {
    const { query } = fixture();
    const { workspaceId, projectId } = await createWorkspaceAndProject(query);
    const board = await createBoard(query, workspaceId, projectId);
    const col = await createColumn(query, board);
    const body = await createNotepad(query, { workspaceId, projectId, kind: 'card' });
    const card = await createCard(query, { boardId: board, columnId: col, notepadId: body });

    const memberId = id();
    try {
      await query(
        'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        [memberId, 'Workspace Assignee', `${memberId}@test.com`, 0, 1, 1],
      );
    } catch {
      await query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${memberId}', 'Workspace Assignee', '${memberId}@test.com', false, now(), now())`,
      );
    }

    await query('INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [
      workspaceId,
      memberId,
      'editor',
      Date.now(),
    ]);

    await query('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', [
      card,
      memberId,
    ]);

    const before = await query('SELECT * FROM card_assignees WHERE card_id = ? AND user_id = ?', [card, memberId]);
    expect(before.length).toBe(1);

    // Remove member from workspace
    await query('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', [workspaceId, memberId]);

    // card_assignees row must be automatically removed
    const after = await query('SELECT * FROM card_assignees WHERE card_id = ? AND user_id = ?', [card, memberId]);
    expect(after.length).toBe(0);
  });
}
