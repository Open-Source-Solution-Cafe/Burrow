import { expect, it } from 'vitest';
import type { IWorkspaceRepository } from '../../src/core/infrastructure/types';
import { createWorkspacePlan } from '../../src/core/entities/workspace';

interface Fixture {
  workspaces: IWorkspaceRepository;
  query(text: string, params?: Array<string | number | null>): Promise<Record<string, unknown>[]>;
  createUser(id: string, email: string, now: number): Promise<void>;
}

export function bootstrapCases(fixture: () => Fixture) {
  it('claims once, rolls failures back and completes exactly one starter graph with authenticated retry', async () => {
    const { workspaces, query, createUser } = fixture();
    const userId = crypto.randomUUID(),
      otherId = crypto.randomUUID(),
      now = Date.now();
    const email = `${userId}@example.com`;
    await createUser(userId, email, now);
    await createUser(otherId, email.toUpperCase(), now);
    expect(await workspaces.claimBootstrap(email)).toBe(true);
    const claims = await Promise.all([
      workspaces.claimBootstrap(email),
      workspaces.claimBootstrap('other@example.com'),
    ]);
    expect(claims).toEqual([true, false]);
    expect(await workspaces.claimBootstrap(`  ${email.toUpperCase()} `)).toBe(true);
    const plan = () =>
      createWorkspacePlan({
        userId,
        name: 'First',
        workspaceId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        notepadId: crypto.randomUUID(),
        now,
      });
    const broken = plan();
    broken.notepad.projectId = crypto.randomUUID();
    await expect(workspaces.completeBootstrap(email, broken)).rejects.toThrow();
    expect(await query('SELECT id FROM workspaces')).toEqual([]);
    expect(await query('SELECT status FROM bootstrap_state WHERE id = 1')).toEqual([
      { status: 'claimed' },
    ]);
    const foreign = plan();
    foreign.owner.userId = otherId;
    expect(await workspaces.completeBootstrap('other@example.com', foreign)).toBeNull();
    const first = plan(),
      second = plan();
    const completed = await Promise.all([
      workspaces.completeBootstrap(email, first),
      workspaces.completeBootstrap(email, second),
    ]);
    expect(completed[0]).not.toBeNull();
    expect(completed[1]).toEqual(completed[0]);
    expect(await query('SELECT id FROM workspaces')).toHaveLength(1);
    expect(await query('SELECT user_id FROM members')).toEqual([{ user_id: userId }]);
    expect(await query('SELECT id FROM projects')).toHaveLength(1);
    expect(await query('SELECT id FROM notepads')).toHaveLength(1);
    expect(await workspaces.completeBootstrap(email, foreign)).toBeNull();
    expect(await workspaces.claimBootstrap(email)).toBe(false);
  });
}
