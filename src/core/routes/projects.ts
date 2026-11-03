import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Env } from '../app';
import type { IMemberRepository } from '../infrastructure/types';
import type { ProjectService } from '../services/projects';
import {
  createExplicitWorkspaceMiddleware,
  requireRole,
} from '../middleware/session';

const createProjectSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  icon: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  archived: z.boolean().optional(),
});

const moveProjectSchema = z.object({
  afterId: z.string().optional().nullable(),
});

/** Project operations require an explicit workspace route. */
export function createProjectRoutes(
  projects: ProjectService,
  members: IMemberRepository,
) {
  const explicitWorkspace = createExplicitWorkspaceMiddleware(members);

  return new Hono<Env>()
    .get('/', explicitWorkspace, async (c) =>
      c.json(await projects.listProjects(c.get('workspaceId'))),
    )
    .post(
      '/',
      explicitWorkspace,
      requireRole('editor'),
      zValidator('json', createProjectSchema),
      async (c) => {
        const { name, icon, color } = c.req.valid('json');
        const result = await projects.createProject({
          workspaceId: c.get('workspaceId'),
          actorUserId: c.get('userId'),
          name,
          icon,
          color,
        });
        return c.json(result, 201);
      },
    )
    .patch(
      '/:id',
      explicitWorkspace,
      requireRole('editor'),
      zValidator('json', updateProjectSchema),
      async (c) => {
        const projectId = c.req.param('id');
        const { name, icon, color, archived } = c.req.valid('json');
        await projects.updateProject({
          workspaceId: c.get('workspaceId'),
          actorUserId: c.get('userId'),
          projectId,
          name,
          icon,
          color,
          archived,
        });
        return c.json({ ok: true, projectId });
      },
    )
    .post(
      '/:id/move',
      explicitWorkspace,
      requireRole('editor'),
      zValidator('json', moveProjectSchema),
      async (c) => {
        const projectId = c.req.param('id');
        const { afterId } = c.req.valid('json');
        const result = await projects.moveProject({
          workspaceId: c.get('workspaceId'),
          actorUserId: c.get('userId'),
          projectId,
          afterId,
        });
        return c.json({ ok: true, projectId, position: result.position });
      },
    );
}
