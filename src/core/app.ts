import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  maxUploadBytesForRuntime,
  resolveDeploymentRuntime,
} from '../shared/uploadPolicy';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import type { Infrastructure } from './infrastructure/types';
import { runWithAuthRequestContext } from './adapters/auth';
import { RateLimitUnavailableError } from './adapters/rate-limit';
import {
  securityHeaders,
  bodyLimit,
  csrfProtection,
  getBodyLimitExceeded,
  rateLimiter,
  resolveVerifiedClientIp,
} from './middleware/security';
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
import { createFeatureFlagRoutes } from './routes/feature-flags';
import { createWorkspaceExportRoutes } from './routes/workspace-export';
import {
  createShareManagementRoutes,
  createPublicShareViewerRoutes,
} from './routes/public-shares';
import { type AccessPolicy, SelfHostedPolicy } from './policy';

function parseSafeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

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
      storageDeletions: repositories.storageDeletions,
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
      projectFiles: repositories.projectFiles,
      projects: repositories.projects,
      storageDeletions: repositories.storageDeletions,
    },
    locks,
    storage,
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
  const requirePersistentRateLimitStore =
    Boolean(infra.rateLimitStore) || infra.env?.NODE_ENV === 'production';
  const workspaceRoutes = createWorkspaceRoutes({
    workspaces: repositories.workspaces,
    members: repositories.members,
    memberService: members,
    invites,
    email: emailProvider,
    appUrl: infra.appUrl,
    policy,
    rateLimitStore: infra.rateLimitStore,
    env: infra.env,
    requirePersistentRateLimitStore,
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
  const runtime = resolveDeploymentRuntime({
    runtime: infra.runtime,
    env: infra.env,
    databaseUrl: typeof infra.env?.DATABASE_URL === 'string' ? infra.env.DATABASE_URL : undefined,
  });
  const maxUploadBytes = maxUploadBytesForRuntime(runtime);
  const projectFileRoutes = createProjectFileRoutes({
    projects: repositories.projects,
    members: repositories.members,
    files: repositories.projectFiles,
    notepads: repositories.notepads,
    storage,
    policy,
    maxUploadBytes,
  });
  const systemRoutes = createSystemRoutes({
    policy,
    workspaces: repositories.workspaces,
    env: infra.env,
    runtime,
    maxUploadBytes,
  });
  const featureFlagRoutes = createFeatureFlagRoutes({
    workspaces: repositories.workspaces,
    members: repositories.members,
    policy,
    env: infra.env,
  });
  const workspaceExportRoutes = createWorkspaceExportRoutes({
    repositories,
    storage,
    policy,
    env: infra.env,
  });
  const shareManagementRoutes = createShareManagementRoutes({
    repositories,
    policy,
    env: infra.env,
  });
  const publicShareViewerRoutes = createPublicShareViewerRoutes({
    repositories,
    storage,
    policy,
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
          return bodyLimit(maxUploadBytes + 64 * 1024)(c, next);
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
          privacyPolicyUrl: parseSafeHttpUrl(env.PRIVACY_POLICY_URL),
          termsOfServiceUrl: parseSafeHttpUrl(env.TERMS_OF_SERVICE_URL),
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

      .get(
        '/api/account/export',
        rateLimiter({
          windowMs: 60_000,
          maxRequests: 10,
          prefix: 'account-export',
          env: infra.env,
          store: infra.rateLimitStore,
          requireStore: requirePersistentRateLimitStore,
          keyResolver: (c) => {
            const uid = c.get('identity')?.userId;
            if (uid) return `user:${uid}`;
            const ip = resolveVerifiedClientIp(c, { env: infra.env });
            return ip ? `ip:${ip}` : 'unverified';
          },
        }),
        async (c) => {
          const identity = c.get('identity');
          if (!identity) {
            return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401);
          }

          const requestedWorkspaceId = c.req.query('workspaceId')?.trim() || null;
          const allWorkspaces = await repositories.workspaces.listByUser(identity.userId);
          const workspaceNameById = new Map(allWorkspaces.map((ws) => [ws.id, ws.name]));

          if (requestedWorkspaceId && !workspaceNameById.has(requestedWorkspaceId)) {
            return c.json(
              { error: { code: 'not_found', message: 'Workspace not found' } },
              404,
            );
          }

          const targetWorkspaces = requestedWorkspaceId
            ? allWorkspaces.filter((ws) => ws.id === requestedWorkspaceId)
            : allWorkspaces;

          const assignedTasksByWs = await Promise.all(
            targetWorkspaces.map(async (ws) => {
              const items = repositories.cards.getMyTasks
                ? await repositories.cards.getMyTasks(ws.id, identity.userId, { status: 'all' })
                : [];
              return items.map((item) => ({
                ...item,
                workspaceId: ws.id,
                workspaceName: ws.name,
              }));
            }),
          );
          const notificationsByWs = await Promise.all(
            targetWorkspaces.map(async (ws) => {
              const items = repositories.notifications.listByUser
                ? await repositories.notifications.listByUser(identity.userId, ws.id, false)
                : [];
              return items.map((item) => ({
                ...item,
                workspaceName: ws.name,
              }));
            }),
          );
          const rawComments = repositories.cards.listCommentsByUser
            ? await repositories.cards.listCommentsByUser(identity.userId)
            : [];

          const scopedComments = requestedWorkspaceId
            ? rawComments
                .filter((comment) => comment.workspaceId === requestedWorkspaceId)
                .map((comment) => ({
                  ...comment,
                  workspaceName: workspaceNameById.get(comment.workspaceId) ?? null,
                  formerWorkspace: false,
                }))
            : rawComments.map((comment) => {
                const activeWorkspaceName = workspaceNameById.get(comment.workspaceId);
                if (activeWorkspaceName !== undefined) {
                  return {
                    ...comment,
                    workspaceName: activeWorkspaceName,
                    formerWorkspace: false,
                  };
                }
                // User is no longer a member of this workspace: retain authored words for GDPR Art. 15
                // while redacting internal workspace/project/card identifiers.
                return {
                  id: comment.id,
                  cardId: null,
                  workspaceId: null,
                  workspaceName: null,
                  projectId: null,
                  content: comment.content,
                  createdAt: comment.createdAt,
                  updatedAt: comment.updatedAt,
                  formerWorkspace: true,
                };
              });

          c.header('Cache-Control', 'private, no-store');
          if (c.req.query('download') === '1') {
            const dateSlug = new Date().toISOString().slice(0, 10);
            if (requestedWorkspaceId) {
              const rawName = workspaceNameById.get(requestedWorkspaceId) ?? 'workspace';
              const safeSlug =
                rawName
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 40) || 'workspace';
              c.header(
                'Content-Disposition',
                `attachment; filename="burrow-personal-data-${safeSlug}-${dateSlug}.json"`,
              );
            } else {
              c.header(
                'Content-Disposition',
                `attachment; filename="burrow-personal-data-${dateSlug}.json"`,
              );
            }
          }

          return c.json({
            schemaVersion: 'burrow-personal-export-v1',
            exportedAt: Date.now(),
            scope: requestedWorkspaceId
              ? {
                  type: 'workspace' as const,
                  workspaceId: requestedWorkspaceId,
                  workspaceName: workspaceNameById.get(requestedWorkspaceId) ?? null,
                }
              : { type: 'all-workspaces' as const },
            user: {
              id: identity.userId,
              name: identity.name ?? '',
              email: identity.email ?? '',
              image: identity.image ?? null,
            },
            workspaces: targetWorkspaces,
            assignedTasks: assignedTasksByWs.flat(),
            comments: scopedComments,
            notifications: notificationsByWs.flat(),
          });
        },
      )

      .get(
        '/api/invites/info/:token',
        rateLimiter({
          windowMs: 60_000,
          maxRequests: 30,
          prefix: 'invites-info',
          env: infra.env,
          store: infra.rateLimitStore,
          requireStore: requirePersistentRateLimitStore,
        }),
        async (c) => {
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
        },
      )

      .post(
        '/api/invites/accept',
        rateLimiter({
          windowMs: 60_000,
          maxRequests: 20,
          prefix: 'invites-accept',
          env: infra.env,
          store: infra.rateLimitStore,
          requireStore: requirePersistentRateLimitStore,
          keyResolver: (c) => {
            const uid = c.get('identity')?.userId;
            if (uid) return `user:${uid}`;
            const ip = resolveVerifiedClientIp(c, { env: infra.env });
            return ip ? `ip:${ip}` : 'unverified';
          },
        }),
        zValidator('json', inviteTokenSchema),
        async (c) => {
          const identity = c.get('identity');
          if (!identity) throw httpError(401, 'unauthorized', 'Authentication required');
          const result = await invites.acceptInvite(identity.userId, c.req.valid('json').token);
          return c.json({ ok: true, ...result });
        },
      )

      .route('/api/workspaces', workspaceRoutes)
      .route('/api/workspaces', featureFlagRoutes)
      .route('/api/workspaces', workspaceExportRoutes)
      .route('/api/workspaces/:wid/projects', projectRoutes)
      .route('/api/system', systemRoutes)
      .route('/api', workspaceViewRoutes)
      .route('/api', projectResourceRoutes)
      .route('/api', projectFileRoutes)
      .route('/api', shareManagementRoutes)
      .route('/api/public/shares', publicShareViewerRoutes)
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

      .post(
        '/api/auth/sign-up/email',
        rateLimiter({
          windowMs: 60_000,
          maxRequests: 25,
          prefix: 'signup-ip',
          env: infra.env,
          store: infra.rateLimitStore,
          requireStore: requirePersistentRateLimitStore,
        }),
        zValidator('json', signUpSchema),
        async (c) => {
          const body = c.req.valid('json');
          if (infra.rateLimitStore || requirePersistentRateLimitStore) {
            if (!infra.rateLimitStore) {
              throw httpError(
                503,
                'service_unavailable',
                'Rate limiting service is temporarily unavailable',
              );
            }
            const emailHash = (await hashToken(body.email.trim().toLowerCase())).slice(0, 24);
            let emailLimit;
            try {
              emailLimit = await infra.rateLimitStore.consume(`signup-acct:${emailHash}`, 10_000, 3);
            } catch (error) {
              if (error instanceof RateLimitUnavailableError) {
                throw httpError(503, 'service_unavailable', error.message);
              }
              throw error;
            }
            if (!emailLimit.allowed) {
              c.header('Retry-After', String(emailLimit.retryAfterSeconds));
              return c.json(
                {
                  error: {
                    code: 'rate_limit_exceeded',
                    message: 'Too many requests, please try again later.',
                  },
                },
                429,
              );
            }
          }
          const providedBootstrapToken = body.bootstrapToken;
          const inviteToken = body.inviteToken;

        const forwardToAuth = async () => {
          const { bootstrapToken: _b, inviteToken: _i, ...betterAuthBody } = body;
          const verifiedIp = resolveVerifiedClientIp(c, { env: infra.env });
          const headers = new Headers(c.req.raw.headers);
          headers.delete('x-burrow-client-ip');
          if (verifiedIp) {
            headers.set('x-burrow-client-ip', verifiedIp);
          }
          const forwardReq = new Request(c.req.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(betterAuthBody),
          });
          return runWithAuthRequestContext(
            { verifiedIp, accountKey: null, sessionKey: null },
            () => auth.handler(forwardReq),
          );
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
        rateLimiter({
          windowMs: 60_000,
          maxRequests: 15,
          prefix: 'bootstrap-recover',
          env: infra.env,
          store: infra.rateLimitStore,
          requireStore: requirePersistentRateLimitStore,
        }),
        zValidator(
          'json',
          z.object({
            bootstrapToken: z.string(),
            resetClaim: z.boolean().optional(),
            confirmEmail: z.string().email().optional(),
          }),
        ),
        async (c) => {
          const identity = c.get('identity');
          const { bootstrapToken: providedToken, resetClaim, confirmEmail } = c.req.valid('json');
          if (
            !bootstrapToken ||
            bootstrapToken.length < 16 ||
            !(await timingSafeEqualString(providedToken, bootstrapToken))
          ) {
            throw httpError(403, 'invalid_bootstrap_token', 'Valid bootstrap token required');
          }

          if (resetClaim) {
            const didReset = await repositories.workspaces.resetBootstrapClaim?.(confirmEmail);
            if (!didReset) {
              throw httpError(
                409,
                'bootstrap_unavailable',
                'No pending bootstrap claim can be reset',
              );
            }
            return c.json({ ok: true, reset: true });
          }

          if (!identity?.email) throw httpError(401, 'unauthorized', 'Authentication required');
          const normalizedEmail = identity.email.trim().toLowerCase();
          if (confirmEmail && confirmEmail.trim().toLowerCase() !== normalizedEmail) {
            throw httpError(
              400,
              'email_mismatch',
              'Authenticated session email does not match confirmEmail',
            );
          }

          const workspace = await repositories.workspaces.completeBootstrap(
            normalizedEmail,
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
        const verifiedIp = resolveVerifiedClientIp(c, { env: infra.env });
        const stampedHeaders = new Headers(req.headers);
        stampedHeaders.delete('x-burrow-client-ip');
        if (verifiedIp) {
          stampedHeaders.set('x-burrow-client-ip', verifiedIp);
        }
        const contentType = req.headers.get('content-type') || '';
        const dispatch = (forwarded: Request) =>
          runWithAuthRequestContext(
            { verifiedIp, accountKey: null, sessionKey: null },
            () => auth.handler(forwarded),
          );
        let res: Response;
        try {
          if (
            req.method !== 'GET' &&
            req.method !== 'HEAD' &&
            contentType.includes('application/json')
          ) {
            if (req.headers.get('content-length') === '0') {
              const fixedReq = new Request(req.url, {
                method: req.method,
                headers: stampedHeaders,
                body: JSON.stringify({}),
                duplex: 'half',
              } as RequestInit);
              res = await dispatch(fixedReq);
            } else {
              const cloned = req.clone();
              const text = await cloned.text();
              if (!text || text.trim() === '') {
                const fixedReq = new Request(req.url, {
                  method: req.method,
                  headers: stampedHeaders,
                  body: JSON.stringify({}),
                  duplex: 'half',
                } as RequestInit);
                res = await dispatch(fixedReq);
              } else {
                const stampedReq = new Request(req.url, {
                  method: req.method,
                  headers: stampedHeaders,
                  body: text,
                });
                res = await dispatch(stampedReq);
              }
            }
          } else {
            const stampedReq = new Request(req, { headers: stampedHeaders });
            res = await dispatch(stampedReq);
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
        const exceededLimit = getBodyLimitExceeded(c);
        if (exceededLimit !== null) {
          return c.json(
            {
              error: {
                code: 'payload_too_large',
                message: `Request body exceeds limit of ${exceededLimit} bytes`,
              },
            },
            413,
          );
        }
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
