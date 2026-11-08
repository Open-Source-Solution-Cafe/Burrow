import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
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
import { createSystemRoutes } from './routes/system';
import { type AccessPolicy, SelfHostedPolicy } from './policy';

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
export function createCoreApp(
  infra: Infrastructure,
  options: { policy?: AccessPolicy } = {},
) {
  const policy = options.policy ?? new SelfHostedPolicy();
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
    policy,
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
  const invites = new InviteService(
    {
      invites: repositories.invites,
      members: repositories.members,
      workspaces: repositories.workspaces,
    },
    policy,
  );
  const workspaceRoutes = createWorkspaceRoutes({
    workspaces: repositories.workspaces,
    members: repositories.members,
    memberService: members,
    invites,
    email: emailProvider,
    appUrl: infra.appUrl,
    policy,
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
    policy,
  });
  const systemRoutes = createSystemRoutes({
    policy,
    workspaces: repositories.workspaces,
    env: infra.env,
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
      .get('/api/ready', (c) => c.json({ ready: true, now: Date.now() }))
      .get('/api/auth/config', (c) => {
        const env = (infra.env ?? (typeof process !== 'undefined' ? process.env : {})) ?? {};
        const magicLinkEnabled = Boolean(
          (infra.email && infra.email.provider !== 'console') || env.RESEND_API_KEY,
        );
        c.header('Cache-Control', 'no-store');
        return c.json({
          signupMode: policy.signupMode(),
          emailPasswordEnabled: true,
          magicLinkEnabled,
          oauthProviders: [
            ...(env.GOOGLE_CLIENT_ID ? [{ id: 'google', name: 'Google', kind: 'social' as const }] : []),
            ...(env.GITHUB_CLIENT_ID ? [{ id: 'github', name: 'GitHub', kind: 'social' as const }] : []),
          ],
        });
      })

      .get('/api/account', async (c) => {
        const identity = c.get('identity');
        if (!identity) {
          return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
        }
        let workspaces = await repositories.workspaces.listByUser(identity.userId);
        if (workspaces.length === 0 && policy.signupMode() === 'open') {
          await policy.authorize({ action: 'workspace.create', userId: identity.userId });
          await repositories.workspaces.create(
            createWorkspacePlan({
              userId: identity.userId,
              name: 'My Workspace',
              workspaceId: nanoid(),
              projectId: nanoid(),
              notepadId: nanoid(),
              now: Date.now(),
            }),
          );
          workspaces = await repositories.workspaces.listByUser(identity.userId);
        }
        c.header('Cache-Control', 'private, no-store');
        return c.json({
          user: {
            id: identity.userId,
            name: identity.name ?? '',
            email: identity.email ?? '',
            image: identity.image ?? null,
          },
          workspaces,
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
      .route('/api/system', systemRoutes)
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

        const forwardToAuth = async () => {
          const { bootstrapToken: _b, inviteToken: _i, ...betterAuthBody } = body;
          const forwardReq = new Request(c.req.url, {
            method: 'POST',
            headers: c.req.raw.headers,
            body: JSON.stringify(betterAuthBody),
          });
          return auth.handler(forwardReq);
        };

        if (inviteToken && typeof inviteToken === 'string') {
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

          const authRes = await forwardToAuth();
          if (!authRes.ok) {
            return authRes;
          }

          const authData = (await authRes.clone().json()) as { user?: { id: string } };
          const userId = authData.user?.id;
          if (!userId) {
            throw httpError(500, 'signup_incomplete', 'Account creation could not be completed');
          }

          await invites.acceptInvite(userId, inviteToken);
          return authRes;
        }

        if (policy.signupMode() === 'open') {
          const authRes = await forwardToAuth();
          if (!authRes.ok) {
            return authRes;
          }

          const authData = (await authRes.clone().json()) as { user?: { id: string } };
          const userId = authData.user?.id;
          if (!userId) {
            throw httpError(500, 'signup_incomplete', 'Account creation could not be completed');
          }

          await policy.authorize({ action: 'workspace.create', userId });

          await repositories.workspaces.create(
            createWorkspacePlan({
              userId,
              name: 'My Workspace',
              workspaceId: nanoid(),
              projectId: nanoid(),
              notepadId: nanoid(),
              now: Date.now(),
            }),
          );

          return authRes;
        }

        // policy.signupMode() === 'bootstrap-or-invite'
        const workspaceCount = await repositories.workspaces.count();
        const isFirstWorkspace = workspaceCount === 0;

        if (!isFirstWorkspace) {
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

        const authRes = await forwardToAuth();
        if (!authRes.ok) {
          await repositories.workspaces.releaseBootstrap?.(body.email.trim().toLowerCase());
          return authRes;
        }

        const authData = (await authRes.clone().json()) as { user?: { id: string } };
        const userId = authData.user?.id;
        if (!userId) {
          throw httpError(500, 'signup_incomplete', 'Account creation could not be completed');
        }

        const workspace = await repositories.workspaces.completeBootstrap(
          body.email.trim().toLowerCase(),
          createWorkspacePlan({
            userId,
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
        try {
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
        } catch (err: any) {
          if (err && (typeof err.statusCode === 'number' || err.status)) {
            const status = typeof err.statusCode === 'number' ? err.statusCode : 400;
            const message = err.body?.message || err.message || 'Authentication error';
            return c.json({ message, error: message }, status as any);
          }
          throw err;
        }
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
        if (err instanceof HTTPException) {
          return err.res ?? c.json({ error: { code: 'bad_request', message: err.message } }, err.status as any);
        }
        const mapped = policy.mapError?.(err);
        if (mapped) {
          return c.json({ error: { code: mapped.code, message: mapped.message } }, mapped.status as any);
        }
        console.error('unhandled error', err);
        return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
      })

      .notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404))
  );
}

/** RPC types come from the application both runtimes actually serve. */
export type AppType = ReturnType<typeof createCoreApp>;
