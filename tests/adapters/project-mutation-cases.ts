import { expect } from 'vitest';
import type { IMemberRepository, IProjectRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

export async function assertProjectMutations(
  projects: IProjectRepository,
  members: IMemberRepository,
  query: Query,
  dialect: 'sqlite' | 'postgres',
) {
  const workspaceId = crypto.randomUUID();
  const foreignWorkspace = crypto.randomUUID();
  const owner = crypto.randomUUID();
  const editor = crypto.randomUUID();
  const viewer = crypto.randomUUID();
  const now = Date.now();
  const columns = dialect === 'postgres' ? 'created_at, updated_at' : '"createdAt", "updatedAt"';
  const time = dialect === 'postgres' ? new Date(now).toISOString() : now;
  for (const id of [owner, editor, viewer]) {
    await query(`INSERT INTO "user" (id, name, email, ${columns}) VALUES (?, 'Member', ?, ?, ?)`, [
      id,
      `${id}@projects.test`,
      time,
      time,
    ]);
  }
  for (const id of [workspaceId, foreignWorkspace]) {
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      id,
      'Workspace',
      owner,
      now,
    ]);
  }
  for (const [user, role] of [
    [owner, 'owner'],
    [editor, 'editor'],
    [viewer, 'viewer'],
  ] as const) {
    await query(
      'INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      [workspaceId, user, role, now],
    );
  }
  const input = (id: string, position: string, ws = workspaceId) => ({
    id,
    workspaceId: ws,
    name: id,
    icon: null,
    color: null,
    position,
    createdAt: now,
    updatedAt: now,
  });
  const upper = crypto.randomUUID(),
    lower = crypto.randomUUID(),
    foreign = crypto.randomUUID();
  for (const p of [
    input(upper, 'aZ'),
    input(lower, 'aa'),
    input(foreign, 'a0', foreignWorkspace),
  ]) {
    await query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [p.id, p.workspaceId, p.name, p.position, now, now],
    );
  }
  expect((await projects.listByWorkspace(workspaceId)).map((p) => p.id)).toEqual([upper, lower]);
  const tail = { id: lower, position: 'aa' };
  const first = input(crypto.randomUUID(), 'ab');
  const second = input(crypto.randomUUID(), 'ab');
  expect(await projects.createGuarded(input(crypto.randomUUID(), 'ab'), viewer, tail)).toBe(false);
  const creates = await Promise.all([
    projects.createGuarded(first, editor, tail),
    projects.createGuarded(second, editor, tail),
  ]);
  expect(creates.filter(Boolean)).toHaveLength(1);
  const made = creates[0] ? first : second;
  expect((await projects.findByIdForMember(made.id, editor))?.id).toBe(made.id);
  expect(await projects.findByIdForMember(foreign, editor)).toBeNull();
  expect(await projects.createGuarded(input(crypto.randomUUID(), 'ac'), editor, tail)).toBe(false);
  expect(
    await projects.updateGuarded(workspaceId, editor, foreign, { name: 'Leak', updatedAt: now }),
  ).toBe(false);
  expect(
    await projects.updateGuarded(workspaceId, viewer, made.id, {
      name: 'Forbidden',
      updatedAt: now,
    }),
  ).toBe(false);
  expect(
    await projects.updateGuarded(workspaceId, editor, made.id, { name: 'Updated', updatedAt: now }),
  ).toBe(true);
  expect((await projects.findByIdAndWorkspace(made.id, workspaceId))?.name).toBe('Updated');

  const snapshot = {
    targetPosition: 'ab',
    previous: { id: upper, position: 'aZ' },
    next: { id: lower, position: 'aa' },
  };
  expect(await projects.moveGuarded(workspaceId, editor, made.id, 'aZV', snapshot)).toBe(true);
  expect(await projects.moveGuarded(workspaceId, editor, made.id, 'aZW', snapshot)).toBe(false);
  expect(
    await projects.moveGuarded(workspaceId, editor, made.id, 'aZV', {
      targetPosition: 'aZV',
      previous: { id: upper, position: 'aZ' },
      next: { id: lower, position: 'aZ' },
    }),
  ).toBe(false);
  expect(
    await projects.moveGuarded(foreignWorkspace, editor, made.id, 'a1', {
      targetPosition: 'aZV',
      previous: null,
      next: null,
    }),
  ).toBe(false);
  expect(
    await projects.updateGuarded(workspaceId, editor, made.id, { archivedAt: now, updatedAt: now }),
  ).toBe(true);
  expect((await projects.listByWorkspace(workspaceId)).map((p) => p.id)).not.toContain(made.id);
  expect(
    await projects.updateGuarded(workspaceId, editor, made.id, {
      archivedAt: null,
      updatedAt: now,
    }),
  ).toBe(true);
  expect((await projects.listByWorkspace(workspaceId)).map((p) => p.id)).toContain(made.id);
  const [, racingWrite] = await Promise.all([
    members.updateRole({
      workspaceId,
      actorUserId: owner,
      targetUserId: editor,
      newRole: 'viewer',
    }),
    projects.updateGuarded(workspaceId, editor, made.id, { name: 'Racing write', updatedAt: now }),
  ]);
  expect(
    await projects.updateGuarded(workspaceId, editor, made.id, { name: 'Revoked', updatedAt: now }),
  ).toBe(false);
  expect(
    await projects.moveGuarded(workspaceId, editor, made.id, 'aA', {
      targetPosition: 'aZV',
      previous: null,
      next: { id: upper, position: 'aZ' },
    }),
  ).toBe(false);
  expect((await projects.findByIdAndWorkspace(made.id, workspaceId))?.name).toBe(
    racingWrite ? 'Racing write' : 'Updated',
  );
}
