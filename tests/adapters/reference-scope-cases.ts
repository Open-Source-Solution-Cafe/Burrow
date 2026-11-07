import { expect } from 'vitest';
import type {
  INotepadRepository,
  StoredLink,
} from '../../src/core/infrastructure/types';

/** The same reference rules run against D1, Node SQLite and real PostgreSQL. */
export async function assertProjectReferenceIsolation(db: {
  notepads: Pick<
    INotepadRepository,
    'create' | 'filterProjectTargets' | 'listBacklinks' | 'resolveReference'
  >;
  query(text: string, params?: Array<string | number | null>): Promise<unknown>;
}) {
  const uid = () => crypto.randomUUID();
  const now = Date.now();
  const workspaceId = uid(),
    foreignWorkspace = uid();
  const scope = { workspaceId, projectId: uid() };
  const otherProject = { workspaceId, projectId: uid() };
  const otherWorkspace = { workspaceId: foreignWorkspace, projectId: uid() };
  const actor = uid(),
    member = uid(),
    foreignMember = uid();
  for (const u of [actor, member, foreignMember]) {
    try {
      await db.query(
        'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        [u, 'Test User', `${u}@test.com`, 0, now, now],
      );
    } catch {
      try {
        await db.query(
          `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${u}', 'Test User', '${u}@test.com', false, now(), now())`,
        );
      } catch {
        /* ignore if user already exists */
      }
    }
  }
  for (const workspace of [workspaceId, foreignWorkspace]) {
    await db.query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [workspace, 'References', actor, now],
    );
  }
  for (const project of [scope, otherProject, otherWorkspace]) {
    await db.query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [project.projectId, project.workspaceId, 'References', 'a0', now, now],
    );
  }
  for (const [user, workspace] of [
    [actor, workspaceId],
    [actor, foreignWorkspace],
    [member, workspaceId],
    [foreignMember, foreignWorkspace],
  ]) {
    await db.query(
      'INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [workspace!, user!, 'editor', now],
    );
  }
  async function note(project = scope, kind: 'notepad' | 'card' = 'notepad', deleted = false) {
    const id = uid();
    await db.notepads.create({
      id,
      ...project,
      parentId: null,
      kind,
      title: 'Reference note',
      content: '[]',
      version: 1,
      position: 'a0',
      isFavorite: false,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    }, { workspaceId: project.workspaceId, projectId: project.projectId, actorUserId: actor, minimumRole: 'editor' });
    if (deleted) await db.query('UPDATE notepads SET deleted_at = ? WHERE id = ?', [now, id]);
    return id;
  }
  async function board(project = scope, deleted = false) {
    const id = uid(),
      columnId = uid();
    await db.query(
      'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        project.workspaceId,
        project.projectId,
        'Reference board',
        'a0',
        now,
        now,
        deleted ? now : null,
      ],
    );
    await db.query('INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)', [
      columnId,
      id,
      'Todo',
      'a0',
    ]);
    return { id, columnId };
  }
  async function card(
    project = scope,
    options: {
      deletedBody?: boolean;
      deletedBoard?: boolean;
    } = {},
  ) {
    const parent = await board(project, options.deletedBoard);
    const notepadId = await note(project, 'card', options.deletedBody);
    const id = uid();
    await db.query(
      'INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, parent.id, parent.columnId, notepadId, 'a0', now],
    );
    return { id, notepadId, boardId: parent.id };
  }
  const liveNote = await note();
  const foreignProjectNote = await note(otherProject);
  const foreignWorkspaceNote = await note(otherWorkspace);
  const deletedNote = await note(scope, 'notepad', true);
  const liveBoard = await board();
  const deletedBoard = await board(scope, true);
  const foreignProjectBoard = await board(otherProject);
  const foreignWorkspaceBoard = await board(otherWorkspace);
  const liveCard = await card();
  const foreignProjectCard = await card(otherProject);
  const foreignWorkspaceCard = await card(otherWorkspace);
  const deletedCard = await card(scope, { deletedBody: true });
  const hiddenBoardCard = await card(scope, { deletedBoard: true });
  const ref = (targetType: StoredLink['targetType'], targetId: string): StoredLink => ({
    targetType,
    targetId,
  });
  const allowed = [
    ref('user', member),
    ref('notepad', liveNote),
    ref('card', liveCard.id),
    ref('board', liveBoard.id),
  ];
  const rejected = [
    ref('user', foreignMember),
    ref('notepad', foreignProjectNote),
    ref('notepad', foreignWorkspaceNote),
    ref('notepad', deletedNote),
    ref('notepad', liveCard.notepadId),
    ref('board', foreignProjectBoard.id),
    ref('board', foreignWorkspaceBoard.id),
    ref('board', deletedBoard.id),
    ...[
      foreignProjectCard,
      foreignWorkspaceCard,
      deletedCard,
      hiddenBoardCard,
    ].map(({ id }) => ref('card', id)),
    ...(['user', 'notepad', 'card', 'board'] as const).map((type) => ref(type, uid())),
    ref('board', liveNote),
    ref('card', liveNote),
  ];
  expect(
    await db.notepads.filterProjectTargets(scope, [...allowed, ...rejected, ...allowed]),
  ).toEqual(allowed);
  expect(await db.notepads.filterProjectTargets(scope, [])).toEqual([]);

  for (const { targetType: kind, targetId: id } of allowed) {
    if (kind === 'user') continue;
    const preview = await db.notepads.resolveReference(scope, kind, id);
    expect(preview).toEqual({
      kind,
      id,
      ...scope,
      title: kind === 'board' ? 'Reference board' : 'Reference note',
      ...(kind === 'card'
        ? {
            boardId: liveCard.boardId,
            boardName: 'Reference board',
            columnName: 'Todo',
            priority: null,
          }
        : { icon: null }),
    });
    for (const foreignScope of [otherProject, otherWorkspace]) {
      expect(await db.notepads.resolveReference(foreignScope, kind, id)).toBeNull();
    }
  }
  for (const { targetType: kind, targetId: id } of rejected) {
    if (kind !== 'user') expect(await db.notepads.resolveReference(scope, kind, id)).toBeNull();
  }

  // A mismatched requested scope cannot make a valid resource belong elsewhere.
  const inconsistent = { workspaceId: foreignWorkspace, projectId: scope.projectId };
  expect(
    await db.notepads.filterProjectTargets(inconsistent, [
      ref('notepad', liveNote),
      ref('board', liveBoard.id),
    ]),
  ).toEqual([]);

  expect(await db.notepads.resolveReference(inconsistent, 'notepad', liveNote)).toBeNull();
  expect(
    await db.notepads.resolveReference(inconsistent, 'board', liveBoard.id),
  ).toBeNull();

  const manyNotes: StoredLink[] = [];
  for (let i = 0; i < 110; i++) manyNotes.push(ref('notepad', await note()));
  expect(await db.notepads.filterProjectTargets(scope, [...manyNotes, ...rejected])).toEqual(
    manyNotes,
  );

  const source = await note();
  const sources = [
    source,
    liveCard.notepadId,
    deletedNote,
    hiddenBoardCard.notepadId,
  ];
  for (const sourceId of sources) {
    await db.query(
      'INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)',
      [sourceId, 'notepad', liveNote],
    );
  }
  expect((await db.notepads.listBacklinks(scope, liveNote)).map(({ id }) => id).sort()).toEqual(
    [source, liveCard.notepadId].sort(),
  );
  for (const foreignScope of [otherProject, otherWorkspace])
    expect(await db.notepads.listBacklinks(foreignScope, liveNote)).toEqual([]);
  expect(await db.notepads.listBacklinks(scope, uid())).toEqual([]);
  expect(await db.notepads.listBacklinks(scope, liveCard.notepadId)).toEqual([]);
  await db.query('UPDATE notepads SET deleted_at = ? WHERE id = ?', [now, liveNote]);
  expect(await db.notepads.listBacklinks(scope, liveNote)).toEqual([]);
  expect(await db.notepads.filterProjectTargets(scope, [ref('notepad', liveNote)])).toEqual([]);
  expect(await db.notepads.resolveReference(scope, 'notepad', liveNote)).toBeNull();
  await db.query('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', [
    workspaceId,
    member,
  ]);
  expect(await db.notepads.filterProjectTargets(scope, [ref('user', member)])).toEqual([]);
}
