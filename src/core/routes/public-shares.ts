import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { nanoid } from 'nanoid';
import type { Env } from '../app';
import type { RepositoryContainer } from '../infrastructure/types';
import type { IStorageAdapter } from '../adapters/storage';
import type { AccessPolicy } from '../policy';
import { createExplicitWorkspaceMiddleware, requireRole } from '../middleware/session';
import { httpError } from '../services/errors';
import { validateStorageKey } from '../adapters/storage/validation';
import { requireFeatureFlag, resolveWorkspaceFeatureFlags } from './feature-flags';

const kindParamSchema = z.object({
  wid: z.string().min(1),
  pid: z.string().min(1),
  kind: z.enum(['notepad', 'board']),
  id: z.string().min(1),
});

const createShareBodySchema = z
  .object({
    regenerate: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  })
  .optional();

function extractReferencedStorageKeys(content: string, coverKey?: string | null): Set<string> {
  const keys = new Set<string>();
  if (coverKey) keys.add(coverKey);
  if (!content) return keys;
  const regex = /\/files\/([^"'\s)\\?]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    try {
      const decoded = decodeURIComponent(match[1]!);
      keys.add(decoded);
    } catch {
      // ignore malformed URI sequences
    }
  }
  return keys;
}

function sanitizePublicBlockNoteContent(
  content: string,
  shareToken: string,
  workspaceId: string,
  projectId: string,
): string {
  if (!content) return '[]';
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return '[]';
  }
  if (!Array.isArray(parsed)) return '[]';

  const filePrefix = `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}/files/`;
  const rawFilePrefix = `/api/workspaces/${workspaceId}/projects/${projectId}/files/`;

  const rewriteUrl = (url: string): string => {
    for (const prefix of [filePrefix, rawFilePrefix]) {
      const idx = url.indexOf(prefix);
      if (idx !== -1) {
        const keyPart = url.slice(idx + prefix.length);
        return `/api/public/shares/${encodeURIComponent(shareToken)}/files/${keyPart}`;
      }
    }
    return url;
  };

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const obj = { ...(node as Record<string, unknown>) };

    // Strip member identity from user mentions in public shares
    if (obj.type === 'mention' && obj.props && typeof obj.props === 'object') {
      const props = { ...(obj.props as Record<string, unknown>) };
      if (props.kind === 'user') {
        props.id = '';
        props.label = 'Member';
      }
      obj.props = props;
    }

    if (obj.props && typeof obj.props === 'object') {
      const props = { ...(obj.props as Record<string, unknown>) };
      if (typeof props.url === 'string') {
        props.url = rewriteUrl(props.url);
      }
      obj.props = props;
    }

    if (Array.isArray(obj.content)) obj.content = obj.content.map(walk);
    if (Array.isArray(obj.children)) obj.children = obj.children.map(walk);
    return obj;
  };

  return JSON.stringify(parsed.map(walk));
}

export function createShareManagementRoutes(args: {
  repositories: RepositoryContainer;
  policy?: AccessPolicy;
  env?: Record<string, unknown>;
}) {
  const { repositories, policy, env } = args;
  const explicitWorkspace = createExplicitWorkspaceMiddleware(repositories.members);
  const flagGuard = requireFeatureFlag('publicSharing', {
    workspaces: repositories.workspaces,
    policy,
    env,
  });
  const route = new Hono<Env>();

  route.get(
    '/workspaces/:wid/projects/:pid/shares/:kind/:id',
    explicitWorkspace,
    flagGuard,
    zValidator('param', kindParamSchema),
    async (c) => {
      if (!repositories.publicShares) {
        throw httpError(501, 'not_implemented', 'Public sharing repository not configured');
      }
      const { wid: workspaceId, pid: projectId, kind, id } = c.req.valid('param');
      const share = await repositories.publicShares.findByTarget(
        { workspaceId, projectId },
        kind,
        id,
      );
      if (!share || !share.enabled || (share.expiresAt !== null && share.expiresAt <= Date.now())) {
        return c.json({ shared: false });
      }
      const origin = new URL(c.req.url).origin;
      c.header('Cache-Control', 'private, no-store');
      return c.json({
        shared: true,
        token: share.token,
        url: `${origin}/s/${share.token}`,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
      });
    },
  );

  route.post(
    '/workspaces/:wid/projects/:pid/shares/:kind/:id',
    explicitWorkspace,
    flagGuard,
    requireRole('editor'),
    zValidator('param', kindParamSchema),
    zValidator('json', createShareBodySchema),
    async (c) => {
      if (!repositories.publicShares) {
        throw httpError(501, 'not_implemented', 'Public sharing repository not configured');
      }
      const { wid: workspaceId, pid: projectId, kind, id } = c.req.valid('param');
      const scope = { workspaceId, projectId };
      const body = c.req.valid('json');

      const project = await repositories.projects.findByIdAndWorkspace(projectId, workspaceId);
      if (!project || project.archivedAt !== null) {
        throw httpError(404, 'not_found', 'Project not found or archived');
      }

      if (kind === 'notepad') {
        const note = await repositories.notepads.findByIdInScope(scope, id);
        if (!note || note.deletedAt !== null || note.kind !== 'notepad') {
          throw httpError(404, 'not_found', 'Notepad not found');
        }
      } else {
        const board = await repositories.boards.findByIdInScope(scope, id);
        if (!board || board.deletedAt !== null) {
          throw httpError(404, 'not_found', 'Board not found');
        }
      }

      const existing = await repositories.publicShares.findByTarget(scope, kind, id);
      const now = Date.now();
      const expiresAt =
        body?.expiresInDays && body.expiresInDays > 0
          ? now + body.expiresInDays * 24 * 60 * 60 * 1000
          : null;

      if (
        existing &&
        existing.enabled &&
        !body?.regenerate &&
        (existing.expiresAt === null || existing.expiresAt > now)
      ) {
        const origin = new URL(c.req.url).origin;
        return c.json({
          shared: true,
          token: existing.token,
          url: `${origin}/s/${existing.token}`,
          createdAt: existing.createdAt,
          expiresAt: existing.expiresAt,
        });
      }

      // Preserve the existing token when re-enabling after a toggle off; only rotate on explicit regenerate.
      const preservedToken =
        existing && !body?.regenerate ? existing.token : nanoid(24);

      const share = await repositories.publicShares.upsert({
        id: existing?.id ?? nanoid(),
        token: preservedToken,
        workspaceId,
        projectId,
        targetType: kind,
        targetId: id,
        enabled: true,
        createdBy: c.get('userId'),
        createdAt: existing?.createdAt ?? now,
        expiresAt,
      });

      const origin = new URL(c.req.url).origin;
      return c.json(
        {
          shared: true,
          token: share.token,
          url: `${origin}/s/${share.token}`,
          createdAt: share.createdAt,
          expiresAt: share.expiresAt,
        },
        201,
      );
    },
  );

  route.delete(
    '/workspaces/:wid/projects/:pid/shares/:kind/:id',
    explicitWorkspace,
    flagGuard,
    requireRole('editor'),
    zValidator('param', kindParamSchema),
    async (c) => {
      if (!repositories.publicShares) {
        throw httpError(501, 'not_implemented', 'Public sharing repository not configured');
      }
      const { wid: workspaceId, pid: projectId, kind, id } = c.req.valid('param');
      await repositories.publicShares.revokeByTarget({ workspaceId, projectId }, kind, id);
      return c.json({ ok: true, shared: false });
    },
  );

  return route;
}

export function createPublicShareViewerRoutes(args: {
  repositories: RepositoryContainer;
  storage: IStorageAdapter;
  policy?: AccessPolicy;
  env?: Record<string, unknown>;
}) {
  const { repositories, storage, policy, env } = args;
  const route = new Hono<Env>();

  const resolveActiveShare = async (token: string) => {
    if (!repositories.publicShares) {
      throw httpError(404, 'not_found', 'Shared resource not found');
    }
    const share = await repositories.publicShares.findByToken(token);
    if (!share || !share.enabled) throw httpError(404, 'not_found', 'Shared resource not found');
    if (share.expiresAt !== null && share.expiresAt <= Date.now()) {
      throw httpError(404, 'not_found', 'Shared link has expired');
    }
    const flags = await resolveWorkspaceFeatureFlags({
      workspaces: repositories.workspaces,
      policy,
      env,
      workspaceId: share.workspaceId,
    });
    if (!flags.publicSharing) {
      throw httpError(404, 'not_found', 'Shared resource not found');
    }
    const project = await repositories.projects.findByIdAndWorkspace(
      share.projectId,
      share.workspaceId,
    );
    if (!project || project.archivedAt !== null) {
      throw httpError(404, 'not_found', 'Shared resource not found');
    }
    return share;
  };

  route.get('/:token', async (c) => {
    const token = c.req.param('token');
    const share = await resolveActiveShare(token);
    const scope = { workspaceId: share.workspaceId, projectId: share.projectId };

    c.header('Cache-Control', 'private, no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');

    if (share.targetType === 'notepad') {
      const note = await repositories.notepads.findByIdInScope(scope, share.targetId);
      if (!note || note.deletedAt !== null || note.kind !== 'notepad') {
        throw httpError(404, 'not_found', 'Shared notepad not found');
      }
      const [contentRow, tagIds, allTags] = await Promise.all([
        repositories.notepads.getContent(scope, note.id),
        repositories.notepads.listTagIds(scope, note.id),
        repositories.tags.listByProject(scope),
      ]);
      const tagMap = new Map(allTags.map((t) => [t.id, { id: t.id, name: t.name, color: t.color }]));
      const sanitizedContent = sanitizePublicBlockNoteContent(
        contentRow?.content ?? note.content ?? '[]',
        share.token,
        share.workspaceId,
        share.projectId,
      );
      return c.json({
        kind: 'notepad',
        title: note.title,
        icon: note.icon,
        content: sanitizedContent,
        tags: tagIds.map((id) => tagMap.get(id)).filter((t): t is NonNullable<typeof t> => Boolean(t)),
        updatedAt: note.updatedAt,
      });
    }

    const board = await repositories.boards.getBoardWithDetails(scope, share.targetId);
    if (!board || board.deletedAt !== null) {
      throw httpError(404, 'not_found', 'Shared board not found');
    }

    // Strictly strip all member information (assignees, userIds, emails) and internal comments
    const columns = await Promise.all(
      board.columns.map(async (col) => ({
        id: col.id,
        name: col.name,
        color: col.color,
        wipLimit: col.wipLimit,
        cards: await Promise.all(
          col.cards.map(async (card) => {
            const details = await repositories.cards.getCardWithDetails(scope, card.id);
            return {
              id: card.id,
              title: card.title,
              priority: card.priority,
              dueDate: card.dueDate,
              tags: card.tags,
              totalSubtasks: card.totalSubtasks,
              completedSubtasks: card.completedSubtasks,
              content: sanitizePublicBlockNoteContent(
                details?.content ?? '[]',
                share.token,
                share.workspaceId,
                share.projectId,
              ),
              subtasks: (details?.subtasks ?? []).map((s) => ({
                id: s.id,
                title: s.title,
                completed: s.completed,
              })),
            };
          }),
        ),
      })),
    );

    return c.json({
      kind: 'board',
      name: board.name,
      icon: board.icon,
      columns,
      updatedAt: board.updatedAt,
    });
  });

  route.get('/:token/files/:key', async (c) => {
    const token = c.req.param('token');
    const share = await resolveActiveShare(token);
    const scope = { workspaceId: share.workspaceId, projectId: share.projectId };

    let key: string;
    try {
      key = validateStorageKey(decodeURIComponent(c.req.param('key')));
    } catch {
      throw httpError(404, 'not_found', 'File not found');
    }

    // Verify the file key is actually referenced by the shared notepad or board cards
    const referencedKeys = new Set<string>();
    if (share.targetType === 'notepad') {
      const note = await repositories.notepads.findByIdInScope(scope, share.targetId);
      if (!note || note.deletedAt !== null) throw httpError(404, 'not_found', 'File not found');
      const contentRow = await repositories.notepads.getContent(scope, note.id);
      for (const k of extractReferencedStorageKeys(
        contentRow?.content ?? note.content ?? '[]',
        note.coverKey,
      )) {
        referencedKeys.add(k);
      }
    } else {
      const board = await repositories.boards.getBoardWithDetails(scope, share.targetId);
      if (!board || board.deletedAt !== null) throw httpError(404, 'not_found', 'File not found');
      for (const col of board.columns) {
        for (const card of col.cards) {
          const details = await repositories.cards.getCardWithDetails(scope, card.id);
          for (const k of extractReferencedStorageKeys(details?.content ?? '[]')) {
            referencedKeys.add(k);
          }
        }
      }
    }

    if (!referencedKeys.has(key)) {
      throw httpError(404, 'not_found', 'File not found');
    }

    const registration = await repositories.projectFiles.findByProjectAndKey(share.projectId, key);
    if (!registration) throw httpError(404, 'not_found', 'File not found');

    const object = await storage.get(key);
    if (!object) throw httpError(404, 'not_found', 'File not found');

    const resolvedType = object.contentType || registration.contentType || 'application/octet-stream';
    const isInlineMedia = /^(image\/(?!svg\+xml)|audio\/|video\/)/.test(resolvedType);
    const headers = new Headers({
      'Content-Type': resolvedType,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': isInlineMedia
        ? "default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'"
        : "sandbox; default-src 'none'",
    });
    if (!isInlineMedia) {
      headers.set('Content-Disposition', 'attachment');
    }
    return new Response(object.body as any, { headers });
  });

  return route;
}
