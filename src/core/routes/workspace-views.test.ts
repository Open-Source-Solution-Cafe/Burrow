import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import type { Env } from '../app';
import type { Infrastructure, RepositoryContainer } from '../infrastructure/types';
import { isHttpError } from '../services/errors';
import { createWorkspaceViewRoutes } from './workspace-views';

it('uses explicit membership scope for search, tasks and notifications', async () => {
  const members = {
    findByUserId: vi.fn().mockImplementation(async (workspaceId: string, userId: string) =>
      workspaceId === 'workspace-a' && userId === 'account-a'
        ? { workspaceId, userId, role: 'owner', joinedAt: 1 }
        : null,
    ),
  };
  const projects = {
    findByIdAndWorkspace: vi.fn().mockResolvedValue(null),
  };
  const repositories = {
    members,
    projects,
    notepads: { findByPattern: vi.fn().mockResolvedValue([]) },
    cards: { findByPattern: vi.fn().mockResolvedValue([]) },
    tags: { findByPattern: vi.fn().mockResolvedValue([]) },
  } as unknown as Pick<RepositoryContainer, 'projects' | 'members' | 'notepads' | 'cards' | 'tags'>;
  const cards = { getMyTasks: vi.fn().mockResolvedValue([]) } as unknown as Parameters<
    typeof createWorkspaceViewRoutes
  >[0]['cards'];
  const notifications = {
    listByUser: vi.fn().mockResolvedValue([
      {
        id: 'notification-a',
        workspaceId: 'workspace-a',
        userId: 'account-a',
        type: 'mention',
        actorId: 'actor-a',
        actorName: 'Actor A',
        actorImage: null,
        targetTitle: 'Note A',
        notepadId: 'note-a',
        cardId: null,
        readAt: null,
        createdAt: 1,
      },
    ]),
    markAllRead: vi.fn(),
    markRead: vi.fn(),
    createMentions: vi.fn(),
    createAssignments: vi.fn(),
  };
  const search = { search: vi.fn().mockResolvedValue([{ id: 'note-a', projectId: 'project-a' }]) } as unknown as Infrastructure['search'];
  const routes = createWorkspaceViewRoutes({ repositories, cards, notifications, search });
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    if (c.req.header('X-Account') === 'account-a') {
      c.set('identity', { userId: 'account-a' });
    }
    await next();
  });
  app.onError((error, c) =>
    isHttpError(error)
      ? c.json({ error: { code: error.code, message: error.message } }, error.status as 404)
      : c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500),
  );
  app.route('/api', routes);

  const headers = { 'X-Account': 'account-a' };
  const searchResponse = await app.request('/api/workspaces/workspace-a/search?q=needle', { headers });
  expect(searchResponse.status).toBe(200);
  expect(await searchResponse.json()).toEqual([{ id: 'note-a', projectId: 'project-a' }]);
  expect(search.search).toHaveBeenCalledWith({
    workspaceId: 'workspace-a',
    projectId: undefined,
    text: 'needle',
    limit: 25,
  });

  const foreignProject = await app.request(
    '/api/workspaces/workspace-a/search?q=needle&scope=project&projectId=project-b',
    { headers },
  );
  expect(foreignProject.status).toBe(404);
  expect(search.search).toHaveBeenCalledTimes(1);

  const tasks = await app.request('/api/workspaces/workspace-a/my-tasks?status=open', { headers });
  expect(tasks.status).toBe(200);
  expect(cards.getMyTasks).toHaveBeenCalledWith('workspace-a', 'account-a', {
    status: 'open',
    projectId: undefined,
  });

  const notificationResponse = await app.request(
    '/api/workspaces/workspace-a/notifications?unread=1',
    { headers },
  );
  expect(notificationResponse.status).toBe(200);
  expect(notifications.listByUser).toHaveBeenCalledWith('account-a', 'workspace-a', true);
  expect(await notificationResponse.json()).toMatchObject([
    { id: 'notification-a', actor: { id: 'actor-a', name: 'Actor A', image: null }, targetTitle: 'Note A' },
  ]);
  expect((await app.request('/api/workspaces/workspace-b/my-tasks', { headers })).status).toBe(404);
});
