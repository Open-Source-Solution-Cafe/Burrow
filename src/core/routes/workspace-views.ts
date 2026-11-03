import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../app';
import type { Infrastructure, RepositoryContainer } from '../infrastructure/types';
import type { CardService } from '../services/cards';
import type { INotificationRepository } from '../infrastructure/types';
import { createExplicitWorkspaceMiddleware } from '../middleware/session';
import { httpError } from '../services/errors';

const tasksSchema = z.object({
  status: z.enum(['all', 'open', 'completed']).optional(),
  projectId: z.string().optional(),
});
const searchSchema = z.object({
  q: z.string().default(''),
  projectId: z.string().optional(),
  scope: z.enum(['project', 'all']).optional(),
});
const suggestSchema = z.object({
  type: z.enum(['user', 'notepad', 'card', 'tag']),
  q: z.string().optional().default(''),
  projectId: z.string().optional(),
});
const markReadSchema = z.object({ ids: z.array(z.string()).optional() });

export function createWorkspaceViewRoutes(args: {
  repositories: Pick<
    RepositoryContainer,
    'projects' | 'members' | 'notepads' | 'cards' | 'tags'
  >;
  cards: CardService;
  notifications: INotificationRepository;
  search: Infrastructure['search'];
}) {
  const { repositories, cards, notifications, search } = args;
  const explicitWorkspace = createExplicitWorkspaceMiddleware(repositories.members);

  const myTasks = async (c: import('hono').Context<Env>) => {
    const { status, projectId } = tasksSchema.parse(c.req.query());
    if (projectId && !(await repositories.projects.findByIdAndWorkspace(projectId, c.get('workspaceId')))) {
      throw httpError(404, 'not_found', 'Project not found');
    }
    return c.json(
      await cards.getMyTasks(c.get('workspaceId'), c.get('userId'), {
        status: status ?? 'all',
        projectId: projectId || undefined,
      }),
    );
  };

  const notificationList = async (c: import('hono').Context<Env>) => {
    const rows = await notifications.listByUser(
      c.get('userId'),
      c.get('workspaceId'),
      c.req.query('unread') === '1',
    );
    return c.json(
      rows.map((row) => {
        const { actorId, actorName, actorImage, targetTitle, ...rest } = row;
        return {
          ...rest,
          actor: {
            id: actorId,
            name: actorName || 'Unknown User',
            image: actorImage ?? null,
          },
          targetTitle: targetTitle ?? undefined,
        };
      }),
    );
  };

  const markNotificationsRead = async (c: import('hono').Context<Env>) => {
    const body = markReadSchema.parse(await c.req.json());
    const userId = c.get('userId');
    const workspaceId = c.get('workspaceId');
    if (body.ids === undefined) await notifications.markAllRead(userId, workspaceId);
    else await notifications.markRead(userId, workspaceId, body.ids);
    return c.json({ ok: true });
  };

  const workspaceSearch = async (c: import('hono').Context<Env>) => {
    const { q, projectId } = searchSchema.parse(c.req.query());
    const scope = searchSchema.shape.scope.parse(c.req.query('scope')) ??
      (c.req.param('wid') ? 'all' : 'project');
    if (scope === 'project' && !projectId) {
      throw httpError(400, 'project_required', 'Project search requires a project ID');
    }
    if (projectId && !(await repositories.projects.findByIdAndWorkspace(projectId, c.get('workspaceId')))) {
      throw httpError(404, 'not_found', 'Project not found');
    }
    const trimmedQ = q.trim();
    if (!trimmedQ) return c.json([]);
    return c.json(
      await search.search({
        workspaceId: c.get('workspaceId'),
        projectId: scope === 'project' ? projectId : undefined,
        text: trimmedQ,
        limit: 25,
      }),
    );
  };

  const suggest = async (c: import('hono').Context<Env>) => {
    const { type, q, projectId } = suggestSchema.parse(c.req.query());
    if (
      projectId &&
      !(await repositories.projects.findByIdAndWorkspace(projectId, c.get('workspaceId')))
    ) {
      return c.json([]);
    }
    const searchPattern = q.trim();
    if (type === 'user') {
      const rows = await repositories.members.findByPattern(c.get('workspaceId'), searchPattern, 8);
      return c.json(
        rows.map((row) => ({
          id: row.userId,
          label: row.name,
          description: row.email,
          image: row.image,
          kind: 'user' as const,
        })),
      );
    }
    if (!projectId) return c.json([]);
    if (type === 'notepad') {
      const rows = await repositories.notepads.findByPattern(
        { workspaceId: c.get('workspaceId'), projectId },
        searchPattern,
        8,
      );
      return c.json(rows.map((row) => ({ id: row.id, label: row.title, icon: row.icon, kind: 'notepad' as const })));
    }
    if (type === 'card') {
      const rows = await repositories.cards.findByPattern(
        { workspaceId: c.get('workspaceId'), projectId },
        searchPattern,
        8,
      );
      return c.json(
        rows.map((row) => ({
          id: row.id,
          label: row.title,
          description: row.boardName,
          priority: row.priority,
          kind: 'card' as const,
        })),
      );
    }
    const rows = await repositories.tags.findByPattern(
      { workspaceId: c.get('workspaceId'), projectId },
      searchPattern,
      8,
    );
    return c.json(rows.map((row) => ({ id: row.id, label: row.name, color: row.color, kind: 'tag' as const })));
  };

  return new Hono<Env>()
    .get('/workspaces/:wid/my-tasks', explicitWorkspace, myTasks)
    .get('/workspaces/:wid/notifications', explicitWorkspace, notificationList)
    .post('/workspaces/:wid/notifications/read', explicitWorkspace, markNotificationsRead)
    .get('/workspaces/:wid/search', explicitWorkspace, workspaceSearch)
    .get('/workspaces/:wid/suggest', explicitWorkspace, suggest);
}
