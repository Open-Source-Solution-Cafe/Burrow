import { expect } from 'vitest';
import type { IMemberRepository } from '../../src/core/infrastructure/types';

type Query = (
  text: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

/** Shared live-database membership freshness, isolation and rollback contract. */
export async function assertMemberIsolation(
  createRepository: () => IMemberRepository,
  query: Query,
): Promise<void> {
  const primary = createRepository(),
    secondary = createRepository();
  const workspace = crypto.randomUUID(),
    foreignWorkspace = crypto.randomUUID();
  const target = crypto.randomUUID(),
    peer = crypto.randomUUID(),
    foreignOwner = crypto.randomUUID();
  const now = Date.now();
  for (const u of [target, peer, foreignOwner]) {
    try {
      await query(
        'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        [u, 'Test User', `${u}@test.com`, 0, now, now],
      );
    } catch {
      try {
        await query(
          `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${u}', 'Test User', '${u}@test.com', false, now(), now())`,
        );
      } catch {}
    }
  }
  for (const [id, owner] of [
    [workspace, peer],
    [foreignWorkspace, foreignOwner],
  ] as const) {
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      id,
      'Member contract',
      owner,
      now,
    ]);
    await primary.create({ workspaceId: id, userId: owner, role: 'owner', joinedAt: now });
  }
  await primary.create({ workspaceId: workspace, userId: target, role: 'editor', joinedAt: now });
  expect(await primary.findByUserId(workspace, target)).toMatchObject({ role: 'editor' });
  await secondary.updateRole({
    workspaceId: workspace,
    actorUserId: peer,
    targetUserId: target,
    newRole: 'viewer',
  });
  expect(await primary.findByUserId(workspace, target)).toMatchObject({ role: 'viewer' });
  await query("UPDATE members SET role = 'editor' WHERE workspace_id = ? AND user_id = ?", [
    workspace,
    target,
  ]);
  expect(await primary.findByUserId(workspace, target)).toMatchObject({ role: 'editor' });
  await query('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', [workspace, target]);
  expect(await primary.findByUserId(workspace, target)).toBeNull();
  await query(
    "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
    [workspace, target, now],
  );

  const change = {
    workspaceId: workspace,
    actorUserId: peer,
    targetUserId: peer,
    newRole: 'viewer' as const,
  };
  await expect(primary.updateRole(change)).rejects.toThrow('cannot_demote_last_owner');
  await expect(
    primary.remove({ workspaceId: workspace, actorUserId: peer, targetUserId: peer }),
  ).rejects.toThrow('cannot_remove_last_owner');
  await primary.updateRole({ ...change, newRole: 'owner' });
  for (const actorUserId of [target, foreignOwner, crypto.randomUUID()]) {
    await expect(primary.updateRole({ ...change, actorUserId })).rejects.toThrow('forbidden');
    await expect(
      primary.remove({ workspaceId: workspace, actorUserId, targetUserId: peer }),
    ).rejects.toThrow('forbidden');
  }
  const missing = crypto.randomUUID();
  await expect(primary.updateRole({ ...change, targetUserId: missing })).rejects.toThrow(
    'not_found',
  );
  await expect(
    primary.remove({ workspaceId: workspace, actorUserId: peer, targetUserId: missing }),
  ).rejects.toThrow('not_found');
  for (const role of ['viewer', 'editor'] as const) {
    const userId = crypto.randomUUID();
    try {
      await query(
        'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
        [userId, 'Test User', `${userId}@test.com`, 0, now, now],
      );
    } catch {
      try {
        await query(
          `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${userId}', 'Test User', '${userId}@test.com', false, now(), now())`,
        );
      } catch {}
    }
    await primary.create({ workspaceId: workspace, userId, role, joinedAt: now });
    await primary.remove({ workspaceId: workspace, actorUserId: userId, targetUserId: userId });
    expect(await secondary.findByUserId(workspace, userId)).toBeNull();
  }

  const resources = async (workspaceId: string, owner: string) => {
    const project = crypto.randomUUID(),
      board = crypto.randomUUID(),
      column = crypto.randomUUID();
    const notepad = crypto.randomUUID(),
      card = crypto.randomUUID();
    await query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [project, workspaceId, 'Project', 'a0', now, now],
    );
    await query(
      'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [board, workspaceId, project, 'Board', 'a0', now, now],
    );
    await query('INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)', [
      column,
      board,
      'Todo',
      'a0',
    ]);
    await query(
      "INSERT INTO notepads (id, workspace_id, project_id, kind, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'card', 'Body', 'a0', ?, ?, ?)",
      [notepad, workspaceId, project, owner, now, now],
    );
    await query(
      "INSERT INTO cards (id, board_id, column_id, notepad_id, position, created_at) VALUES (?, ?, ?, ?, 'a0', ?)",
      [card, board, column, notepad, now],
    );
    return { project, notepad, card };
  };
  const local = await resources(workspace, peer),
    foreign = await resources(foreignWorkspace, foreignOwner);
  for (const [card, user] of [
    [local.card, target],
    [local.card, peer],
    [foreign.card, foreignOwner],
  ] as const) {
    await query('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', [card, user]);
  }
  const peerNote = crypto.randomUUID();
  await query(
    "INSERT INTO notepads (id, workspace_id, project_id, title, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Peer note', 'a0', ?, ?, ?)",
    [peerNote, workspace, local.project, peer, now, now],
  );
  for (const [notepad, user] of [
    [local.notepad, target],
    [foreign.notepad, foreignOwner],
    [peerNote, peer],
  ] as const) {
    await query(
      'INSERT INTO edit_locks (notepad_id, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)',
      [notepad, user, 'member-contract', now + 60_000],
    );
  }
  const snapshot = async () => ({
    assignments: await query(
      'SELECT card_id, user_id FROM card_assignees WHERE card_id IN (?, ?) ORDER BY card_id, user_id',
      [local.card, foreign.card],
    ),
    locks: await query(
      'SELECT notepad_id, user_id FROM edit_locks WHERE notepad_id IN (?, ?, ?) ORDER BY notepad_id',
      [local.notepad, foreign.notepad, peerNote],
    ),
    membership: await query(
      'SELECT workspace_id, user_id, role FROM members WHERE workspace_id IN (?, ?) ORDER BY workspace_id, user_id',
      [workspace, foreignWorkspace],
    ),
  });
  const before = await snapshot();
  const guard = `member_guard_${crypto.randomUUID().replaceAll('-', '')}`;
  await query(`CREATE TABLE "${guard}" (workspace_id TEXT, user_id TEXT,
    FOREIGN KEY (workspace_id, user_id) REFERENCES members(workspace_id, user_id) ON DELETE RESTRICT)`);
  try {
    await query(`INSERT INTO "${guard}" (workspace_id, user_id) VALUES (?, ?)`, [
      workspace,
      target,
    ]);
    await expect(
      primary.remove({ workspaceId: workspace, actorUserId: peer, targetUserId: target }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  } finally {
    await query(`DROP TABLE "${guard}"`);
  }
  await primary.remove({ workspaceId: workspace, actorUserId: peer, targetUserId: target });
  expect(await primary.findByUserId(workspace, target)).toBeNull();
  const after = await snapshot();
  expect(after.assignments).toEqual(
    before.assignments.filter((row) => row.card_id !== local.card || row.user_id !== target),
  );
  expect(after.locks).toEqual(before.locks.filter((row) => row.notepad_id !== local.notepad));
  expect(after.membership).toEqual(
    before.membership.filter((row) => row.workspace_id !== workspace || row.user_id !== target),
  );
  expect(
    await query('SELECT id FROM cards WHERE id IN (?, ?)', [local.card, foreign.card]),
  ).toHaveLength(2);
  expect(
    await query('SELECT id FROM notepads WHERE id IN (?, ?, ?)', [
      local.notepad,
      foreign.notepad,
      peerNote,
    ]),
  ).toHaveLength(3);
  await assertOwnerRaces(createRepository, query);
}

async function assertOwnerRaces(createRepository: () => IMemberRepository, query: Query) {
  for (const mode of ['demote', 'remove', 'mixed', 'revoke-other'] as const) {
    const workspaceId = crypto.randomUUID(),
      first = crypto.randomUUID(),
      second = crypto.randomUUID();
    const now = Date.now(),
      a = createRepository(),
      b = createRepository();
    for (const u of [first, second]) {
      try {
        await query(
          'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
          [u, 'Test User', `${u}@test.com`, 0, now, now],
        );
      } catch {
        try {
          await query(
            `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${u}', 'Test User', '${u}@test.com', false, now(), now())`,
          );
        } catch {}
      }
    }
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      workspaceId,
      'Owner race',
      first,
      now,
    ]);
    for (const userId of [first, second]) {
      await a.create({ workspaceId, userId, role: 'owner', joinedAt: now });
    }
    const demote = (
      repository: IMemberRepository,
      actorUserId: string,
      targetUserId = actorUserId,
    ) => repository.updateRole({ workspaceId, actorUserId, targetUserId, newRole: 'viewer' });
    const remove = (repository: IMemberRepository, actorUserId: string) =>
      repository.remove({ workspaceId, actorUserId, targetUserId: actorUserId });
    const results = await Promise.allSettled(
      mode === 'revoke-other'
        ? [demote(a, first, second), demote(b, second, first)]
        : [
            mode === 'remove' ? remove(a, first) : demote(a, first),
            mode === 'demote' ? demote(b, second) : remove(b, second),
          ],
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
      mode,
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
      mode,
    ).toHaveLength(1);
    expect(
      await query("SELECT user_id FROM members WHERE workspace_id = ? AND role = 'owner'", [
        workspaceId,
      ]),
      mode,
    ).toHaveLength(1);
    if (mode === 'revoke-other') {
      const denied = results.find((result) => result.status === 'rejected');
      expect(denied?.status === 'rejected' ? denied.reason : null).toMatchObject({
        message: 'forbidden',
      });
    }
  }
}
