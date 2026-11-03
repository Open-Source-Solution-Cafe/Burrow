import { expect, it } from 'vitest';
import type { IInviteRepository } from '../../src/core/infrastructure/types';

interface Fixture {
  invites: IInviteRepository;
  query(text: string, params?: Array<string | number | null>): Promise<Record<string, unknown>[]>;
  createUser(id: string, email: string, now: number): Promise<void>;
  rejectMembership(userId: string): Promise<void>;
}

export function inviteAcceptCases(fixture: () => Fixture) {
  it('rolls back invite consumption when the membership insert fails', async () => {
    const { invites, query, createUser, rejectMembership } = fixture();
    const workspaceId = crypto.randomUUID(),
      userId = crypto.randomUUID();
    const email = `${userId}@example.com`,
      now = Date.now(),
      token = crypto.randomUUID();
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      workspaceId,
      'Invite rollback',
      userId,
      now,
    ]);
    await createUser(userId, email, now);
    await invites.create({
      id: crypto.randomUUID(),
      workspaceId,
      email,
      role: 'editor',
      tokenHash: token,
      invitedBy: userId,
      expiresAt: now + 10000,
      createdAt: now,
    });
    await rejectMembership(userId);
    await expect(invites.acceptForUser(token, userId, now)).rejects.toThrow();
    expect((await invites.findByTokenHash(token))?.acceptedAt).toBeNull();
    expect(
      await query('SELECT user_id FROM members WHERE workspace_id = ? AND user_id = ?', [
        workspaceId,
        userId,
      ]),
    ).toEqual([]);
  });

  it('serializes concurrent acceptance of one token', async () => {
    const { invites, query, createUser } = fixture();
    const workspaceId = crypto.randomUUID(),
      userId = crypto.randomUUID();
    const email = `${userId}@example.com`,
      now = Date.now(),
      token = crypto.randomUUID();
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      workspaceId,
      'Invite race',
      userId,
      now,
    ]);
    await createUser(userId, email, now);
    await invites.create({
      id: crypto.randomUUID(),
      workspaceId,
      email,
      role: 'editor',
      tokenHash: token,
      invitedBy: userId,
      expiresAt: now + 10000,
      createdAt: now,
    });
    const results = await Promise.all([
      invites.acceptForUser(token, userId, now),
      invites.acceptForUser(token, userId, now),
    ]);
    expect(results.filter(Boolean)).toEqual([{ workspaceId, role: 'editor' }]);
    expect(
      await query('SELECT role FROM members WHERE workspace_id = ? AND user_id = ?', [
        workspaceId,
        userId,
      ]),
    ).toEqual([{ role: 'editor' }]);
  });

  it('atomically consumes a valid invite, preserves existing roles and rejects unsafe retries', async () => {
    const { invites, query, createUser } = fixture();
    const workspaceId = crypto.randomUUID(),
      otherWorkspace = crypto.randomUUID();
    const userId = crypto.randomUUID(),
      email = `${userId}@example.com`,
      now = Date.now();
    for (const id of [workspaceId, otherWorkspace]) {
      await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
        id,
        'Invite test',
        userId,
        now,
      ]);
    }
    await createUser(userId, email, now);
    const makeInvite = async (workspace: string, address: string, expiresAt: number) => {
      const token = crypto.randomUUID();
      await invites.create({
        id: crypto.randomUUID(),
        workspaceId: workspace,
        email: address,
        role: 'viewer',
        tokenHash: token,
        invitedBy: userId,
        expiresAt,
        createdAt: now,
      });
      return token;
    };
    const expired = await makeInvite(workspaceId, email, now);
    const mismatch = await makeInvite(workspaceId, 'wrong@example.com', now + 10000);
    expect(await invites.acceptForUser(expired, userId, now)).toBeNull();
    expect(await invites.acceptForUser(mismatch, userId, now)).toBeNull();
    const first = await makeInvite(workspaceId, email.toUpperCase(), now + 10000);
    expect(await invites.acceptForUser(first, userId, now)).toEqual({
      workspaceId,
      role: 'viewer',
    });
    expect(await invites.acceptForUser(first, userId, now)).toBeNull();
    await query("UPDATE members SET role = 'owner' WHERE user_id = ? AND workspace_id = ?", [
      userId,
      workspaceId,
    ]);
    const second = await makeInvite(workspaceId, email, now + 10000);
    expect(await invites.acceptForUser(second, userId, now)).toEqual({
      workspaceId,
      role: 'owner',
    });
    const foreign = await makeInvite(otherWorkspace, email, now + 10000);
    expect(await invites.acceptForUser(foreign, userId, now)).toEqual({
      workspaceId: otherWorkspace,
      role: 'viewer',
    });
    expect((await invites.findByTokenHash(foreign))?.acceptedAt).not.toBeNull();
  });
}
