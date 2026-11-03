import { expect } from 'vitest';
import type { INotepadRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

export async function assertNoteSourceScope(
  notepads: INotepadRepository,
  query: Query,
  dialect: 'sqlite' | 'postgres',
) {
  const workspace = crypto.randomUUID();
  const otherWorkspace = crypto.randomUUID();
  const project = crypto.randomUUID();
  const otherProject = crypto.randomUUID();
  const user = crypto.randomUUID();
  const now = Date.now();
  const userTimes = dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const time = dialect === 'postgres' ? new Date(now).toISOString() : now;
  await query(`INSERT INTO "user" (id, name, email, ${userTimes}) VALUES (?, 'Owner', ?, ?, ?)`, [
    user,
    `${user}@scope.test`,
    time,
    time,
  ]);
  for (const id of [workspace, otherWorkspace]) {
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      id,
      'Workspace',
      user,
      now,
    ]);
  }
  for (const [id, ws] of [
    [project, workspace],
    [otherProject, otherWorkspace],
  ]) {
    await query(
      "INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Project', 'a0', ?, ?)",
      [id!, ws!, now, now],
    );
  }
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  const corrupt = crypto.randomUUID();
  const deleted = crypto.randomUUID();
  const corruptDeleted = crypto.randomUUID();
  const deletedCard = crypto.randomUUID();
  const card = crypto.randomUUID();
  const note = async (
    id: string,
    ws: string,
    proj: string,
    kind: string,
    position: string,
    deletedAt: number | null = null,
    parentId: string | null = null,
  ) => {
    await query(
      'INSERT INTO notepads (id, workspace_id, project_id, parent_id, kind, title, position, created_by, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, ws, proj, parentId, kind, id, position, user, now, now, deletedAt],
    );
  };
  await note(second, workspace, project, 'notepad', 'a1');
  await note(first, workspace, project, 'notepad', 'a0');
  await note(corrupt, otherWorkspace, otherProject, 'notepad', 'a2');
  await note(deleted, workspace, project, 'notepad', 'a3', now);
  await note(corruptDeleted, otherWorkspace, otherProject, 'notepad', 'a5', now + 2);
  await note(deletedCard, workspace, project, 'card', 'a6', now + 1);
  await note(card, workspace, project, 'card', 'a4');
  const scope = { workspaceId: workspace, projectId: project };
  expect((await notepads.listByProject(scope)).map((row) => row.id)).toEqual([first, second]);
  expect((await notepads.listDeletedByProject(scope)).map((row) => row.id)).toEqual([
    deletedCard,
    deleted,
  ]);
  expect(await notepads.listByProject({ workspaceId: otherWorkspace, projectId: project })).toEqual([]);
  expect(await notepads.listDeletedByProject({ workspaceId: otherWorkspace, projectId: project })).toEqual([]);
  expect((await notepads.findByPattern(scope, first, 10)).map((row) => row.id)).toEqual([first]);
  expect(await notepads.findByPattern({ workspaceId: otherWorkspace, projectId: project }, first, 10)).toEqual([]);
  await query(
    "INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, 'notepad', ?)",
    [first, second],
  );
  expect(await notepads.listLinks(scope, first)).toEqual([{ targetType: 'notepad', targetId: second }]);
  expect(await notepads.listLinks({ workspaceId: otherWorkspace, projectId: project }, first)).toEqual([]);
  expect(await notepads.getLastRootPosition(scope)).toBeTypeOf('string');
  expect(await notepads.getLastRootPosition({ workspaceId: otherWorkspace, projectId: project })).toBeNull();
  expect(await notepads.getLastRootNotepadPosition({ workspaceId: otherWorkspace, projectId: project })).toBe('a0');
  const child = crypto.randomUUID();
  await note(child, workspace, project, 'notepad', 'a0', null, first);
  expect(await notepads.getLastChildPosition(scope, first)).toBeTypeOf('string');
  expect(await notepads.getLastChildPosition({ workspaceId: otherWorkspace, projectId: project }, first)).toBeNull();
  expect((await notepads.findByIdInScope(scope, first))?.id).toBe(first);
  expect((await notepads.findByIdInScope(scope, deleted))?.id).toBe(deleted);
  expect(await notepads.findByIdInScope(scope, corrupt)).toBeNull();
  expect(await notepads.findByIdInScope({ workspaceId: otherWorkspace, projectId: project }, corrupt)).toBeNull();
  expect((await notepads.findByIdInScope({ workspaceId: otherWorkspace, projectId: otherProject }, corrupt))?.id).toBe(corrupt);
  expect((await notepads.getContent(scope, first))?.id).toBe(first);
  expect(await notepads.getContent(scope, corrupt)).toBeNull();
  expect((await notepads.getContent({ workspaceId: otherWorkspace, projectId: otherProject }, corrupt))?.id).toBe(corrupt);
  expect((await notepads.listByProject({ workspaceId: otherWorkspace, projectId: otherProject })).map((row) => row.id)).toEqual([corrupt]);
  expect((await notepads.listDeletedByProject({ workspaceId: otherWorkspace, projectId: otherProject })).map((row) => row.id)).toEqual([corruptDeleted]);
  await query('INSERT INTO edit_locks (notepad_id, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)', [first, user, 'scope-client', now + 60_000]);
  await query('INSERT INTO edit_locks (notepad_id, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)', [corrupt, user, 'foreign-client', now + 60_000]);
  expect((await notepads.getLock(scope, first))?.clientId).toBe('scope-client');
  expect(await notepads.getLock({ workspaceId: otherWorkspace, projectId: otherProject }, first)).toBeNull();
  expect(await notepads.getLock(scope, corrupt)).toBeNull();
  expect((await notepads.getLock({ workspaceId: otherWorkspace, projectId: otherProject }, corrupt))?.clientId).toBe('foreign-client');
}
