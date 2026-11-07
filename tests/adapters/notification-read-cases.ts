import { expect, vi } from 'vitest';
import type { INotificationRepository } from '../../src/core/infrastructure/types';

type Query = (
  text: string,
  params?: Array<string | number | null>,
) => Promise<Record<string, unknown>[]>;

/** The same real-database assertions run on D1, Node/SQLite and PostgreSQL. */
export async function assertNotificationReadIsolation(
  repository: Pick<INotificationRepository, 'markRead' | 'markAllRead'>,
  query: Query,
): Promise<void> {
  const workspace = crypto.randomUUID(),
    foreignWorkspace = crypto.randomUUID();
  const user = crypto.randomUUID(),
    otherUser = crypto.randomUUID();
  const now = Date.now(),
    alreadyReadAt = now - 5_000;
  const rows = {
    selected: { workspace, user, readAt: null },
    unselected: { workspace, user, readAt: null },
    alreadyRead: { workspace, user, readAt: alreadyReadAt },
    foreignWorkspace: { workspace: foreignWorkspace, user, readAt: null },
    foreignUser: { workspace, user: otherUser, readAt: null },
  };
  const ids = Object.fromEntries(Object.keys(rows).map((key) => [key, crypto.randomUUID()]));
  for (const u of [user, otherUser]) {
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
  for (const id of [workspace, foreignWorkspace]) {
    await query('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)', [
      id,
      'Notification contract',
      user,
      now,
    ]);
  }
  for (const [workspaceId, userId] of [
    [workspace, user],
    [foreignWorkspace, user],
    [workspace, otherUser],
  ]) {
    await query(
      "INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)",
      [workspaceId!, userId!, now],
    );
  }
  for (const [key, row] of Object.entries(rows)) {
    await query(
      "INSERT INTO notifications (id, workspace_id, user_id, type, actor_id, read_at, created_at) VALUES (?, ?, ?, 'mention', ?, ?, ?)",
      [ids[key]!, row.workspace, row.user, otherUser, row.readAt, now],
    );
  }
  const snapshot = async () => {
    const persisted = await query(
      `SELECT id, read_at FROM notifications WHERE id IN (${Object.keys(rows)
        .map(() => '?')
        .join(', ')})`,
      Object.values(ids),
    );
    const readAt = new Map(
      persisted.map((row) => [String(row.id), row.read_at === null ? null : Number(row.read_at)]),
    );
    return Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, readAt.get(id)]));
  };
  const initial = Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row.readAt]));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
  try {
    await repository.markRead(user, workspace, []);
    expect(await snapshot()).toEqual(initial);
    const selected = [
      ids.selected!,
      ids.alreadyRead!,
      ids.foreignWorkspace!,
      ids.foreignUser!,
      ...Array.from({ length: 100 }, () => crypto.randomUUID()),
    ];
    await repository.markRead(user, workspace, selected);
    const afterSelected = { ...initial, selected: now + 1_000 };
    expect(await snapshot()).toEqual(afterSelected);
    clock.mockReturnValue(now + 2_000);
    await repository.markRead(user, workspace, selected);
    expect(await snapshot()).toEqual(afterSelected);
    await repository.markAllRead(user, workspace);
    const afterAll = { ...afterSelected, unselected: now + 2_000 };
    expect(await snapshot()).toEqual(afterAll);
    clock.mockReturnValue(now + 3_000);
    await repository.markAllRead(user, workspace);
    expect(await snapshot()).toEqual(afterAll);
  } finally {
    clock.mockRestore();
  }
}
