import { expect } from 'vitest';
import type { IProjectRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

type GuardedDeleteRepository = IProjectRepository & {
  hardDeleteGuarded(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    confirmName: string,
  ): Promise<string[] | null>;
};

interface ProjectFixture {
  workspaceId: string;
  projectId: string;
  notepadIds: string[];
  boardId: string;
  cardId: string;
  tagId: string;
  sourceId: string;
  coverKeys: string[];
  registeredKeys: string[];
}

/** Shared destructive project-delete contract for D1, Node/SQLite and PostgreSQL. */
export async function assertProjectDeleteGuard(
  projectRepository: IProjectRepository,
  query: Query,
  dialect: 'sqlite' | 'postgres',
) {
  const projects = projectRepository as GuardedDeleteRepository;
  const id = () => crypto.randomUUID();
  const ownerId = id();
  const viewerId = id();
  const workspaceId = id();
  const otherWorkspaceId = id();
  const now = Date.now();
  const authTimes = dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const authTime = dialect === 'postgres' ? new Date(now).toISOString() : now;

  for (const userId of [ownerId, viewerId]) {
    await query(
      `INSERT INTO "user" (id, name, email, ${authTimes}) VALUES (?, ?, ?, ?, ?)`,
      [userId, 'Project delete member', `${userId}@project-delete.test`, authTime, authTime],
    );
  }
  for (const id of [workspaceId, otherWorkspaceId]) {
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      id,
      'Project delete workspace',
      ownerId,
      now,
    ]);
  }
  for (const [userId, role] of [
    [ownerId, 'owner'],
    [viewerId, 'viewer'],
  ] as const) {
    await query(
      'INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, userId, role, now],
    );
  }

  const createProject = async (
    ws: string,
    name: string,
  ): Promise<string> => {
    const projectId = id();
    await query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [projectId, ws, name, 'a0', now, now],
    );
    return projectId;
  };

  const createProjectTree = async (ws = workspaceId): Promise<ProjectFixture> => {
    const projectId = await createProject(ws, 'Delete this project');
    const sourceId = id();
    const targetId = id();
    const cardBodyId = id();
    const boardId = id();
    const columnId = id();
    const cardId = id();
    const tagId = id();
    const coverKeys = [`${ws}/${id()}.png`, `${ws}/${id()}.jpg`];
    const registeredKeys = [coverKeys[0]!, `${ws}/${id()}.bin`];
    const notepadIds = [sourceId, targetId, cardBodyId];

    for (const [index, notepadId] of notepadIds.entries()) {
      await query(
        `INSERT INTO notepads
          (id, workspace_id, project_id, parent_id, kind, title, cover_key, content, version,
           position, created_by, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, '[]', 1, ?, ?, ?, ?)`,
        [
          notepadId,
          ws,
          projectId,
          index === 2 ? 'card' : 'notepad',
          `Project child ${index}`,
          index < 2 ? coverKeys[index]! : null,
          `a${index}`,
          ownerId,
          now,
          now,
        ],
      );
    }

    await query(
      'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [boardId, ws, projectId, 'Project board', 'a0', now, now],
    );
    await query(
      'INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)',
      [columnId, boardId, 'To do', 'a0'],
    );
    await query(
      'INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [cardId, boardId, columnId, cardBodyId, 'a0', now],
    );
    await query('INSERT INTO tags (id, project_id, name) VALUES (?, ?, ?)', [
      tagId,
      projectId,
      'Project tag',
    ]);
    await query('INSERT INTO notepad_tags (notepad_id, tag_id) VALUES (?, ?)', [sourceId, tagId]);
    await query('INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, ?, ?)', [
      sourceId,
      'notepad',
      targetId,
    ]);
    for (const storageKey of registeredKeys) {
      await query(
        'INSERT INTO project_files (project_id, storage_key, content_type, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
        [projectId, storageKey, 'application/octet-stream', ownerId, now],
      );
    }

    if (dialect === 'sqlite') {
      for (const notepadId of notepadIds) {
        await query('INSERT INTO notepads_fts (notepad_id, title, body) VALUES (?, ?, ?)', [
          notepadId,
          'Project child',
          'searchable project text',
        ]);
      }
    }

    return {
      workspaceId: ws,
      projectId,
      notepadIds,
      boardId,
      cardId,
      tagId,
      sourceId,
      coverKeys,
      registeredKeys,
    };
  };

  const target = await createProjectTree();
  const sharingProjectId = await createProject(workspaceId, 'Keep shared file registration');
  await query(
    'INSERT INTO project_files (project_id, storage_key, content_type, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    [sharingProjectId, target.registeredKeys[1]!, 'application/octet-stream', ownerId, now],
  );

  const expectTargetRemains = async () => {
    expect(await query('SELECT id FROM projects WHERE id = ?', [target.projectId])).toHaveLength(1);
    expect(await query('SELECT id FROM notepads WHERE id = ?', [target.notepadIds[0]!])).toHaveLength(
      1,
    );
    expect(
      await query('SELECT source_id FROM notepad_links WHERE source_id = ?', [target.sourceId]),
    ).toHaveLength(1);
    expect(
      await query('SELECT notepad_id FROM notepad_tags WHERE notepad_id = ?', [target.sourceId]),
    ).toHaveLength(1);
    expect(await query('SELECT id FROM boards WHERE id = ?', [target.boardId])).toHaveLength(1);
    expect(await query('SELECT id FROM cards WHERE id = ?', [target.cardId])).toHaveLength(1);
    expect(
      await query('SELECT project_id FROM project_files WHERE project_id = ?', [target.projectId]),
    ).toHaveLength(2);
  };

  expect(
    await projects.hardDeleteGuarded(workspaceId, viewerId, target.projectId, 'Delete this project'),
  ).toBeNull();
  await expectTargetRemains();

  expect(
    await projects.hardDeleteGuarded(
      otherWorkspaceId,
      ownerId,
      target.projectId,
      'Delete this project',
    ),
  ).toBeNull();
  await expectTargetRemains();

  expect(
    await projects.hardDeleteGuarded(workspaceId, ownerId, target.projectId, 'Wrong name'),
  ).toBeNull();
  await expectTargetRemains();

  const failureTarget = await createProjectTree();
  const triggerName = `reject_project_link_delete_${id().replaceAll('-', '')}`;
  const triggerFunction = `${triggerName}_fn`;
  if (dialect === 'sqlite') {
    await query(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON notepad_links
      WHEN OLD.source_id = '${failureTarget.sourceId}'
      BEGIN SELECT RAISE(ABORT, 'forced_link_delete'); END`);
  } else {
    await query(`CREATE FUNCTION ${triggerFunction}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.source_id = '${failureTarget.sourceId}' THEN
          RAISE EXCEPTION 'forced_link_delete';
        END IF;
        RETURN OLD;
      END $$`);
    await query(`CREATE TRIGGER ${triggerName} BEFORE DELETE ON notepad_links
      FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`);
  }
  try {
    await expect(
      projects.hardDeleteGuarded(
        workspaceId,
        ownerId,
        failureTarget.projectId,
        'Delete this project',
      ),
    ).rejects.toThrow();
    expect(await query('SELECT id FROM projects WHERE id = ?', [failureTarget.projectId])).toHaveLength(
      1,
    );
    expect(await query('SELECT id FROM notepads WHERE id = ?', [failureTarget.sourceId])).toHaveLength(
      1,
    );
    expect(
      await query('SELECT project_id FROM project_files WHERE project_id = ?', [
        failureTarget.projectId,
      ]),
    ).toHaveLength(2);
    expect(
      await query('SELECT source_id FROM notepad_links WHERE source_id = ?', [failureTarget.sourceId]),
    ).toHaveLength(1);
  } finally {
    if (dialect === 'sqlite') {
      await query(`DROP TRIGGER IF EXISTS ${triggerName}`);
    } else {
      await query(`DROP TRIGGER IF EXISTS ${triggerName} ON notepad_links`);
      await query(`DROP FUNCTION IF EXISTS ${triggerFunction}()`);
    }
  }

  const removedCoverKeys = await projects.hardDeleteGuarded(
    workspaceId,
    ownerId,
    target.projectId,
    'Delete this project',
  );
  expect(removedCoverKeys?.sort()).toEqual(
    Array.from(new Set(target.registeredKeys)).sort(),
  );
  for (const notepadId of target.notepadIds) {
    expect(await query('SELECT id FROM notepads WHERE id = ?', [notepadId])).toHaveLength(0);
  }
  expect(await query('SELECT id FROM boards WHERE id = ?', [target.boardId])).toHaveLength(0);
  expect(await query('SELECT id FROM cards WHERE id = ?', [target.cardId])).toHaveLength(0);
  expect(await query('SELECT id FROM tags WHERE id = ?', [target.tagId])).toHaveLength(0);
  expect(
    await query('SELECT source_id FROM notepad_links WHERE source_id = ?', [target.sourceId]),
  ).toHaveLength(0);
  expect(
    await query('SELECT notepad_id FROM notepad_tags WHERE notepad_id = ?', [target.sourceId]),
  ).toHaveLength(0);
  expect(await query('SELECT id FROM projects WHERE id = ?', [target.projectId])).toHaveLength(0);
  expect(
    await query('SELECT project_id FROM project_files WHERE project_id = ?', [target.projectId]),
  ).toHaveLength(0);
  expect(
    await query('SELECT project_id FROM project_files WHERE project_id = ?', [sharingProjectId]),
  ).toHaveLength(1);
  if (dialect === 'sqlite') {
    for (const notepadId of target.notepadIds) {
      expect(await query('SELECT notepad_id FROM notepads_fts WHERE notepad_id = ?', [notepadId])).toHaveLength(
        0,
      );
    }
  }
}
