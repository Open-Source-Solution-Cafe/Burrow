import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { extractPlainText } from '../../src/shared/extract';
import type { CardPlan, SaveContentBatchArgs } from '../../src/core/infrastructure/types';
import { openPersistence, type PersistenceFixture } from './node-fixture';
import { assertNotificationReadIsolation } from './notification-read-cases';
import { assertMemberIsolation } from './member-read-cases';
import { assertTreeScopeIsolation } from './tree-scope-cases';
import { assertProjectReferenceIsolation } from './reference-scope-cases';

const uid = () => randomUUID();
const document = (text: string) =>
  JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text }] }]);

describe.each(['sqlite', 'postgres'] as const)('%s atomic persistence', (kind) => {
  let db: PersistenceFixture;
  let seed: {
    workspaceId: string;
    projectId: string;
    actorId: string;
    memberId: string;
    boardId: string;
    columnId: string;
    tagId: string;
    notepadId: string;
    targetId: string;
    now: number;
  };

  const search = async (text: string) =>
    (
      await db.search.search({ workspaceId: seed.workspaceId, projectId: seed.projectId, text })
    ).map((hit) => hit.id);
  const save = (overrides: Partial<SaveContentBatchArgs> = {}): SaveContentBatchArgs => ({
    row: {
      id: seed.notepadId,
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      title: 'Original',
    },
    scope: { workspaceId: seed.workspaceId, projectId: seed.projectId, actorUserId: seed.actorId, minimumRole: 'editor' },
    content: document('gazelle replacement'),
    baseVersion: 1,
    actorId: seed.actorId,
    validLinks: [
      { targetType: 'user', targetId: seed.actorId },
      { targetType: 'user', targetId: seed.memberId },
      { targetType: 'user', targetId: seed.memberId },
    ],
    previousLinks: [],
    now: seed.now,
    lock: { userId: seed.actorId, clientId: 'original', expiresAt: seed.now + 60_000 },
    ...overrides,
  });
  const state = async () => ({
    note: await db.query(
      'SELECT content, version, deleted_at, updated_at FROM notepads WHERE id = ?',
      [seed.notepadId],
    ),
    links: await db.query(
      'SELECT target_type, target_id FROM notepad_links WHERE source_id = ? ORDER BY target_type, target_id',
      [seed.notepadId],
    ),
    notifications: await db.query(
      'SELECT id, user_id, type FROM notifications WHERE notepad_id = ? ORDER BY id',
      [seed.notepadId],
    ),
    lock: await db.query(
      'SELECT user_id, client_id, expires_at FROM edit_locks WHERE notepad_id = ?',
      [seed.notepadId],
    ),
    originalSearch: await search('quokka'),
    replacementSearch: await search('gazelle'),
  });

  beforeEach(async () => {
    db = await openPersistence(kind, inject('postgresTestUrl'));
    seed = {
      workspaceId: uid(),
      projectId: uid(),
      actorId: uid(),
      memberId: uid(),
      boardId: uid(),
      columnId: uid(),
      tagId: uid(),
      notepadId: uid(),
      targetId: uid(),
      now: Date.now(),
    };
    const s = seed;
    for (const userId of [s.actorId, s.memberId]) {
      try {
        await db.query(
          'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)',
          [userId, 'Test User', `${userId}@test.com`, 0, s.now, s.now],
        );
      } catch {
        try {
          await db.query(
            `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('${userId}', 'Test User', '${userId}@test.com', false, now(), now())`,
          );
        } catch {
          /* ignore if user already exists */
        }
      }
    }
    await db.query(
      'INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)',
      [s.workspaceId, 'Contract workspace', s.actorId, s.now],
    );
    for (const [userId, role] of [
      [s.actorId, 'owner'],
      [s.memberId, 'editor'],
    ]) {
      await db.query(
        'INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        [s.workspaceId, userId!, role!, s.now],
      );
    }
    await db.query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [s.projectId, s.workspaceId, 'Contract project', 'a0', s.now, s.now],
    );
    await db.query(
      'INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [s.boardId, s.workspaceId, s.projectId, 'Board', 'a0', s.now, s.now],
    );
    await db.query('INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)', [
      s.columnId,
      s.boardId,
      'Todo',
      'a0',
    ]);
    await db.query('INSERT INTO tags (id, project_id, name) VALUES (?, ?, ?)', [
      s.tagId,
      s.projectId,
      'contract-tag',
    ]);
    for (const id of [s.notepadId, s.targetId]) {
      const content = document(id === s.notepadId ? 'quokka original' : 'target document');
      await db.notepads.create({
        id,
        workspaceId: s.workspaceId,
        projectId: s.projectId,
        parentId: null,
        kind: 'notepad',
        title: 'Original',
        content,
        version: 1,
        position: 'a0',
        isFavorite: false,
        createdBy: s.actorId,
        createdAt: s.now,
        updatedAt: s.now,
      }, { workspaceId: s.workspaceId, projectId: s.projectId, actorUserId: s.actorId, minimumRole: 'editor' });
      await db.notepads.insertFts(id, 'Original', extractPlainText(content));
    }
    await db.query(
      'INSERT INTO edit_locks (notepad_id, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)',
      [s.notepadId, s.actorId, 'original', s.now + 10_000],
    );
  });
  afterEach(async () => {
    await db?.close();
  });

  it('validates live project-local references and backlinks in bulk', async () => {
    await assertProjectReferenceIsolation(db);
  });

  it('denies a current-version save under another project without changing any state', async () => {
    const projectId = uid();
    await db.query(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [projectId, seed.workspaceId, 'Other project', 'a0', seed.now, seed.now],
    );
    const before = await state();
    await expect(
      db.notepads.saveContentBatch(save({ row: { ...save().row, projectId } })),
    ).rejects.toThrow('version_conflict');
    expect(await state()).toEqual(before);
  });

  it('commits content, search, link replacement, deduplicated mentions and own lock renewal together', async () => {
    const previousLinks = [{ targetType: 'notepad' as const, targetId: seed.targetId }];
    await db.query(
      "INSERT INTO notepad_links (source_id, target_type, target_id) VALUES (?, 'notepad', ?)",
      [seed.notepadId, seed.targetId],
    );
    expect(await db.notepads.saveContentBatch(save({ previousLinks }))).toBe(2);
    expect(await search('gazelle')).toContain(seed.notepadId);
    expect(await search('quokka')).not.toContain(seed.notepadId);
    const readScope = { workspaceId: seed.workspaceId, projectId: seed.projectId };
    expect(await db.notepads.listLinks(readScope, seed.notepadId)).toEqual(
      expect.arrayContaining([
        { targetType: 'user', targetId: seed.actorId },
        { targetType: 'user', targetId: seed.memberId },
      ]),
    );
    expect(await db.notepads.listLinks(readScope, seed.notepadId)).toHaveLength(2);
    expect(
      await db.query('SELECT user_id, type, actor_id FROM notifications WHERE notepad_id = ?', [
        seed.notepadId,
      ]),
    ).toEqual([{ user_id: seed.memberId, type: 'mention', actor_id: seed.actorId }]);
    expect(await db.notepads.getLock(readScope, seed.notepadId)).toMatchObject({
      clientId: 'original',
      expiresAt: seed.now + 60_000,
    });
    expect(
      await db.notepads.saveContentBatch(
        save({ baseVersion: 2, previousLinks: await db.notepads.listLinks(readScope, seed.notepadId) }),
      ),
    ).toBe(3);
    expect(
      await db.query('SELECT id FROM notifications WHERE notepad_id = ?', [seed.notepadId]),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'rejects stale writes without any side effect (same content: %s)',
    async (sameContent) => {
      const winning = save({ validLinks: [] });
      await db.notepads.saveContentBatch(winning);
      const before = await state();
      await expect(
        db.notepads.saveContentBatch(
          save({
            content: sameContent ? winning.content : document('intruder text'),
            lock: { userId: seed.memberId, clientId: 'intruder', expiresAt: seed.now + 90_000 },
          }),
        ),
      ).rejects.toThrow('version_conflict');
      expect(await state()).toEqual(before);
    },
  );

  it('rejects a different workspace and a deleted source without renewing a lock or inserting metadata', async () => {
    const before = await state();
    await expect(
      db.notepads.saveContentBatch(
        save({
          row: {
            id: seed.notepadId,
            workspaceId: uid(),
            projectId: seed.projectId,
            title: 'Original',
          },
        }),
      ),
    ).rejects.toThrow('version_conflict');
    expect(await state()).toEqual(before);
    await db.query('UPDATE notepads SET deleted_at = ? WHERE id = ?', [seed.now, seed.notepadId]);
    const deleted = await state();
    await expect(db.notepads.saveContentBatch(save())).rejects.toThrow('version_conflict');
    expect(await state()).toEqual(deleted);
  });

  it.each(['foreign-user', 'other-client', 'no-client'] as const)(
    'rejects a current-version save under an active %s lock without side effects',
    async (scenario) => {
      const userId = scenario === 'foreign-user' ? seed.memberId : seed.actorId;
      await db.query('UPDATE edit_locks SET user_id = ?, client_id = ? WHERE notepad_id = ?', [
        userId,
        'holder',
        seed.notepadId,
      ]);
      const before = await state();
      await expect(
        db.notepads.saveContentBatch(
          save({
            lock:
              scenario === 'no-client'
                ? undefined
                : {
                    userId: seed.actorId,
                    clientId: scenario === 'foreign-user' ? 'holder' : 'other',
                    expiresAt: seed.now + 60_000,
                  },
          }),
        ),
      ).rejects.toThrow('lock_conflict');
      expect(await state()).toEqual(before);
    },
  );

  it('allows a current-version save after a foreign lock expires', async () => {
    await db.query('UPDATE edit_locks SET user_id = ?, expires_at = ? WHERE notepad_id = ?', [
      seed.memberId,
      seed.now - 1,
      seed.notepadId,
    ]);
    expect(await db.notepads.saveContentBatch(save())).toBe(2);
    expect(await db.notepads.getLock({ workspaceId: seed.workspaceId, projectId: seed.projectId }, seed.notepadId)).toMatchObject({
      userId: seed.actorId,
      clientId: 'original',
    });
  });

  it('serializes lock acquire, renewal and release with saves', async () => {
    await db.locks.release(seed.notepadId, 'original', { userId: seed.actorId });
    expect(await db.locks.acquire(seed.notepadId, seed.memberId, 'rival', 60_000)).toMatchObject({
      acquired: true,
    });
    const before = await state();
    await expect(db.notepads.saveContentBatch(save())).rejects.toThrow('lock_conflict');
    expect(await state()).toEqual(before);
    expect(await db.locks.heartbeat(seed.notepadId, 'rival', 60_000)).toBe(true);
    expect(await db.locks.acquire(seed.notepadId, seed.actorId, 'original', 60_000)).toEqual({
      acquired: false,
      holderUserId: seed.memberId,
      expiresAt: expect.any(Number),
    });
    await db.locks.release(seed.notepadId, 'rival', { userId: seed.memberId });
    expect(await db.notepads.saveContentBatch(save())).toBe(2);
  });

  if (kind === 'postgres') {
    it.each(['acquire', 'heartbeat', 'release', 'save'] as const)(
      '%s waits for the shared notepad serialization row lock',
      async (operation) => {
        if (operation === 'acquire') {
          await db.locks.release(seed.notepadId, 'original', { userId: seed.actorId });
        }
        const pid = (await db.query('SELECT pg_backend_pid() AS pid'))[0]?.pid;
        const observer = postgres(inject('postgresTestUrl'), { max: 2, onnotice: () => {} });
        let unlock!: () => void;
        let ready!: () => void;
        const unlocked = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        const locked = new Promise<void>((resolve) => {
          ready = resolve;
        });
        // KEY SHARE permits a normal non-key UPDATE and child-lock writes, but
        // conflicts with the explicit parent FOR UPDATE used by all four paths.
        const held = observer.begin(async (tx) => {
          await tx`SELECT id FROM notepads WHERE id = ${seed.notepadId} FOR KEY SHARE`;
          ready();
          await unlocked;
        });
        let pending: Promise<unknown> | undefined;
        try {
          await Promise.race([locked, held]);
          const operations = {
            acquire: () => db.locks.acquire(seed.notepadId, seed.actorId, 'original', 60_000),
            heartbeat: () => db.locks.heartbeat(seed.notepadId, 'original', 60_000),
            release: () => db.locks.release(seed.notepadId, 'original', { userId: seed.actorId }),
            save: () => db.notepads.saveContentBatch(save()),
          };
          pending = operations[operation]();
          await expect
            .poll(
              async () => {
                const [activity] =
                  await observer`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${Number(pid)}`;
                return activity?.wait_event_type;
              },
              { timeout: 3000, interval: 10 },
            )
            .toBe('Lock');
        } finally {
          unlock();
          try {
            await held;
            await pending;
          } finally {
            await observer.end();
          }
        }
      },
    );
  }

  it('rolls content, search, references and notifications back when the final lock write fails', async () => {
    const before = await state();
    await db.rejectLockInsert(seed.notepadId);
    const error: unknown = await db.notepads
      .saveContentBatch(save())
      .catch((error: unknown) => error);
    const messages: string[] = [];
    for (let cause = error; cause instanceof Error; cause = cause.cause)
      messages.push(cause.message);
    expect(messages.join('\n')).toContain('forced_save_failure');
    expect(await state()).toEqual(before);
  });

  const plan = (mode: 'new' | 'existing'): CardPlan => {
    const linkedId = mode === 'existing' ? seed.targetId : uid();
    const content = JSON.stringify([
      { type: 'notepadLink', props: { notepadId: linkedId }, content: [] },
    ]);
    return {
      ...seed,
      cardId: uid(),
      notepadId: uid(),
      title: 'Gazelle card',
      content,
      plainText: extractPlainText(content),
      priority: 'high',
      dueDate: seed.now + 86_400_000,
      assigneeIds: [seed.memberId],
      tagIds: [seed.tagId],
      assignmentNotifications: [{ id: uid(), userId: seed.memberId }],
      cardPosition: 'a0',
      linkedNotepad: { id: linkedId, title: 'Linked', position: 'a1', mode },
    };
  };
  it.each(['existing', 'new'] as const)(
    'creates a card with a %s linked notepad, assignee, tag and notification atomically',
    async (mode) => {
      const input = plan(mode);
      await db.cards.createFromPlan(input);
      expect(
        await db.query('SELECT board_id, column_id, notepad_id FROM cards WHERE id = ?', [
          input.cardId,
        ]),
      ).toEqual([
        { board_id: seed.boardId, column_id: seed.columnId, notepad_id: input.notepadId },
      ]);
      const readScope = { workspaceId: input.workspaceId, projectId: input.projectId };
      expect(await db.notepads.findByIdInScope(readScope, input.notepadId)).toMatchObject({
        kind: 'card',
        parentId: null,
        projectId: seed.projectId,
        workspaceId: seed.workspaceId,
      });
      expect(await db.notepads.findByIdInScope(readScope, input.linkedNotepad!.id)).toMatchObject({
        kind: 'notepad',
        title: mode === 'new' ? 'Linked' : 'Original',
      });
      expect(await search('gazelle')).toContain(input.notepadId);
      expect(await db.notepads.listLinks(readScope, input.notepadId)).toEqual([
        { targetType: 'notepad', targetId: input.linkedNotepad!.id },
      ]);
      expect(
        await db.query('SELECT user_id FROM card_assignees WHERE card_id = ?', [input.cardId]),
      ).toEqual([{ user_id: seed.memberId }]);
      expect(await db.notepads.listTagIds(readScope, input.notepadId)).toEqual([seed.tagId]);
      expect(
        await db.query(
          'SELECT user_id, actor_id, card_id, type FROM notifications WHERE notepad_id = ?',
          [input.notepadId],
        ),
      ).toEqual([
        { user_id: seed.memberId, actor_id: seed.actorId, card_id: input.cardId, type: 'assigned' },
      ]);
    },
  );

  it('isolates notification read writes by workspace and user', async () => {
    await assertNotificationReadIsolation(db.notifications, db.query);
  });

  it('revalidates membership and cleans up only its workspace atomically', async () => {
    await assertMemberIsolation(db.createMembers, db.query);
  });

  it('keeps traversal within the requested workspace and project', async () => {
    await assertTreeScopeIsolation(db);
  });

  it('rolls every new card row back when the final assignment notification conflicts', async () => {
    const input = plan('new');
    await db.query(
      "INSERT INTO notifications (id, workspace_id, user_id, type, actor_id, created_at) VALUES (?, ?, ?, 'assigned', ?, ?)",
      [
        input.assignmentNotifications[0]!.id,
        seed.workspaceId,
        seed.memberId,
        seed.actorId,
        seed.now,
      ],
    );
    await expect(db.cards.createFromPlan(input)).rejects.toThrow();
    expect(await db.cards.findByIdInScope({ workspaceId: input.workspaceId, projectId: input.projectId }, input.cardId)).toBeNull();
    for (const id of [input.notepadId, input.linkedNotepad!.id]) {
      const readScope = { workspaceId: input.workspaceId, projectId: input.projectId };
      expect(await db.notepads.findByIdInScope(readScope, id)).toBeNull();
      expect(await db.notepads.listLinks(readScope, id)).toEqual([]);
      expect(await db.notepads.listTagIds(readScope, id)).toEqual([]);
    }
    expect(await search('gazelle')).not.toContain(input.notepadId);
    expect(
      await db.query('SELECT user_id FROM card_assignees WHERE card_id = ?', [input.cardId]),
    ).toEqual([]);
    expect(
      await db.query('SELECT id FROM notifications WHERE workspace_id = ?', [seed.workspaceId]),
    ).toEqual([{ id: input.assignmentNotifications[0]!.id }]);
  });
});
