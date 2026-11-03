import { expect, it } from 'vitest';
import type { ISearchAdapter } from '../../src/core/adapters/search';
import type { IWorkspaceRepository } from '../../src/core/infrastructure/types';
import { createWorkspacePlan } from '../../src/core/entities/workspace';

interface Fixture {
  workspaces: IWorkspaceRepository;
  search: ISearchAdapter;
  query(text: string, params?: Array<string | number | null>): Promise<Record<string, unknown>[]>;
  indexCount(notepadId: string): Promise<number>;
  createUser(id: string, email: string, now: number): Promise<void>;
}
const plan = () =>
  createWorkspacePlan({
    userId: crypto.randomUUID(),
    name: 'Provision contract',
    workspaceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    notepadId: crypto.randomUUID(),
    now: Date.now(),
  });

/** Identical atomic provisioning assertions for D1, Node/SQLite and PostgreSQL. */
export function workspaceProvisioningCases(fixture: () => Fixture) {
  it('commits matching workspace, owner, starter project, welcome note and index', async () => {
    const { workspaces, query, search, indexCount, createUser } = fixture();
    const input = plan();
    const email = `${input.owner.userId}@example.com`;
    await createUser(input.owner.userId, email, input.owner.joinedAt);
    expect(await workspaces.claimBootstrap(email)).toBe(true);
    const failed = { ...input, notepad: { ...input.notepad, projectId: crypto.randomUUID() } };
    await expect(workspaces.completeBootstrap(email, failed)).rejects.toThrow();
    expect(await workspaces.findById(input.workspace.id)).toBeNull();
    for (const table of ['members', 'projects', 'notepads']) {
      expect(
        await query(`SELECT workspace_id FROM ${table} WHERE workspace_id = ?`, [
          input.workspace.id,
        ]),
      ).toEqual([]);
    }
    expect(await indexCount(input.notepad.id)).toBe(0);
    expect(await workspaces.completeBootstrap(email, input)).toEqual(input.workspace);
    expect(await workspaces.completeBootstrap(email, input)).toEqual(input.workspace);
    expect(await workspaces.findById(input.workspace.id)).toEqual(input.workspace);
    expect(
      await query('SELECT workspace_id, user_id, role FROM members WHERE workspace_id = ?', [
        input.workspace.id,
      ]),
    ).toEqual([{ workspace_id: input.workspace.id, user_id: input.owner.userId, role: 'owner' }]);
    expect(
      await query('SELECT workspace_id, name, icon, color, position FROM projects WHERE id = ?', [
        input.project.id,
      ]),
    ).toEqual([
      {
        workspace_id: input.workspace.id,
        name: 'My first project',
        icon: null,
        color: null,
        position: 'a0',
      },
    ]);
    expect(
      await query(
        'SELECT workspace_id, project_id, parent_id, kind, title, content, version, position, created_by FROM notepads WHERE id = ?',
        [input.notepad.id],
      ),
    ).toEqual([
      {
        workspace_id: input.workspace.id,
        project_id: input.project.id,
        parent_id: null,
        kind: 'notepad',
        title: 'Welcome to Burrow',
        content: '[]',
        version: 1,
        position: 'a0',
        created_by: input.owner.userId,
      },
    ]);
    expect(
      (
        await search.search({
          workspaceId: input.workspace.id,
          projectId: input.project.id,
          text: 'Burrow',
        })
      ).map((hit) => hit.id),
    ).toEqual([input.notepad.id]);
    expect(await indexCount(input.notepad.id)).toBe(1);
  });

  it('creates another workspace atomically and lists it without widening account scope', async () => {
    const { workspaces, query, createUser } = fixture();
    const first = plan();
    const second = plan();
    first.owner.userId = second.owner.userId;
    first.workspace.createdBy = first.owner.userId;
    first.notepad.createdBy = first.owner.userId;
    second.workspace.name = 'Second workspace';
    await createUser(first.owner.userId, `${first.owner.userId}@example.com`, first.owner.joinedAt);

    const broken = { ...second, notepad: { ...second.notepad, projectId: crypto.randomUUID() } };
    await expect(workspaces.create(broken)).rejects.toThrow();
    expect(await workspaces.findById(second.workspace.id)).toBeNull();
    expect(
      await query('SELECT id FROM projects WHERE workspace_id = ?', [second.workspace.id]),
    ).toEqual([]);

    await workspaces.create(first);
    await expect(workspaces.create(first)).resolves.toEqual(first.workspace);
    await workspaces.create(second);
    expect(await workspaces.listByUser(first.owner.userId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.workspace.id, name: first.workspace.name, role: 'owner' }),
        expect.objectContaining({ id: second.workspace.id, name: 'Second workspace', role: 'owner' }),
      ]),
    );
    expect(await workspaces.rename(second.workspace.id, first.owner.userId, 'Renamed')).toBe(true);
    expect(await workspaces.rename(second.workspace.id, crypto.randomUUID(), 'Forbidden')).toBe(false);
    expect((await workspaces.listByUser(first.owner.userId)).find((row) => row.id === second.workspace.id)?.name).toBe('Renamed');
  });
}
