import { expect } from 'vitest';
import type { IProjectFileRepository } from '../../src/core/infrastructure/types';

type Query = (
  sql: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

/** Shared registry contract for D1, Node/SQLite and PostgreSQL. */
export async function assertProjectFileRegistry(
  repository: IProjectFileRepository,
  query: Query,
) {
  const id = () => crypto.randomUUID();
  const ownerId = id();
  const workspaceOne = id();
  const workspaceTwo = id();
  const projectOne = id();
  const projectTwo = id();
  const now = Date.now();

  for (const workspaceId of [workspaceOne, workspaceTwo]) {
    await query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, 'Project file workspace', ownerId, now],
    );
  }
  for (const [workspaceId, projectId] of [
    [workspaceOne, projectOne],
    [workspaceTwo, projectTwo],
  ]) {
    await query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [projectId!, workspaceId!, 'Project file project', 'a0', now, now],
    );
  }

  const sharedKey = `${projectOne}/${id()}.png`;
  const secondKey = `${projectOne}/${id()}.webp`;
  const firstRegistration = {
    projectId: projectOne,
    storageKey: sharedKey,
    contentType: 'image/png',
    createdBy: ownerId,
    createdAt: now,
  };

  expect(await repository.register(firstRegistration)).toBe(true);
  expect(
    await repository.register({ ...firstRegistration, contentType: 'image/jpeg', createdAt: now + 1 }),
  ).toBe(false);
  expect(
    await repository.register({ ...firstRegistration, projectId: projectTwo }),
  ).toBe(true);
  expect(await repository.register({ ...firstRegistration, storageKey: secondKey })).toBe(true);

  expect(await repository.findByProjectAndKey(projectOne, sharedKey)).toEqual(firstRegistration);
  expect(await repository.findByProjectAndKey(projectTwo, sharedKey)).toMatchObject({
    projectId: projectTwo,
    storageKey: sharedKey,
    contentType: 'image/png',
  });
  expect(await repository.findByProjectAndKey(projectTwo, secondKey)).toBeNull();
  expect(await repository.findByProjectAndKey(projectOne, id())).toBeNull();
  expect(await repository.countByStorageKey(sharedKey)).toBe(2);
  expect(await repository.countByStorageKey(id())).toBe(0);
  expect(await repository.listProjectIdsByStorageKey(sharedKey)).toEqual(
    [projectOne, projectTwo].sort(),
  );
  expect(await repository.listProjectIdsByStorageKey(secondKey)).toEqual([projectOne]);
  expect(await repository.listProjectIdsByStorageKey(id())).toEqual([]);
  expect(await repository.listStorageKeysByProject(projectOne)).toEqual([sharedKey, secondKey].sort());
  expect(await repository.listStorageKeysByProject(projectTwo)).toEqual([sharedKey]);
  expect(await repository.listStorageKeysByProject(id())).toEqual([]);
  expect(await repository.listAllStorageKeys()).toEqual([sharedKey, secondKey].sort());
}
