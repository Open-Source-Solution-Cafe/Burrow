import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { extractPlainText } from '../../src/shared/extract';
import { createDb } from '../../src/core/adapters/db/d1/client';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { CardService, type CardPlan } from '../../src/core/services/cards';
import { NotepadService } from '../../src/core/services/notepads';
import { expectInvariantsHold } from './helpers';

const db = createDb(env.DB);
const infrastructure = createD1Infrastructure(db, env);
const repositories = infrastructure.repositories;
const notepads = new NotepadService(repositories, infrastructure.locks);
const cards = new CardService(repositories);
const saveBatch = (args: any) => repositories.notepads.saveContentBatch({
  ...args,
  scope: { workspaceId: args.row.workspaceId, projectId: args.row.projectId, actorUserId: args.actorId, minimumRole: 'editor' },
});

/** Unique, collision-free ids so tests never share rows. */
function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Minimal BlockNote document: one paragraph of plain text. */
function contentWith(text: string): string {
  return JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text }] }]);
}

/** BlockNote document with a user mention in front of the text. */
function contentMentioning(userId: string, text: string): string {
  return JSON.stringify([
    {
      type: 'paragraph',
      content: [
        {
          type: 'mention',
          props: { kind: 'user', id: userId, label: 'Teammate' },
        },
        { type: 'text', text: ` ${text}` },
      ],
    },
  ]);
}

interface WorkspaceSeed {
  workspaceId: string;
  userId: string;
  member2Id: string;
  projectId: string;
}

async function seedWorkspace(): Promise<WorkspaceSeed> {
  const workspaceId = uid('ws');
  const userId = uid('user');
  const member2Id = uid('user');
  const projectId = uid('proj');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, 'Spike workspace', ?, ?)`,
    ).bind(workspaceId, userId, now),
    env.DB.prepare(
      `INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`,
    ).bind(workspaceId, userId, now),
    env.DB.prepare(
      `INSERT INTO members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'editor', ?)`,
    ).bind(workspaceId, member2Id, now),
    env.DB.prepare(
      `INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, 'Spike project', 'a0', ?, ?)`,
    ).bind(projectId, workspaceId, now, now),
  ]);
  return { workspaceId, userId, member2Id, projectId };
}

async function seedNotepad(
  seed: WorkspaceSeed,
  text: string,
): Promise<{ id: string; content: string }> {
  const id = uid('np');
  const content = contentWith(text);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notepads (id, workspace_id, project_id, kind, title, content, version, position, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'notepad', 'Spike notepad', ?, 1, 'a0', ?, ?, ?)`,
    ).bind(id, seed.workspaceId, seed.projectId, content, seed.userId, now, now),
    env.DB.prepare(
      `INSERT INTO notepads_fts (notepad_id, project_id, title, body) VALUES (?, ?, 'Spike notepad', ?)`,
    ).bind(id, seed.projectId, extractPlainText(content)),
  ]);
  return { id, content };
}

async function seedBoard(seed: WorkspaceSeed): Promise<{ boardId: string; columnId: string }> {
  const boardId = uid('board');
  const columnId = uid('col');
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO boards (id, workspace_id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 'Spike board', 'a0', ?, ?)`,
    ).bind(boardId, seed.workspaceId, seed.projectId, now, now),
    env.DB.prepare(
      `INSERT INTO board_columns (id, board_id, name, position) VALUES (?, ?, 'Todo', 'a0')`,
    ).bind(columnId, boardId),
  ]);
  return { boardId, columnId };
}

async function notepadRow(id: string): Promise<{ version: number; content: string } | null> {
  return env.DB.prepare('SELECT version, content FROM notepads WHERE id = ?')
    .bind(id)
    .first<{ version: number; content: string }>();
}

async function ftsMatches(term: string): Promise<string[]> {
  const res = await env.DB.prepare('SELECT notepad_id FROM notepads_fts WHERE notepads_fts MATCH ?')
    .bind(term)
    .all<{ notepad_id: string }>();
  return (res.results ?? []).map((r) => r.notepad_id);
}

async function countRows(query: string, bindValue: string): Promise<number> {
  const row = await env.DB.prepare(query).bind(bindValue).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Live command contracts: content, index, references and notifications commit
 * together, while failed or stale commands leave no side effects.
 */
describe('D1 atomic command contract', () => {
  it.each(['foreign-user', 'other-client', 'no-client'] as const)(
    'denies a current-version save against an active %s lock atomically',
    async (scenario) => {
      const seed = await seedWorkspace();
      const notepad = await seedNotepad(seed, 'quokka original');
      const now = Date.now();
      const userId = scenario === 'foreign-user' ? seed.member2Id : seed.userId;
      await infrastructure.locks.acquire(notepad.id, userId, 'holder', 60_000);
      const scope = { workspaceId: seed.workspaceId, projectId: seed.projectId };
      const beforeLock = await repositories.notepads.getLock(scope, notepad.id);
      await expect(
        saveBatch({
          row: {
            id: notepad.id,
            workspaceId: seed.workspaceId,
            projectId: seed.projectId,
            title: 'Spike notepad',
          },
          content: contentMentioning(seed.member2Id, 'gazelle replacement'),
          baseVersion: 1,
          actorId: seed.userId,
          validLinks: [{ targetType: 'user', targetId: seed.member2Id }],
          previousLinks: [],
          now,
          lock:
            scenario === 'no-client'
              ? undefined
              : {
                  userId: seed.userId,
                  clientId: scenario === 'foreign-user' ? 'holder' : 'other',
                  expiresAt: now + 60_000,
                },
        }),
      ).rejects.toThrow('lock_conflict');
      expect(await notepadRow(notepad.id)).toEqual({ content: notepad.content, version: 1 });
      expect(await repositories.notepads.getLock(scope, notepad.id)).toEqual(beforeLock);
      expect(
        await repositories.notepads.listLinks(
          { workspaceId: seed.workspaceId, projectId: seed.projectId },
          notepad.id,
        ),
      ).toEqual([]);
      expect(
        await countRows('SELECT COUNT(*) AS n FROM notifications WHERE notepad_id = ?', notepad.id),
      ).toBe(0);
      expect(await ftsMatches('gazelle')).not.toContain(notepad.id);
      expect(await ftsMatches('quokka')).toContain(notepad.id);
    },
  );

  it.each([false, true])(
    'allows a save with its own client or an expired foreign lock (expired=%s)',
    async (expired) => {
      const seed = await seedWorkspace();
      const notepad = await seedNotepad(seed, 'quokka original');
      const now = Date.now();
      await infrastructure.locks.acquire(
        notepad.id,
        expired ? seed.member2Id : seed.userId,
        expired ? 'rival' : 'original',
        expired ? -1 : 60_000,
      );
      expect(
        await saveBatch({
          row: {
            id: notepad.id,
            workspaceId: seed.workspaceId,
            projectId: seed.projectId,
            title: 'Spike notepad',
          },
          content: contentWith('gazelle replacement'),
          baseVersion: 1,
          actorId: seed.userId,
          validLinks: [],
          previousLinks: [],
          now,
          lock: { userId: seed.userId, clientId: 'original', expiresAt: now + 60_000 },
        }),
      ).toBe(2);
      expect(await repositories.notepads.getLock({ workspaceId: seed.workspaceId, projectId: seed.projectId }, notepad.id)).toMatchObject({
        userId: seed.userId,
        clientId: 'original',
      });
    },
  );

  it('(a) a valid save batch commits content, FTS, links and notifications together', async () => {
    const seed = await seedWorkspace();
    const notepad = await seedNotepad(seed, 'original quokka draft');

    const content = contentMentioning(seed.member2Id, 'gazelle patrol');
    const result = await notepads.saveContent({
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      notepadId: notepad.id,
      content,
      baseVersion: 1,
      actorId: seed.userId,
    });
    expect(result.version).toBe(2);

    const row = await notepadRow(notepad.id);
    expect(row?.version).toBe(2);
    expect(row?.content).toBe(content);

    // FTS row was rebuilt: new text searchable, old text gone.
    expect(await ftsMatches('gazelle')).toContain(notepad.id);
    expect(await ftsMatches('quokka')).not.toContain(notepad.id);

    // The mention produced a link row and a notification in the same batch.
    const links = await env.DB.prepare(
      'SELECT target_type, target_id FROM notepad_links WHERE source_id = ?',
    )
      .bind(notepad.id)
      .all<{ target_type: string; target_id: string }>();
    expect(links.results).toEqual([{ target_type: 'user', target_id: seed.member2Id }]);

    const notifs = await env.DB.prepare(
      'SELECT type, actor_id FROM notifications WHERE notepad_id = ? AND user_id = ?',
    )
      .bind(notepad.id, seed.member2Id)
      .all<{ type: string; actor_id: string }>();
    expect(notifs.results).toHaveLength(1);
    expect(notifs.results?.[0]).toMatchObject({
      type: 'mention',
      actor_id: seed.userId,
    });

    await expectInvariantsHold(env.DB);
  });

  it('(b) a late write failure rolls back content, FTS, links and notifications', async () => {
    const seed = await seedWorkspace();
    const notepad = await seedNotepad(seed, 'original quokka draft');

    const newContent = contentMentioning(seed.member2Id, 'wombat replacement');
    const trigger = 'fail_save_' + crypto.randomUUID().replaceAll('-', '');
    // Abort only after the content, index and notification writes reached the
    // real command's backlink insert. The transaction must undo all of them.
    await env.DB.prepare(
      `CREATE TRIGGER "${trigger}" BEFORE INSERT ON notepad_links
      WHEN NEW.source_id = '${notepad.id}'
        AND EXISTS (SELECT 1 FROM notepads WHERE id = NEW.source_id AND version = 2)
        AND EXISTS (SELECT 1 FROM notifications WHERE notepad_id = NEW.source_id AND user_id = '${seed.member2Id}')
      BEGIN SELECT RAISE(ABORT, 'forced_save_failure'); END`,
    ).run();
    try {
      await expect(
        notepads.saveContent({
          workspaceId: seed.workspaceId,
          projectId: seed.projectId,
          notepadId: notepad.id,
          content: newContent,
          baseVersion: 1,
          actorId: seed.userId,
        }),
      ).rejects.toThrow('forced_save_failure');
    } finally {
      await env.DB.prepare(`DROP TRIGGER "${trigger}"`).run();
    }

    // Nothing from the batch survived: content, version, FTS, links, notifications.
    const row = await notepadRow(notepad.id);
    expect(row?.version).toBe(1);
    expect(row?.content).toBe(notepad.content);

    expect(await ftsMatches('wombat')).not.toContain(notepad.id);
    expect(await ftsMatches('quokka')).toContain(notepad.id);

    expect(
      await countRows('SELECT COUNT(*) AS n FROM notepad_links WHERE source_id = ?', notepad.id),
    ).toBe(0);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notifications WHERE notepad_id = ?', notepad.id),
    ).toBe(0);

    await expectInvariantsHold(env.DB);
  });

  it('(c) createCard is atomic: success writes every row, a failing statement writes none of them', async () => {
    const seed = await seedWorkspace();
    const { boardId, columnId } = await seedBoard(seed);

    const created = await cards.createCard({
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      actorId: seed.userId,
      boardId,
      columnId,
      title: 'Spike card',
    });
    expect(created.linkedNotepadId).toBeNull();

    const card = await env.DB.prepare('SELECT notepad_id FROM cards WHERE id = ?')
      .bind(created.cardId)
      .first<{ notepad_id: string }>();
    expect(card?.notepad_id).toBe(created.notepadId);

    const cardNotepad = await env.DB.prepare(
      'SELECT kind, title, parent_id FROM notepads WHERE id = ?',
    )
      .bind(created.notepadId)
      .first<{ kind: string; title: string; parent_id: string | null }>();
    expect(cardNotepad?.kind).toBe('card');
    expect(cardNotepad?.title).toBe('Spike card');
    expect(cardNotepad?.parent_id).toBeNull(); // I2: card notepads are not in the tree

    expect(
      await countRows(
        'SELECT COUNT(*) AS n FROM notepads_fts WHERE notepad_id = ?',
        created.notepadId,
      ),
    ).toBe(1);
    await expectInvariantsHold(env.DB);

    // A duplicate notification ID fails the final insert in the real command.
    const notificationId = uid('notification');
    await env.DB.prepare(
      `INSERT INTO notifications (id, workspace_id, user_id, type, actor_id, created_at)
       VALUES (?, ?, ?, 'assigned', ?, ?)`,
    )
      .bind(notificationId, seed.workspaceId, seed.member2Id, seed.userId, Date.now())
      .run();
    const plan: CardPlan = {
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      boardId,
      columnId,
      actorId: seed.userId,
      cardId: uid('card'),
      notepadId: uid('np'),
      title: 'Doomed card',
      content: '[]',
      plainText: '',
      priority: null,
      dueDate: null,
      assigneeIds: [],
      tagIds: [],
      assignmentNotifications: [{ id: notificationId, userId: seed.member2Id }],
      cardPosition: 'a0',
      linkedNotepad: null,
      now: Date.now(),
    };
    await expect(repositories.cards.createFromPlan(plan)).rejects.toThrow(
      /UNIQUE constraint failed: notifications.id/,
    );

    expect(
      await env.DB.prepare('SELECT id FROM cards WHERE id = ?').bind(plan.cardId).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM notepads WHERE id = ?').bind(plan.notepadId).first(),
    ).toBeNull();
    expect(
      await countRows(
        'SELECT COUNT(*) AS n FROM notepads_fts WHERE notepad_id = ?',
        plan.notepadId,
      ),
    ).toBe(0);

    await expectInvariantsHold(env.DB);
  });

  it('(d) foreign keys are enforced and ON DELETE CASCADE removes dependent rows', async () => {
    const seed = await seedWorkspace();
    const notepad = await seedNotepad(seed, 'cascade wombat');
    const { boardId } = await seedBoard(seed);

    // FK enforcement: a notepad cannot point at a project that does not exist.
    const orphan = env.DB.prepare(
      `INSERT INTO notepads (id, workspace_id, project_id, kind, title, content, version, position, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'notepad', 'Orphan', '[]', 1, 'a0', ?, ?, ?)`,
    ).bind(uid('np'), seed.workspaceId, 'no-such-project', seed.userId, Date.now(), Date.now());
    // Isolate the database FK check from the earlier tenant-scope trigger.
    // Restore the exact trigger immediately so later operations retain normal guards.
    await env.DB.prepare('DROP TRIGGER notepads_scope_insert_guard').run();
    try {
      await expect(orphan.run(), 'D1 must reject inserts that violate a foreign key').rejects.toThrow(
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      await env.DB.prepare(`CREATE TRIGGER notepads_scope_insert_guard
        BEFORE INSERT ON notepads
        WHEN NOT EXISTS (
          SELECT 1 FROM projects p
          WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
        ) OR (NEW.parent_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM notepads parent
          WHERE parent.id = NEW.parent_id
            AND parent.project_id = NEW.project_id
            AND parent.workspace_id = NEW.workspace_id
        )) OR (NEW.kind = 'card' AND NEW.parent_id IS NOT NULL)
        BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END`).run();
    }

    // Cascade: deleting the project takes its notepads and boards with it.
    await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(seed.projectId).run();
    expect(
      await env.DB.prepare('SELECT id FROM notepads WHERE id = ?').bind(notepad.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM boards WHERE id = ?').bind(boardId).first(),
    ).toBeNull();

    // FTS virtual tables have no foreign keys — app-level deletes must clean
    // them explicitly (this is what ftsDeleteAllStmt is for).
    await env.DB.prepare(
      'DELETE FROM notepads_fts WHERE notepad_id NOT IN (SELECT id FROM notepads)',
    ).run();
    await expectInvariantsHold(env.DB);
  });

  it('(e1) a stale baseVersion save is rejected before any write happens', async () => {
    const seed = await seedWorkspace();
    const notepad = await seedNotepad(seed, 'original quokka draft');

    const stale = contentWith('stale outsider narwhal');
    await expect(
      notepads.saveContent({
        workspaceId: seed.workspaceId,
        projectId: seed.projectId,
        notepadId: notepad.id,
        content: stale,
        baseVersion: 99,
        actorId: seed.userId,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'version_conflict' });

    const row = await notepadRow(notepad.id);
    expect(row?.version).toBe(1);
    expect(row?.content).toBe(notepad.content);

    expect(await ftsMatches('narwhal')).not.toContain(notepad.id);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notepad_links WHERE source_id = ?', notepad.id),
    ).toBe(0);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notifications WHERE notepad_id = ?', notepad.id),
    ).toBe(0);

    await expectInvariantsHold(env.DB);
  });

  it('(e2) a save that loses the version race changes nothing anywhere — content, FTS, links, notifications', async () => {
    const seed = await seedWorkspace();
    const notepad = await seedNotepad(seed, 'original quokka draft');

    // Another writer wins: version 1 -> 2 with different content.
    const winningContent = contentWith('second writer gazelle');
    await notepads.saveContent({
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      notepadId: notepad.id,
      content: winningContent,
      baseVersion: 1,
      actorId: seed.userId,
    });

    // A command prepared against version 1 must lose to the winner without
    // modifying its content, index, links or notifications.
    const staleContent = contentMentioning(seed.member2Id, 'sneaky intruder');
    await expect(
      saveBatch({
        row: {
          id: notepad.id,
          workspaceId: seed.workspaceId,
          projectId: seed.projectId,
          title: 'Spike notepad',
        },
        content: staleContent,
        baseVersion: 1,
        actorId: seed.userId,
        validLinks: [{ targetType: 'user', targetId: seed.member2Id }],
        previousLinks: [],
        now: Date.now(),
      }),
    ).rejects.toThrow('version_conflict');

    const row = await notepadRow(notepad.id);
    expect(row?.version).toBe(2);
    expect(row?.content).toBe(winningContent);

    expect(await ftsMatches('sneaky')).not.toContain(notepad.id);
    expect(await ftsMatches('gazelle')).toContain(notepad.id);

    expect(
      await countRows('SELECT COUNT(*) AS n FROM notepad_links WHERE source_id = ?', notepad.id),
    ).toBe(0);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notifications WHERE notepad_id = ?', notepad.id),
    ).toBe(0);

    await expectInvariantsHold(env.DB);
  });

  it('(e3) a stale identical-content command cannot duplicate mentions or acquire a lock', async () => {
    const seed = await seedWorkspace();
    const notepad = await seedNotepad(seed, 'original draft');
    const content = contentMentioning(seed.member2Id, 'same content');
    await notepads.saveContent({
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      notepadId: notepad.id,
      content,
      baseVersion: 1,
      actorId: seed.userId,
    });
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notifications WHERE notepad_id = ?', notepad.id),
    ).toBe(1);

    const now = Date.now();
    await expect(
      saveBatch({
        row: {
          id: notepad.id,
          workspaceId: seed.workspaceId,
          projectId: seed.projectId,
          title: 'Spike notepad',
        },
        content,
        baseVersion: 1,
        actorId: seed.userId,
        validLinks: [{ targetType: 'user', targetId: seed.member2Id }],
        previousLinks: [],
        now,
        lock: { userId: seed.userId, clientId: 'stale-client', expiresAt: now + 60_000 },
      }),
    ).rejects.toThrow('version_conflict');

    expect(await notepadRow(notepad.id)).toEqual({ version: 2, content });
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notifications WHERE notepad_id = ?', notepad.id),
    ).toBe(1);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notepad_links WHERE source_id = ?', notepad.id),
    ).toBe(1);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notepads_fts WHERE notepad_id = ?', notepad.id),
    ).toBe(1);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM edit_locks WHERE notepad_id = ?', notepad.id),
    ).toBe(0);
    await expectInvariantsHold(env.DB);
  });

  it('a current-version save under another project leaves content, metadata, links and locks unchanged', async () => {
    const seed = await seedWorkspace();
    const note = await seedNotepad(seed, 'unchanged quokka');
    const projectId = uid('project');
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO projects (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(projectId, seed.workspaceId, 'Other project', 'a0', now, now)
      .run();
    await env.DB.prepare(
      'INSERT INTO edit_locks (notepad_id, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)',
    )
      .bind(note.id, seed.userId, 'expired-original', now - 1)
      .run();
    const before = await env.DB.prepare(
      'SELECT content, version, updated_at FROM notepads WHERE id = ?',
    )
      .bind(note.id)
      .first();
    const scope = { workspaceId: seed.workspaceId, projectId };
    const oldLock = await repositories.notepads.getLock(scope, note.id);
    await expect(
      saveBatch({
        row: { id: note.id, workspaceId: seed.workspaceId, projectId, title: 'Spike notepad' },
        content: contentMentioning(seed.member2Id, 'foreign project overwrite'),
        baseVersion: 1,
        actorId: seed.userId,
        validLinks: [{ targetType: 'user', targetId: seed.member2Id }],
        previousLinks: [],
        now,
        lock: { userId: seed.userId, clientId: 'replacement', expiresAt: now + 60_000 },
      }),
    ).rejects.toThrow('version_conflict');
    expect(
      await env.DB.prepare('SELECT content, version, updated_at FROM notepads WHERE id = ?')
        .bind(note.id)
        .first(),
    ).toEqual(before);
    expect(await repositories.notepads.getLock(scope, note.id)).toEqual(oldLock);
    expect(await ftsMatches('quokka')).toContain(note.id);
    expect(await ftsMatches('overwrite')).not.toContain(note.id);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notepad_links WHERE source_id = ?', note.id),
    ).toBe(0);
    expect(
      await countRows('SELECT COUNT(*) AS n FROM notifications WHERE notepad_id = ?', note.id),
    ).toBe(0);
    await expectInvariantsHold(env.DB);
  });
});
