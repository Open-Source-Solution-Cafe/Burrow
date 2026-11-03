import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Env } from '../app';
import type { IMemberRepository, IWorkspaceRepository } from '../infrastructure/types';
import type { IEmailProvider } from '../adapters/email';
import type { MemberService } from '../services/members';
import type { InviteService } from '../services/invites';
import { createWorkspacePlan } from '../entities/workspace';
import { createExplicitWorkspaceMiddleware, requireRole } from '../middleware/session';
import { inviteEmail } from '../services/email-templates';
import { forbidden } from '../services/errors';

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{12,80}$/),
});
const renameWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
const createInviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['editor', 'viewer']),
});
const updateRoleSchema = z.object({ role: z.enum(['owner', 'editor', 'viewer']) });

export function createWorkspaceRoutes(args: {
  workspaces: IWorkspaceRepository;
  members: IMemberRepository;
  memberService: MemberService;
  invites: InviteService;
  email: IEmailProvider;
  appUrl?: string;
}) {
  const { workspaces, members, memberService, invites } = args;
  const explicitWorkspace = createExplicitWorkspaceMiddleware(members);
  const route = new Hono<Env>();

  route.get('/', async (c) => {
    const identity = c.get('identity');
    if (!identity) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
    c.header('Cache-Control', 'private, no-store');
    return c.json(await workspaces.listByUser(identity.userId));
  });

  route.post('/', zValidator('json', createWorkspaceSchema), async (c) => {
    const identity = c.get('identity');
    if (!identity) return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
    const { name, requestId } = c.req.valid('json');
    const userPrefix = `${identity.userId.slice(0, 8)}-`;
    const workspaceId =
      requestId.startsWith(userPrefix) || requestId.startsWith('workspace-')
        ? requestId
        : `${userPrefix}${requestId}`;
    // The stable client key becomes the workspace ID so a retried POST replays the same plan.
    const plan = createWorkspacePlan({
      userId: identity.userId,
      name,
      workspaceId,
      projectId: `${workspaceId}-project`,
      notepadId: `${workspaceId}-welcome`,
      now: Date.now(),
    });
    const workspace = await workspaces.create(plan);
    return c.json({ workspace, project: plan.project }, 201);
  });

  route.get('/:wid', explicitWorkspace, async (c) => {
    const workspace = await workspaces.findById(c.get('workspaceId'));
    if (!workspace) return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404);
    return c.json({ workspace, role: c.get('role') });
  });

  route.patch('/:wid', explicitWorkspace, requireRole('owner'), zValidator('json', renameWorkspaceSchema), async (c) => {
    const renamed = await workspaces.rename(c.get('workspaceId'), c.get('userId'), c.req.valid('json').name);
    if (!renamed) throw forbidden('forbidden', 'Workspace owner access changed');
    return c.json({ ok: true, workspaceId: c.get('workspaceId') });
  });

  route.post('/:wid/leave', explicitWorkspace, async (c) => {
    await memberService.removeMember({
      workspaceId: c.get('workspaceId'),
      actorUserId: c.get('userId'),
      targetUserId: c.get('userId'),
    });
    return c.json({ ok: true, workspaceId: c.get('workspaceId') });
  });

  route.get('/:wid/members', explicitWorkspace, async (c) =>
    c.json(await memberService.listMembers(c.get('workspaceId'))),
  );

  route.patch('/:wid/members/:userId', explicitWorkspace, requireRole('owner'), zValidator('json', updateRoleSchema), async (c) => {
    const targetUserId = c.req.param('userId');
    const { role } = c.req.valid('json');
    await memberService.changeRole({
      workspaceId: c.get('workspaceId'),
      actorUserId: c.get('userId'),
      targetUserId,
      newRole: role,
    });
    return c.json({ ok: true, userId: targetUserId, role });
  });

  route.delete('/:wid/members/:userId', explicitWorkspace, requireRole('owner'), async (c) => {
    const targetUserId = c.req.param('userId');
    await memberService.removeMember({
      workspaceId: c.get('workspaceId'),
      actorUserId: c.get('userId'),
      targetUserId,
    });
    return c.json({ ok: true, removedUserId: targetUserId });
  });

  route.get('/:wid/invites', explicitWorkspace, requireRole('owner'), async (c) => {
    const pending = await invites.listPendingInvites(c.get('workspaceId'));
    return c.json(pending.map(({ tokenHash: _tokenHash, ...rest }) => rest));
  });

  route.post('/:wid/invites', explicitWorkspace, requireRole('owner'), zValidator('json', createInviteSchema), async (c) => {
    const workspaceId = c.get('workspaceId');
    const userId = c.get('userId');
    const { email, role } = c.req.valid('json');
    const result = await invites.createInvite(workspaceId, userId, email, role);
    const baseOrigin = args.appUrl ? new URL(args.appUrl).origin : new URL(c.req.url).origin;
    const inviteUrl = `${baseOrigin}/invite/${result.token}`;
    const sendPromise = (async () => {
      const [workspace, inviter] = await Promise.all([
        workspaces.findById(workspaceId),
        members.findByUserId(workspaceId, userId),
      ]);
      return args.email.send({ to: email, ...inviteEmail(inviter?.name, workspace?.name, inviteUrl) });
    })().catch((error) => console.error('[email] invite send failed:', error));
    try {
      c.executionCtx.waitUntil(sendPromise);
    } catch {
      // Node tests and local requests may not provide an ExecutionContext.
    }
    return c.json({
      id: result.invite.id,
      email,
      role,
      token: result.token,
      expiresAt: result.invite.expiresAt,
      url: inviteUrl,
    });
  });

  route.delete('/:wid/invites/:id', explicitWorkspace, requireRole('owner'), async (c) => {
    const id = c.req.param('id');
    await invites.deleteInvite(c.get('workspaceId'), id);
    return c.json({ ok: true, id });
  });

  return route;
}

