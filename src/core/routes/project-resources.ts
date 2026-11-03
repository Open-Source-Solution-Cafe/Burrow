import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env } from '../app';
import type { Infrastructure, RepositoryContainer } from '../infrastructure/types';
import type { NotepadService } from '../services/notepads';
import type { BoardService } from '../services/boards';
import type { CardService } from '../services/cards';
import type { CommentService } from '../services/comments';
import type { TagService } from '../services/tags';
import { createExplicitWorkspaceMiddleware, requireRole } from '../middleware/session';
import { httpError } from '../services/errors';
import { validateStorageKey } from '../adapters/storage/validation';

const createNotepadSchema = z.object({
  parentId: z.string().optional().nullable(),
  title: z.string().optional(),
});
const patchNotepadSchema = z.object({
  title: z.string().optional(),
  icon: z.string().optional().nullable(),
  coverKey: z.string().optional().nullable(),
  isFavorite: z.boolean().optional(),
});
const saveContentSchema = z.object({
  content: z.string(),
  baseVersion: z.number().int().min(1),
  clientId: z.string().optional(),
});
const moveNotepadSchema = z.object({
  parentId: z.string().optional().nullable(),
  afterId: z.string().optional().nullable(),
});
const lockSchema = z.object({ clientId: z.string().min(1), takeover: z.boolean().optional() });
const tagsSchema = z.object({ tagIds: z.array(z.string()) });
const createBoardSchema = z.object({ name: z.string().min(1), icon: z.string().optional().nullable() });
const updateBoardSchema = z.object({
  name: z.string().min(1).optional(),
  icon: z.string().optional().nullable(),
});
const createColumnSchema = z.object({ name: z.string().min(1), color: z.string().optional().nullable() });
const updateColumnSchema = z.object({
  name: z.string().min(1).optional(),
  color: z.string().optional().nullable(),
  wipLimit: z.number().int().min(0).max(999).optional().nullable(),
});
const moveColumnSchema = z.object({ afterId: z.string().optional().nullable() });
const quickAddCardSchema = z.object({
  title: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().nullable(),
  dueDate: z.number().int().optional().nullable(),
  assigneeIds: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  notepad: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('new') }),
      z.object({ mode: z.literal('existing'), id: z.string() }),
    ])
    .optional(),
});
const updateCardSchema = z.object({
  title: z.string().min(1).optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().nullable(),
  dueDate: z.number().int().optional().nullable(),
  assigneeIds: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
});
const moveCardSchema = z.object({ columnId: z.string().min(1), afterId: z.string().optional().nullable() });
const createSubtaskSchema = z.object({ title: z.string().min(1) });
const updateSubtaskSchema = z.object({
  title: z.string().min(1).optional(),
  completed: z.boolean().optional(),
  afterId: z.string().optional().nullable(),
});
const createCommentSchema = z.object({ content: z.string().min(1).max(10_000) });
const createTagSchema = z.object({ name: z.string().trim().min(1).max(50), color: z.string().optional() });
const updateTagSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  color: z.string().optional(),
});
const summarySchema = z.object({ ids: z.string().default('') });
const searchSchema = z.object({ q: z.string().default('') });
const suggestSchema = z.object({
  type: z.enum(['notepad', 'card', 'tag']),
  q: z.string().optional().default(''),
});
const referenceSchema = z.object({ kind: z.enum(['notepad', 'board', 'card']), id: z.string().min(1) });

export function createProjectResourceRoutes(args: {
  repositories: RepositoryContainer;
  notepads: NotepadService;
  boards: BoardService;
  cards: CardService;
  comments: CommentService;
  tags: TagService;
  search: Infrastructure['search'];
}) {
  const { repositories, notepads, boards, cards, comments, tags, search } = args;
  const explicitWorkspace = createExplicitWorkspaceMiddleware(repositories.members);
  const route = new Hono<Env>();

  const resolveProject = createMiddleware<Env>(async (c, next) => {
    const projectId = c.req.param('pid');
    if (!projectId) throw httpError(404, 'not_found', 'Project not found');
    const project = await repositories.projects.findByIdAndWorkspace(
      projectId,
      c.get('workspaceId'),
    );
    if (!project) throw httpError(404, 'not_found', 'Project not found');
    await next();
  });


  const missing = (message: string) => httpError(404, 'not_found', message);
  const requireProjectId = (c: { req: { param(name: string): string | undefined } }) => {
    const id = c.req.param('pid');
    if (!id) throw missing('Project not found');
    return id;
  };
  const projectScope = (c: any) => ({
    workspaceId: c.get('workspaceId') as string,
    projectId: requireProjectId(c),
  });
  const notepadInScope = (id: string, scope: { workspaceId: string; projectId: string }) =>
    repositories.notepads.findByIdInScope(scope, id);
  const boardInScope = (id: string, scope: { workspaceId: string; projectId: string }) =>
    repositories.boards.findByIdInScope(scope, id);
  const cardInScope = (id: string, scope: { workspaceId: string; projectId: string }) =>
    repositories.cards.findByIdInScope(scope, id);
  const tagInScope = (id: string, scope: { workspaceId: string; projectId: string }) =>
    repositories.tags.findByIdInScope(scope, id);
  const columnInScope = (id: string, scope: { workspaceId: string; projectId: string }) =>
    repositories.boards.findColumnByIdInScope(scope, id);

const getNotepad = async (c: any) => {
    const notepad = await notepadInScope(c.req.param('id'), projectScope(c));
    if (!notepad) throw missing('Notepad not found');
    return notepad;
  };

const getBoard = async (c: any) => {
    const board = await boardInScope(c.req.param('id'), projectScope(c));
    if (!board) throw missing('Board not found');
    return board;
  };

const getCard = async (c: any) => {
    const card = await cardInScope(c.req.param('id'), projectScope(c));
    if (!card) throw missing('Card not found');
    return card;
  };

const getTag = async (c: any) => {
    const tag = await tagInScope(c.req.param('id'), projectScope(c));
    if (!tag) throw missing('Tag not found');
    return tag;
  };

const getColumn = async (c: any, columnId = c.req.param('id')) => {
    const column = await columnInScope(columnId, projectScope(c));
    if (!column) throw missing('Column not found');
    return column;
  };

const notepadLifecycle = (action: 'delete' | 'restore' | 'permanent') => async (c: any) => {
    const note = await getNotepad(c);
    if (action === 'delete') {
      await notepads.softDeleteNotepad({ workspaceId: c.get('workspaceId'), projectId: note.projectId, actorUserId: c.get('userId'), notepadId: note.id });
      return c.json({ ok: true, deletedId: note.id });
    }
    if (action === 'restore') {
      await notepads.restoreNotepad({ workspaceId: c.get('workspaceId'), projectId: note.projectId, actorUserId: c.get('userId'), notepadId: note.id });
      return c.json({ ok: true, restoredId: note.id });
    }
    await notepads.permanentDeleteNotepad({ workspaceId: c.get('workspaceId'), projectId: note.projectId, actorUserId: c.get('userId'), notepadId: note.id });
    return c.json({ ok: true, permanentlyDeletedId: note.id });
  };

  const projectRoutes = new Hono<Env>()
.get('/notepads', async (c) => {
    const rows = await notepads.listByProject({
      workspaceId: c.get('workspaceId'),
      projectId: requireProjectId(c),
    });
    return c.json(
      rows.map((note) => ({
        id: note.id,
        parentId: note.parentId,
        title: note.title,
        icon: note.icon,
        position: note.position,
        isFavorite: note.isFavorite,
      })),
    );
  })
.post('/notepads',
    requireRole('editor'),
    zValidator('json', createNotepadSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const projectId = requireProjectId(c);
      const { parentId, title } = c.req.valid('json');
      if (parentId) {
        const parent = await notepadInScope(parentId, { workspaceId, projectId });
        if (!parent) throw missing('Parent notepad not found in project');
      }
      const result = await notepads.createNotepad({
        workspaceId,
        projectId,
        parentId,
        title,
        createdBy: c.get('userId'),
        actorUserId: c.get('userId'),
      });
      return c.json(result, 201);
    },
  )
.get('/trash', async (c) => {
    const projectId = requireProjectId(c);
    const [notes, projectBoards] = await Promise.all([
      repositories.notepads.listDeletedByProject({ workspaceId: c.get('workspaceId'), projectId }),
      repositories.boards.listDeletedByProject({ workspaceId: c.get('workspaceId'), projectId }),
    ]);
    return c.json({ notepads: notes, boards: projectBoards });
  })
.get('/recent', async (c) => {
    const rows = await repositories.notepads.listByProject({
      workspaceId: c.get('workspaceId'),
      projectId: requireProjectId(c),
    });
    const recent = rows
      .filter((note) => note.deletedAt === null && note.kind === 'notepad')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20)
      .map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt }));
    return c.json(recent);
  })
.get('/references/:kind/:id',
    zValidator('param', z.object({ pid: z.string().min(1), kind: referenceSchema.shape.kind, id: z.string().min(1) })),
    async (c) => {
      const { pid: projectId, kind, id } = c.req.valid('param');
      const scope = { workspaceId: c.get('workspaceId'), projectId };
      const preview = await repositories.notepads.resolveReference(scope, kind, id);
      if (!preview) throw missing('Reference unavailable');
      c.header('Cache-Control', 'private, no-store');
      return c.json(preview);
    },
  )
.get('/boards', async (c) =>
    c.json(await boards.listBoards({ workspaceId: c.get('workspaceId'), projectId: requireProjectId(c) })),
  )
.post('/boards',
    requireRole('editor'),
    zValidator('json', createBoardSchema),
    async (c) => {
      const body = c.req.valid('json');
      const result = await boards.createBoard({
        workspaceId: c.get('workspaceId'),
        actorUserId: c.get('userId'),
        projectId: requireProjectId(c),
        name: body.name,
        icon: body.icon,
      });
      return c.json(result, 201);
    },
  )
.get('/tags', async (c) =>
    c.json(await tags.listTags({ workspaceId: c.get('workspaceId'), projectId: requireProjectId(c) })),
  )
.post('/tags',
    requireRole('editor'),
    zValidator('json', createTagSchema),
    async (c) => {
      const { name, color } = c.req.valid('json');
      const result = await tags.createTag(c.get('workspaceId'), requireProjectId(c), c.get('userId'), name, color);
      return c.json(result, 201);
    },
  )
.get('/search', zValidator('query', searchSchema), async (c) => {
    const q = c.req.valid('query').q.trim();
    if (!q) return c.json([]);
    return c.json(
      await search.search({
        workspaceId: c.get('workspaceId'),
        projectId: requireProjectId(c),
        text: q,
        limit: 25,
      }),
    );
  })
.get('/suggest', zValidator('query', suggestSchema), async (c) => {
    const { type, q } = c.req.valid('query');
    const pattern = q.trim();
    if (type === 'notepad') {
      const rows = await repositories.notepads.findByPattern(
        { workspaceId: c.get('workspaceId'), projectId: requireProjectId(c) },
        pattern,
        8,
      );
      return c.json(rows.map((row) => ({ id: row.id, label: row.title, icon: row.icon, kind: 'notepad' as const })));
    }
    if (type === 'card') {
      const rows = await repositories.cards.findByPattern(
        { workspaceId: c.get('workspaceId'), projectId: requireProjectId(c) },
        pattern,
        8,
      );
      return c.json(rows.map((row) => ({
        id: row.id,
        label: row.title,
        description: row.boardName,
        priority: row.priority,
        kind: 'card' as const,
      })));
    }
    const rows = await repositories.tags.findByPattern(
      { workspaceId: c.get('workspaceId'), projectId: requireProjectId(c) },
      pattern,
      8,
    );
    return c.json(rows.map((row) => ({ id: row.id, label: row.name, color: row.color, kind: 'tag' as const })));
  })
.get('/cards/summary', zValidator('query', summarySchema), async (c) => {
    const projectId = requireProjectId(c);
    const ids = c.req
      .valid('query')
      .ids.split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    return c.json(await cards.getCardsSummary({ workspaceId: c.get('workspaceId'), projectId }, ids));
  });

  const itemRoutes = new Hono<Env>()
.get('/notepads/:id', async (c) => {
    const note = await getNotepad(c);
    const scope = { workspaceId: c.get('workspaceId'), projectId: note.projectId, now: Date.now() };
    const tagIds = await repositories.notepads.listTagIds(scope, note.id);
    const tagRows = await Promise.all(
      tagIds.map((id) => repositories.tags.findByIdInScope(scope, id)),
    );
    const lock = await repositories.notepads.getLock(scope, note.id);
    let lockInfo = null;
    if (lock && lock.expiresAt > Date.now()) {
      const holder = await notepads.getLockHolder(c.get('workspaceId'), lock.userId, c.get('userId'));
      lockInfo = { ...holder, clientId: holder.userId ? lock.clientId : undefined, expiresAt: lock.expiresAt };
    }
    return c.json({
      ...note,
      tags: tagRows.filter((tag) => tag !== null),
      backlinks: await repositories.notepads.listBacklinks(note, note.id),
      lock: lockInfo,
    });
  })
.patch('/notepads/:id',
    requireRole('editor'),
    zValidator('json', patchNotepadSchema),
    async (c) => {
      const note = await getNotepad(c);
      if (note.deletedAt !== null) return c.json({ error: 'notepad_deleted', message: 'Cannot modify a deleted notepad' }, 400);
      const body = c.req.valid('json');
      if (body.coverKey !== undefined && body.coverKey !== null) {
        try {
          body.coverKey = validateStorageKey(body.coverKey);
        } catch {
          throw httpError(400, 'invalid_cover_key', 'Cover key must belong to workspace');
        }
        if (!body.coverKey.startsWith(`${c.get('workspaceId')}/`)) {
          throw httpError(400, 'invalid_cover_key', 'Cover key must belong to workspace');
        }
        if (!(await repositories.projectFiles.findByProjectAndKey(note.projectId, body.coverKey))) {
          throw httpError(400, 'invalid_cover_key', 'Cover key must be registered to this project');
        }
      }
      const updates: any = { updatedAt: Date.now() };
      if (body.title !== undefined) updates.title = body.title.trim() || 'Untitled';
      if (body.icon !== undefined) updates.icon = body.icon;
      if (body.coverKey !== undefined) updates.coverKey = body.coverKey;
      if (body.isFavorite !== undefined) updates.isFavorite = body.isFavorite;
      const updated = await repositories.notepads.update(note.id, updates, {
        workspaceId: c.get('workspaceId'), projectId: note.projectId, actorUserId: c.get('userId'), minimumRole: 'editor',
      });
      if (!updated) throw missing('Notepad not found');
      return c.json({ ok: true, notepadId: note.id });
    },
  )
.put('/notepads/:id/content',
    requireRole('editor'),
    zValidator('json', saveContentSchema),
    async (c) => {
      const note = await getNotepad(c);
      if (note.deletedAt !== null) return c.json({ error: 'notepad_deleted', message: 'Cannot modify a deleted notepad' }, 400);
      const { content, baseVersion, clientId } = c.req.valid('json');
      try {
        return c.json(await notepads.saveContent({
          workspaceId: c.get('workspaceId'),
          projectId: note.projectId,
          notepadId: note.id,
          content,
          baseVersion,
          actorId: c.get('userId'),
          clientId,
          notepad: note,
        }));
      } catch (error: unknown) {
        if (error instanceof Error && 'code' in error && error.code === 'locked') {
          try {
            return c.json({ error: JSON.parse(error.message) }, 409);
          } catch {
            return c.json({ error: { code: 'locked', message: error.message } }, 409);
          }
        }
        throw error;
      }
    },
  )
.post('/notepads/:id/move',
    requireRole('editor'),
    zValidator('json', moveNotepadSchema),
    async (c) => {
      const note = await getNotepad(c);
      const { parentId, afterId } = c.req.valid('json');
      if (parentId && !(await notepadInScope(parentId, projectScope(c)))) {
        throw missing('Parent notepad not found in project');
      }
      return c.json(await notepads.moveNotepad({
        workspaceId: c.get('workspaceId'),
        projectId: note.projectId,
        actorUserId: c.get('userId'),
        notepadId: c.req.param('id'),
        parentId,
        afterId,
      }));
    },
  )
.delete('/notepads/:id', requireRole('editor'), notepadLifecycle('delete'))
.post('/notepads/:id/restore', requireRole('editor'), notepadLifecycle('restore'))
.delete('/notepads/:id/permanent', requireRole('owner'), notepadLifecycle('permanent'))
.post('/notepads/:id/lock', requireRole('editor'), zValidator('json', lockSchema), async (c) => {
    const note = await getNotepad(c);
    if (note.deletedAt !== null) throw missing('Notepad not found');
    const { clientId, takeover } = c.req.valid('json');
    try {
      return c.json(await notepads.claimLock({ workspaceId: c.get('workspaceId'), notepadId: note.id, userId: c.get('userId'), clientId, takeover }));
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'locked') {
        try { return c.json({ error: JSON.parse(error.message) }, 409); }
        catch { return c.json({ error: { code: 'locked', message: error.message } }, 409); }
      }
      throw error;
    }
  })
.delete('/notepads/:id/lock', requireRole('editor'), zValidator('json', lockSchema), async (c) => {
    const note = await getNotepad(c);
    const { clientId } = c.req.valid('json');
    await notepads.releaseLock({ workspaceId: c.get('workspaceId'), notepadId: note.id, userId: c.get('userId'), clientId });
    return c.json({ ok: true });
  })
.put('/notepads/:id/tags', requireRole('editor'), zValidator('json', tagsSchema), async (c) => {
    const note = await getNotepad(c);
    if (note.deletedAt !== null) return c.json({ error: 'notepad_deleted', message: 'Cannot modify a deleted notepad' }, 400);
    const { tagIds } = c.req.valid('json');
    await notepads.setNotepadTags(
      note.id,
      tagIds,
      { workspaceId: c.get('workspaceId'), projectId: note.projectId },
      c.get('userId'),
    );
    return c.json({ ok: true, notepadId: note.id, tagIds });
  })
.get('/boards/:id', async (c) => c.json(await boards.getBoard({ workspaceId: c.get('workspaceId'), projectId: requireProjectId(c) }, (await getBoard(c)).id)))
.patch('/boards/:id', requireRole('editor'), zValidator('json', updateBoardSchema), async (c) => {
    const board = await getBoard(c);
    await boards.updateBoard(projectScope(c), c.get('userId'), board.id, c.req.valid('json'));
    return c.json({ ok: true, boardId: board.id });
  })
.delete('/boards/:id', requireRole('editor'), async (c) => {
    const board = await getBoard(c);
    await boards.softDeleteBoard(projectScope(c), c.get('userId'), board.id);
    return c.json({ ok: true, deletedId: board.id });
  })
.post('/boards/:id/restore', requireRole('editor'), async (c) => {
    const board = await getBoard(c);
    await boards.restoreBoard(projectScope(c), c.get('userId'), board.id);
    return c.json({ ok: true, restoredId: board.id });
  })
.delete('/boards/:id/permanent', requireRole('owner'), async (c) => {
    const board = await getBoard(c);
    await boards.permanentDeleteBoard(projectScope(c), c.get('userId'), board.id);
    return c.json({ ok: true, permanentlyDeletedId: board.id });
  })
.post('/boards/:id/columns', requireRole('editor'), zValidator('json', createColumnSchema), async (c) => {
    const board = await getBoard(c);
    const result = await boards.createColumn(projectScope(c), c.get('userId'), board.id, c.req.valid('json').name, c.req.valid('json').color);
    return c.json(result, 201);
  })
.patch('/columns/:id', requireRole('editor'), zValidator('json', updateColumnSchema), async (c) => {
    const column = await getColumn(c);
    await boards.updateColumn(projectScope(c), c.get('userId'), column.id, c.req.valid('json'));
    return c.json({ ok: true, columnId: column.id });
  })
.post('/columns/:id/move', requireRole('editor'), zValidator('json', moveColumnSchema), async (c) => {
    const column = await getColumn(c);
    return c.json(await boards.moveColumn(projectScope(c), c.get('userId'), column.id, c.req.valid('json').afterId));
  })
.delete('/columns/:id', requireRole('editor'), zValidator('query', z.object({ moveTo: z.string().optional() })), async (c) => {
    const column = await getColumn(c);
    await boards.deleteColumn(projectScope(c), c.get('userId'), column.id, c.req.valid('query').moveTo || null);
    return c.json({ ok: true, deletedId: column.id });
  })
.post('/columns/:id/cards', requireRole('editor'), zValidator('json', quickAddCardSchema), async (c) => {
    const column = await getColumn(c);
    const body = c.req.valid('json');
    const result = await cards.createCard({
      workspaceId: c.get('workspaceId'),
      projectId: requireProjectId(c),
      actorId: c.get('userId'),
      boardId: column.boardId,
      columnId: column.id,
      title: body.title,
      priority: body.priority,
      dueDate: body.dueDate,
      assigneeIds: body.assigneeIds,
      tagIds: body.tagIds,
      notepad: body.notepad,
    });
    return c.json(result, 201);
  })
.get('/cards/:id', async (c) => c.json(await cards.getCard({ workspaceId: c.get('workspaceId'), projectId: requireProjectId(c) }, (await getCard(c)).id)))
.patch('/cards/:id', requireRole('editor'), zValidator('json', updateCardSchema), async (c) => {
    const card = await getCard(c);
    return c.json(await cards.updateCard(projectScope(c), card.id, c.req.valid('json'), c.get('userId')));
  })
.post('/cards/:id/move', requireRole('editor'), zValidator('json', moveCardSchema), async (c) => {
    const card = await getCard(c);
    const body = c.req.valid('json');
    const column = await getColumn(c, body.columnId);
    return c.json(await cards.moveCard({ workspaceId: c.get('workspaceId'), projectId: requireProjectId(c) }, c.get('userId'), card.id, column.id, body.afterId));
  })
.delete('/cards/:id', requireRole('editor'), async (c) => {
    const card = await getCard(c);
    await cards.deleteCard(projectScope(c), c.get('userId'), card.id);
    return c.json({ ok: true, deletedId: card.id });
  })
.post('/cards/:id/restore', requireRole('editor'), async (c) => {
    const card = await getCard(c);
    await cards.restoreCard(projectScope(c), c.get('userId'), card.id);
    return c.json({ ok: true, restoredId: card.id });
  })
.delete('/cards/:id/permanent', requireRole('owner'), async (c) => {
    const card = await getCard(c);
    await cards.permanentDeleteCard(projectScope(c), c.get('userId'), card.id);
    return c.json({ ok: true, permanentlyDeletedId: card.id });
  })
.post('/cards/:id/subtasks', requireRole('editor'), zValidator('json', createSubtaskSchema), async (c) => {
    const card = await getCard(c);
    return c.json(await cards.createSubtask(projectScope(c), c.get('userId'), card.id, c.req.valid('json').title), 201);
  })
.patch('/cards/:id/subtasks/:subtaskId', requireRole('editor'), zValidator('json', updateSubtaskSchema), async (c) => {
    const card = await getCard(c);
    return c.json(await cards.updateSubtask(projectScope(c), c.get('userId'), card.id, c.req.param('subtaskId'), c.req.valid('json')));
  })
.delete('/cards/:id/subtasks/:subtaskId', requireRole('editor'), async (c) => {
    const card = await getCard(c);
    return c.json(await cards.deleteSubtask(projectScope(c), c.get('userId'), card.id, c.req.param('subtaskId')));
  })
.get('/cards/:id/comments', async (c) => {
    const card = await getCard(c);
    return c.json(await comments.listComments(projectScope(c), card.id));
  })
.post('/cards/:id/comments', requireRole('editor'), zValidator('json', createCommentSchema), async (c) => {
    const card = await getCard(c);
    const result = await comments.createComment(projectScope(c), card.id, c.get('userId'), c.req.valid('json').content);
    return c.json(result, 201);
  })
.delete('/cards/:id/comments/:commentId', requireRole('editor'), async (c) => {
    const card = await getCard(c);
    return c.json(await comments.deleteComment(projectScope(c), card.id, c.req.param('commentId'), {
      userId: c.get('userId'),
      isOwner: c.get('role') === 'owner',
    }));
  })
.patch('/tags/:id', requireRole('editor'), zValidator('json', updateTagSchema), async (c) => {
    const tag = await getTag(c);
    return c.json(await tags.updateTag({ workspaceId: c.get('workspaceId'), projectId: tag.projectId, actorUserId: c.get('userId'), minimumRole: 'editor' }, tag.id, c.req.valid('json')));
  })
.delete('/tags/:id', requireRole('editor'), async (c) => {
    const tag = await getTag(c);
    await tags.deleteTag({ workspaceId: c.get('workspaceId'), projectId: tag.projectId, actorUserId: c.get('userId'), minimumRole: 'editor' }, tag.id);
    return c.json({ ok: true });
  });

  return route
    .use('/workspaces/:wid/projects/:pid/*', explicitWorkspace, resolveProject)
    .route('/workspaces/:wid/projects/:pid', projectRoutes)
    .route('/workspaces/:wid/projects/:pid', itemRoutes);
}
