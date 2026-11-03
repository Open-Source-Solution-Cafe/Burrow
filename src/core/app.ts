import { Hono } from 'hono';
import { MAX_UPLOAD_BYTES } from '../shared/uploadPolicy';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Infrastructure } from './infrastructure/types';
import { securityHeaders, bodyLimit, csrfProtection } from './middleware/security';
import {
  createIdentityMiddleware,
  createExplicitWorkspaceMiddleware,
  requireRole,
} from './middleware/session';
import { httpError, isHttpError } from './services/errors';
import { ProjectService } from './services/projects';
import { NotepadService } from './services/notepads';
import { BoardService } from './services/boards';
import { CardService } from './services/cards';
import { MemberService } from './services/members';
import { CommentService } from './services/comments';
import { TagService } from './services/tags';
import { InviteService } from './services/invites';
import { nanoid } from 'nanoid';
import { hashToken, timingSafeEqualString } from './shared/crypto';
import { createWorkspacePlan } from './entities/workspace';
import { createProjectRoutes } from './routes/projects';
import { createWorkspaceRoutes } from './routes/workspaces';
import { createProjectResourceRoutes } from './routes/project-resources';
import { createWorkspaceViewRoutes } from './routes/workspace-views';
import { createProjectFileRoutes } from './routes/project-files';

// Type for Hono context with our custom variables
export interface Env {
  Variables: {
    identity: { userId: string; email?: string; name?: string; image?: string | null };
    userId: string;
    workspaceId: string;
    role: 'owner' | 'editor' | 'viewer';
  };
}

/**
 * Create the core Hono app with all routes registered.
 * This factory can be called from both Worker and Node entrypoints.
 */
export function createCoreApp(infra: Infrastructure) {
  const {
    repositories,
    storage,
    search,
    locks,
    auth,
    email: emailProvider,
    bootstrapToken,
  } = infra;
  const projects = new ProjectService(
    {
      projects: repositories.projects,
      notepads: repositories.notepads,
      projectFiles: repositories.projectFiles,
      members: repositories.members,
    },
    storage,
  );
  const projectRoutes = createProjectRoutes(projects, repositories.members);
  const notepads = new NotepadService(
    {
      notepads: repositories.notepads,
      tags: repositories.tags,
      members: repositories.members,
    },
    locks,
  );
  const boards = new BoardService({
    boards: repositories.boards,
    cards: repositories.cards,
    projects: repositories.projects,
  });
  const cards = new CardService({
    cards: repositories.cards,
    notepads: repositories.notepads,
    tags: repositories.tags,
    boards: repositories.boards,
    notifications: repositories.notifications,
  });
  const members = new MemberService({ members: repositories.members });
  const comments = new CommentService({
    cards: repositories.cards,
    notepads: repositories.notepads,
    members: repositories.members,
    notifications: repositories.notifications,
  });
  const notifications = repositories.notifications;
  const tags = new TagService({ tags: repositories.tags });
  const invites = new InviteService({
    invites: repositories.invites,
    members: repositories.members,
    workspaces: repositories.workspaces,
  });
  const workspaceRoutes = createWorkspaceRoutes({
    workspaces: repositories.workspaces,
    members: repositories.members,
    memberService: members,
    invites,
    email: emailProvider,
    appUrl: infra.appUrl,
  });
  const projectResourceRoutes = createProjectResourceRoutes({
    repositories,
    notepads,
    boards,
    cards,
    comments,
    tags,
    search,
  });
  const workspaceViewRoutes = createWorkspaceViewRoutes({
    repositories,
    cards,
    notifications,
    search,
  });
  const projectFileRoutes = createProjectFileRoutes({
    projects: repositories.projects,
    members: repositories.members,
    files: repositories.projectFiles,
    storage,
  });

  const signUpSchema = z.object({
    email: z.string().email().max(254),
    password: z.string().min(8).max(128),
    name: z.string().min(1).max(100),
    bootstrapToken: z.string().max(256).optional(),
    inviteToken: z.string().max(256).optional(),
  });
  const inviteTokenSchema = z.object({ token: z.string().min(1) });

  const deleteProjectQuerySchema = z.object({ confirm: z.string().min(1) });

  // Build the app
  return (
    new Hono<Env>()
      .use('*', securityHeaders)
      .use('/api/*', (c, next) => {
        if (c.req.method === 'POST' && c.req.path.endsWith('/uploads')) {
          return bodyLimit(MAX_UPLOAD_BYTES + 1024 * 1024)(c, next);
        }
        return bodyLimit()(c, next);
      })
      .use('/api/*', csrfProtection)
      .use('/api/*', createIdentityMiddleware(auth))
      .get('/api/health', (c) => c.json({ ok: true, now: Date.now() }))

      .get('/api/account', async (c) => {
        const identity = c.get('identity');
        if (!identity) {
          return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
        }
        c.header('Cache-Control', 'private, no-store');
        return c.json({
          user: {
            id: identity.userId,
            name: identity.name ?? '',
            email: identity.email ?? '',
            image: identity.image ?? null,
          },
          workspaces: await repositories.workspaces.listByUser(identity.userId),
        });
      })

      .get('/api/invites/info/:token', async (c) => {
        const token = c.req.param('token');
        const invite = await invites.getInviteInfo(token);
        c.header('Cache-Control', 'private, no-store');
        return c.json({
          valid: true,
          token,
          email: invite.email,
          role: invite.role,
          workspaceId: invite.workspaceId,
          workspaceName: invite.workspaceName,
          userExists: invite.userExists,
          expiresAt: invite.expiresAt,
        });
      })

      .post('/api/invites/accept', zValidator('json', inviteTokenSchema), async (c) => {
        const identity = c.get('identity');
        if (!identity) throw httpError(401, 'unauthorized', 'Authentication required');
        const result = await invites.acceptInvite(identity.userId, c.req.valid('json').token);
        return c.json({ ok: true, ...result });
      })

      .route('/api/workspaces', workspaceRoutes)
      .route('/api/workspaces/:wid/projects', projectRoutes)
      .route('/api', workspaceViewRoutes)
      .route('/api', projectResourceRoutes)
      .route('/api', projectFileRoutes)
      .delete('/api/workspaces/:wid/projects/:id', createExplicitWorkspaceMiddleware(repositories.members), requireRole('owner'), zValidator('query', deleteProjectQuerySchema), async (c) => {
        await projects.permanentDeleteProject({
          workspaceId: c.get('workspaceId'),
          actorUserId: c.get('userId'),
          projectId: c.req.param('id'),
          confirmName: c.req.valid('query').confirm,
        });
        return c.json({ ok: true, deletedId: c.req.param('id') });
      })

      // ---------------------------------------------------------------------------
      // Auth routes: custom bootstrap sign-up, then delegate to auth provider
      // ---------------------------------------------------------------------------

      .post('/api/auth/sign-up/email', zValidator('json', signUpSchema), async (c) => {
        const body = c.req.valid('json');
        const providedBootstrapToken = body.bootstrapToken;
        const inviteToken = body.inviteToken;

        // Check if this is the first workspace
        const workspaceCount = await repositories.workspaces.count();
        const isFirstWorkspace = workspaceCount === 0;

        let inviteToAccept: string | null = null;

        if (isFirstWorkspace) {
          const isTokenValid =
            Boolean(bootstrapToken && bootstrapToken.length >= 16) &&
            typeof providedBootstrapToken === 'string' &&
            (await timingSafeEqualString(providedBootstrapToken, bootstrapToken));

          if (!isTokenValid) {
            return c.json(
              {
                error: {
                  code: 'invalid_bootstrap_token',
                  message: 'Valid bootstrap token required for initial sign-up',
                },
              },
              403,
            );
          }
          if (!(await repositories.workspaces.claimBootstrap(body.email.trim().toLowerCase()))) {
            throw httpError(
              409,
              'bootstrap_unavailable',
              'Bootstrap is already reserved or complete',
            );
          }
        } else {
          if (!inviteToken || typeof inviteToken !== 'string') {
            return c.json(
              {
                error: {
                  code: 'invite_required',
                  message: 'Invite token is required to register',
                },
              },
              403,
            );
          }

          const tokenHash = await hashToken(inviteToken);
          const now = Date.now();
          const invite = await repositories.invites.findByTokenHash(tokenHash);

          if (!invite || invite.acceptedAt !== null || invite.expiresAt <= now) {
            return c.json(
              {
                error: {
                  code: 'invalid_invite',
                  message: 'Invalid or expired invite token',
                },
              },
              403,
            );
          }

          if (body.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
            throw httpError(400, 'email_mismatch', 'Sign-up email does not match invited email');
          }

          inviteToAccept = inviteToken;
        }

        // Forward sanitized request to Better Auth
        const { bootstrapToken: _b, inviteToken: _i, ...betterAuthBody } = body;
        const forwardReq = new Request(c.req.url, {
          method: 'POST',
          headers: c.req.raw.headers,
          body: JSON.stringify(betterAuthBody),
        });

        const authRes = await auth.handler(forwardReq);
        if (!authRes.ok) {
          if (isFirstWorkspace) {
            await repositories.workspaces.releaseBootstrap?.(body.email.trim().toLowerCase());
          }
          return authRes;
        }

        const authData = (await authRes.clone().json()) as { user?: { id: string } };
        const userId = authData.user?.id;
        if (!userId) {
          throw httpError(500, 'signup_incomplete', 'Account creation could not be completed');
        }

        const now = Date.now();

        if (isFirstWorkspace) {
          const workspace = await repositories.workspaces.completeBootstrap(
            body.email.trim().toLowerCase(),
            createWorkspacePlan({
              userId,
              name: 'My Workspace',
              workspaceId: nanoid(),
              projectId: nanoid(),
              notepadId: nanoid(),
              now,
            }),
          );
          if (!workspace) {
            throw httpError(409, 'bootstrap_unavailable', 'Bootstrap could not be completed');
          }
        } else if (inviteToAccept) {
          await invites.acceptInvite(userId, inviteToAccept);
        }

        return authRes;
      })

      .post(
        '/api/auth/bootstrap/recover',
        zValidator('json', z.object({ bootstrapToken: z.string() })),
        async (c) => {
          const identity = c.get('identity');
          if (!identity?.email) throw httpError(401, 'unauthorized', 'Authentication required');
          const { bootstrapToken: providedToken } = c.req.valid('json');
          if (
            !bootstrapToken ||
            bootstrapToken.length < 16 ||
            !(await timingSafeEqualString(providedToken, bootstrapToken))
          ) {
            throw httpError(403, 'invalid_bootstrap_token', 'Valid bootstrap token required');
          }
          const workspace = await repositories.workspaces.completeBootstrap(
            identity.email.trim().toLowerCase(),
            createWorkspacePlan({
              userId: identity.userId,
              name: 'My Workspace',
              workspaceId: nanoid(),
              projectId: nanoid(),
              notepadId: nanoid(),
              now: Date.now(),
            }),
          );
          if (!workspace) {
            throw httpError(409, 'bootstrap_unavailable', 'Bootstrap could not be completed');
          }
          return c.json({ workspaceId: workspace.id });
        },
      )

      // ---------------------------------------------------------------------------
      // Auth routes (delegated to auth provider handler)
      // ---------------------------------------------------------------------------
      .all('/api/auth/*', async (c) => {
        const path = c.req.path.replace(/\/+$/, '');
        if (path === '/api/auth/sign-up/email' || path.startsWith('/api/auth/sign-up')) {
          throw httpError(403, 'forbidden', 'Direct sign-up disabled; use bootstrap or invite');
        }

        // Better-auth attempts to parse JSON body if content-type contains application/json,
        // which throws if the request body is empty. Fall back gracefully to {} if body is empty.
        const req = c.req.raw;
        const contentType = req.headers.get('content-type') || '';
        let res: Response;
        if (
          req.method !== 'GET' &&
          req.method !== 'HEAD' &&
          contentType.includes('application/json')
        ) {
          if (req.headers.get('content-length') === '0') {
            const headers = new Headers(req.headers);
            const fixedReq = new Request(req.url, {
              method: req.method,
              headers,
              body: JSON.stringify({}),
              duplex: 'half',
            } as RequestInit);
            res = await auth.handler(fixedReq);
          } else {
            const cloned = req.clone();
            const text = await cloned.text();
            if (!text || text.trim() === '') {
              const headers = new Headers(req.headers);
              const fixedReq = new Request(req.url, {
                method: req.method,
                headers,
                body: JSON.stringify({}),
                duplex: 'half',
              } as RequestInit);
              res = await auth.handler(fixedReq);
            } else {
              res = await auth.handler(req);
            }
          }
        } else {
          res = await auth.handler(req);
        }

        return res;
      })

      // ---------------------------------------------------------------------------
      // Notifications
      // ---------------------------------------------------------------------------

      // ---------------------------------------------------------------------------
      // Error handling
      // ---------------------------------------------------------------------------
      .onError((err, c) => {
        if (isHttpError(err)) {
          return c.json({ error: { code: err.code, message: err.message } }, err.status as any);
        }
        console.error('unhandled error', err);
        return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
      })

      .notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))
  );
}

/** RPC types come from the application both runtimes actually serve. */
export type AppType = ReturnType<typeof createCoreApp>;
