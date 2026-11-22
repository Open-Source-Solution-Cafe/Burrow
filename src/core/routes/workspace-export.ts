import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { nanoid } from 'nanoid';
import { generateNKeysBetween } from 'fractional-indexing';
import type { Env } from '../app';
import type {
  RepositoryContainer,
  BoardWithDetails,
  Project,
} from '../infrastructure/types';
import type { IStorageAdapter } from '../adapters/storage';
import type { AccessPolicy } from '../policy';
import { createExplicitWorkspaceMiddleware, requireRole } from '../middleware/session';
import { httpError } from '../services/errors';
import { createWorkspacePlan } from '../entities/workspace';
import { extractFromContent } from '../../shared/extract';
import {
  isUploadPolicyStorageKey,
  MAX_UPLOAD_BYTES,
  UPLOAD_FILE_TYPES,
  uploadPolicyStorageKey,
} from '../../shared/uploadPolicy';
import { resolveWorkspaceFeatureFlags } from './feature-flags';
import type { PluginEventBus } from '../plugins/event-bus';

const uploadPolicySchema = z.object({
  maxFileSizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  allowedMimeTypes: z
    .array(z.string().refine((mime) => UPLOAD_FILE_TYPES.some((type) => type.mimeType === mime)))
    .max(UPLOAD_FILE_TYPES.length),
});

const workspaceFeatureFlagsSchema = z.object({
  workspaceExport: z.boolean().optional(),
  notionImport: z.boolean().optional(),
  publicSharing: z.boolean().optional(),
  instanceMigration: z.boolean().optional(),
});

const tagImportSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(50),
  color: z.string().nullable().optional(),
});

const notepadImportSchema = z.object({
  id: z.string().optional(),
  parentId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  icon: z.string().nullable().optional(),
  content: z.string().default('[]'),
  isFavorite: z.boolean().optional(),
  tagNames: z.array(z.string()).optional(),
});

const subtaskImportSchema = z.object({
  title: z.string().min(1).max(300),
  completed: z.boolean().default(false),
});

const cardImportSchema = z.object({
  id: z.string().optional(),
  columnName: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  content: z.string().default('[]'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional(),
  dueDate: z.number().int().nullable().optional(),
  tagNames: z.array(z.string()).optional(),
  subtasks: z.array(subtaskImportSchema).optional(),
});

const boardImportSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(100),
  icon: z.string().nullable().optional(),
  columns: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        color: z.string().nullable().optional(),
        wipLimit: z.number().int().min(0).max(999).nullable().optional(),
      }),
    )
    .min(1),
  cards: z.array(cardImportSchema).default([]),
});

export const projectImportSchema = z.object({
  tags: z.array(tagImportSchema).default([]),
  notepads: z.array(notepadImportSchema).default([]),
  boards: z.array(boardImportSchema).default([]),
  uploadPolicy: uploadPolicySchema.optional(),
});

export const bundleImportSchema = z.object({
  workspaceName: z.string().trim().min(1).max(100),
  sourceWorkspaceId: z.string().optional(),
  featureFlags: workspaceFeatureFlagsSchema.optional(),
  projects: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        icon: z.string().nullable().optional(),
        color: z.string().nullable().optional(),
        data: projectImportSchema,
      }),
    )
    .min(1),
});

function remapBlockNoteReferences(content: string, idMap: Map<string, string>): string {
  if (!content || idMap.size === 0) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!Array.isArray(parsed)) return content;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const obj = { ...(node as Record<string, unknown>) };
    if (obj.props && typeof obj.props === 'object') {
      const props = { ...(obj.props as Record<string, unknown>) };
      for (const key of ['notepadId', 'cardId', 'boardId', 'id']) {
        const val = props[key];
        if (typeof val === 'string' && idMap.has(val)) {
          props[key] = idMap.get(val)!;
        }
      }
      obj.props = props;
    }
    if (Array.isArray(obj.content)) obj.content = obj.content.map(walk);
    if (Array.isArray(obj.children)) obj.children = obj.children.map(walk);
    return obj;
  };

  return JSON.stringify(parsed.map(walk));
}

async function importIntoProject(args: {
  repositories: RepositoryContainer;
  storage?: IStorageAdapter;
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  payload: z.infer<typeof projectImportSchema>;
}) {
  const { repositories, storage, workspaceId, projectId, actorUserId, payload } = args;
  const scope = { workspaceId, projectId };
  const now = Date.now();
  const idMap = new Map<string, string>();

  // 1. Tags (reuse existing by case-insensitive name, or create)
  const existingTags = await repositories.tags.listByProject(scope);
  const tagNameToId = new Map<string, string>(
    existingTags.map((t) => [t.name.trim().toLowerCase(), t.id]),
  );
  for (const t of payload.tags) {
    const norm = t.name.trim().toLowerCase();
    if (!tagNameToId.has(norm)) {
      const created = await repositories.tags.createGuarded(
        { id: nanoid(), projectId, name: t.name.trim(), color: t.color ?? null },
        { workspaceId, projectId, actorUserId, minimumRole: 'editor' },
      );
      if (created) {
        tagNameToId.set(norm, created.id);
      }
    }
  }

  // Ensure any tagNames referenced on notepads or cards also exist
  const ensureTagIds = async (tagNames?: string[]): Promise<string[]> => {
    if (!tagNames?.length) return [];
    const ids: string[] = [];
    for (const raw of tagNames) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const norm = trimmed.toLowerCase();
      let tid = tagNameToId.get(norm);
      if (!tid) {
        const created = await repositories.tags.createGuarded(
          { id: nanoid(), projectId, name: trimmed, color: null },
          { workspaceId, projectId, actorUserId, minimumRole: 'editor' },
        );
        if (created) {
          tid = created.id;
          tagNameToId.set(norm, tid);
        }
      }
      if (tid && !ids.includes(tid)) ids.push(tid);
    }
    return ids;
  };

  // Pre-allocate new IDs for notepads, boards, and cards so BlockNote references can be remapped
  const notepadIdPairs = payload.notepads.map((n) => {
    const newId = nanoid();
    if (n.id) idMap.set(n.id, newId);
    return { item: n, newId };
  });
  const boardIdPairs = payload.boards.map((b) => {
    const newId = nanoid();
    if (b.id) idMap.set(b.id, newId);
    const cardPairs = b.cards.map((c) => {
      const newCardId = nanoid();
      if (c.id) idMap.set(c.id, newCardId);
      return { card: c, newCardId, newCardNotepadId: nanoid() };
    });
    return { board: b, newId, cardPairs };
  });

  // 2. Notepads (topological order: parents before children)
  const pendingNotepads = [...notepadIdPairs];
  const insertedNotepads = new Set<string>();
  const lastRootPos = await repositories.notepads.getLastRootPosition(scope);
  const rootPositions = generateNKeysBetween(lastRootPos, null, Math.max(1, pendingNotepads.length));
  let posIdx = 0;

  let safetyPass = 0;
  while (pendingNotepads.length > 0 && safetyPass <= pendingNotepads.length + 5) {
    safetyPass++;
    const nextBatch: typeof pendingNotepads = [];
    for (const entry of pendingNotepads) {
      const mappedParentId = entry.item.parentId ? idMap.get(entry.item.parentId) ?? null : null;
      if (mappedParentId && !insertedNotepads.has(mappedParentId) && safetyPass <= notepadIdPairs.length) {
        nextBatch.push(entry);
        continue;
      }
      const remappedContent = remapBlockNoteReferences(entry.item.content, idMap);
      const position = rootPositions[posIdx++] ?? generateNKeysBetween(null, null, 1)[0]!;
      const created = await repositories.notepads.create(
        {
          id: entry.newId,
          workspaceId,
          projectId,
          parentId: mappedParentId && insertedNotepads.has(mappedParentId) ? mappedParentId : null,
          kind: 'notepad',
          title: entry.item.title,
          content: remappedContent,
          version: 1,
          position,
          isFavorite: Boolean(entry.item.isFavorite),
          createdBy: actorUserId,
          createdAt: now,
          updatedAt: now,
        },
        { workspaceId, projectId, actorUserId, minimumRole: 'editor' },
      );
      if (created) {
        insertedNotepads.add(entry.newId);
        if (entry.item.icon) {
          await repositories.notepads.update(
            entry.newId,
            { icon: entry.item.icon, updatedAt: now },
            { workspaceId, projectId, actorUserId, minimumRole: 'editor' },
          );
        }
        const tagIds = await ensureTagIds(entry.item.tagNames);
        if (tagIds.length > 0) {
          await repositories.notepads.setTagIds(entry.newId, tagIds, {
            workspaceId,
            projectId,
            actorUserId,
            minimumRole: 'editor',
          });
        }
      }
    }
    pendingNotepads.splice(0, pendingNotepads.length, ...nextBatch);
  }

  // 3. Boards, columns, cards, and subtasks
  const existingBoards = await repositories.boards.listByProject(scope);
  const lastBoardPos = existingBoards.at(-1)?.position ?? null;
  const boardPositions = generateNKeysBetween(
    lastBoardPos,
    null,
    Math.max(1, boardIdPairs.length),
  );

  let cardsCreated = 0;
  for (let bi = 0; bi < boardIdPairs.length; bi++) {
    const { board, newId: boardId, cardPairs } = boardIdPairs[bi]!;
    const colPositions = generateNKeysBetween(null, null, board.columns.length);
    const colNameToId = new Map<string, string>();
    const colsToCreate = board.columns.map((col, ci) => {
      const colId = nanoid();
      colNameToId.set(col.name.trim().toLowerCase(), colId);
      return {
        id: colId,
        boardId,
        name: col.name,
        color: col.color ?? null,
        position: colPositions[ci]!,
        wipLimit: col.wipLimit ?? null,
      };
    });

    const boardCreated = await repositories.boards.createWithColumns(
      {
        id: boardId,
        workspaceId,
        projectId,
        name: board.name,
        icon: board.icon ?? null,
        position: boardPositions[bi]!,
        createdAt: now,
        updatedAt: now,
      },
      colsToCreate,
      { workspaceId, actorUserId, minimumRole: 'editor' },
    );
    if (!boardCreated) continue;

    const cardPositions = generateNKeysBetween(null, null, Math.max(1, cardPairs.length));
    const fallbackColId = colsToCreate[0]!.id;

    for (let ci = 0; ci < cardPairs.length; ci++) {
      const { card, newCardId, newCardNotepadId } = cardPairs[ci]!;
      const colId = colNameToId.get(card.columnName.trim().toLowerCase()) ?? fallbackColId;
      const remappedContent = remapBlockNoteReferences(card.content, idMap);
      const plainText = extractFromContent(remappedContent).text;
      const tagIds = await ensureTagIds(card.tagNames);

      const ok = await repositories.cards.createFromPlan({
        workspaceId,
        projectId,
        boardId,
        columnId: colId,
        actorId: actorUserId,
        cardId: newCardId,
        notepadId: newCardNotepadId,
        title: card.title,
        content: remappedContent,
        plainText,
        priority: card.priority ?? null,
        dueDate: card.dueDate ?? null,
        assigneeIds: [],
        tagIds,
        assignmentNotifications: [],
        cardPosition: cardPositions[ci]!,
        linkedNotepad: null,
        now,
      });
      if (ok) {
        cardsCreated++;
        if (card.subtasks?.length) {
          for (const sub of card.subtasks) {
            await repositories.cards.createSubtaskGuarded(
              {
                id: nanoid(),
                cardId: newCardId,
                title: sub.title,
                completed: Boolean(sub.completed),
                position: generateNKeysBetween(null, null, 1)[0]!,
                createdAt: now,
              },
              { workspaceId, actorUserId, minimumRole: 'editor' },
            );
          }
        }
      }
    }
  }

  if (payload.uploadPolicy && typeof storage?.put === 'function') {
    const normalizedPolicy = {
      maxFileSizeBytes: payload.uploadPolicy.maxFileSizeBytes,
      allowedMimeTypes: [...new Set(payload.uploadPolicy.allowedMimeTypes)],
    };
    await storage.put(
      uploadPolicyStorageKey(workspaceId, projectId),
      new TextEncoder().encode(JSON.stringify(normalizedPolicy)),
      'application/json',
    );
  }

  return {
    notepadsImported: insertedNotepads.size,
    boardsImported: boardIdPairs.length,
    cardsImported: cardsCreated,
  };
}

export function createWorkspaceExportRoutes(args: {
  repositories: RepositoryContainer;
  storage: IStorageAdapter;
  policy?: AccessPolicy;
  env?: Record<string, unknown>;
  events?: PluginEventBus;
}) {
  const { repositories, storage, policy, env, events } = args;
  const explicitWorkspace = createExplicitWorkspaceMiddleware(repositories.members);
  const route = new Hono<Env>();

  // 1. Workspace / Project Export Manifest (JSON + Media URLs for client ZIP assembly)
  route.get('/:wid/export', explicitWorkspace, async (c) => {
    const workspaceId = c.get('workspaceId');
    const flags = await resolveWorkspaceFeatureFlags({
      workspaces: repositories.workspaces,
      policy,
      env,
      workspaceId,
    });
    if (!flags.workspaceExport && !flags.instanceMigration) {
      throw httpError(404, 'feature_disabled', 'Workspace export is not enabled for this workspace');
    }

    const projectIdFilter = c.req.query('projectId');
    const role = c.get('role');
    if (role !== 'owner') {
      throw httpError(
        403,
        'forbidden',
        'Only workspace owners can export workspace or project data',
      );
    }

    const workspace = await repositories.workspaces.findById(workspaceId);
    if (!workspace) throw httpError(404, 'not_found', 'Workspace not found');
    const storedFeatureFlags = repositories.workspaces.getFeatureFlags
      ? await repositories.workspaces.getFeatureFlags(workspaceId)
      : {};

    const allProjects = await repositories.projects.listByWorkspace(workspaceId);
    const targetProjects: Project[] = projectIdFilter
      ? allProjects.filter((p) => p.id === projectIdFilter)
      : allProjects;
    if (projectIdFilter && targetProjects.length === 0) {
      throw httpError(404, 'not_found', 'Project not found');
    }

    const origin = new URL(c.req.url).origin;
    const exportedProjects = await Promise.all(
      targetProjects.map(async (project) => {
        const scope = { workspaceId, projectId: project.id };
        const [projectTags, notepadRows, boardList, storageKeys, policyObj] = await Promise.all([
          repositories.tags.listByProject(scope),
          repositories.notepads.listByProject(scope),
          repositories.boards.listByProject(scope),
          repositories.projectFiles.listStorageKeysByProject(project.id),
          typeof storage?.get === 'function'
            ? storage.get(uploadPolicyStorageKey(workspaceId, project.id)).catch(() => null)
            : Promise.resolve(null),
        ]);

        let uploadPolicy: z.infer<typeof uploadPolicySchema> | undefined;
        if (policyObj) {
          try {
            const parsed = uploadPolicySchema.safeParse(
              await new Response(policyObj.body as BodyInit).json(),
            );
            if (parsed.success) {
              uploadPolicy = parsed.data;
            }
          } catch {
            /* ignore invalid stored policy */
          }
        }

        const notepadsWithContent = await Promise.all(
          notepadRows.map(async (np) => {
            const [contentRow, tagIds] = await Promise.all([
              repositories.notepads.getContent(scope, np.id),
              repositories.notepads.listTagIds(scope, np.id),
            ]);
            return {
              id: np.id,
              parentId: np.parentId,
              title: np.title,
              icon: np.icon,
              coverKey: np.coverKey,
              position: np.position,
              isFavorite: np.isFavorite,
              content: contentRow?.content ?? np.content ?? '[]',
              tagIds,
              createdAt: np.createdAt,
              updatedAt: np.updatedAt,
            };
          }),
        );

        const boardsWithDetails: BoardWithDetails[] = (
          await Promise.all(
            boardList.map((b) => repositories.boards.getBoardWithDetails(scope, b.id)),
          )
        ).filter((b): b is BoardWithDetails => b !== null);

        const detailedBoards = await Promise.all(
          boardsWithDetails.map(async (board) => ({
            ...board,
            columns: await Promise.all(
              board.columns.map(async (col) => ({
                ...col,
                cards: await Promise.all(
                  col.cards.map(async (card) => {
                    const details = await repositories.cards.getCardWithDetails(scope, card.id);
                    return {
                      ...card,
                      content: details?.content ?? '[]',
                      subtasks: details?.subtasks ?? [],
                    };
                  }),
                ),
              })),
            ),
          })),
        );

        const files = (
          await Promise.all(
            storageKeys
              .filter((key) => !isUploadPolicyStorageKey(key))
              .map((key) => repositories.projectFiles.findByProjectAndKey(project.id, key)),
          )
        )
          .filter((f): f is NonNullable<typeof f> => f !== null)
          .map((f) => ({
            storageKey: f.storageKey,
            filename: f.filename ?? f.storageKey.split('/').pop() ?? 'file',
            contentType: f.contentType,
            byteSize: f.byteSize ?? null,
            downloadUrl: `${origin}/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(f.storageKey)}`,
          }));

        return {
          id: project.id,
          name: project.name,
          icon: project.icon,
          color: project.color,
          ...(uploadPolicy ? { uploadPolicy } : {}),
          tags: projectTags,
          notepads: notepadsWithContent,
          boards: detailedBoards,
          files,
        };
      }),
    );

    c.header('Cache-Control', 'private, no-store');
    return c.json({
      schemaVersion: 'burrow-export-v1',
      exportedAt: Date.now(),
      workspace: { id: workspace.id, name: workspace.name, featureFlags: storedFeatureFlags },
      projects: exportedProjects,
    });
  });

  // 2. GDPR Right to Erasure: Permanent Workspace Delete + Storage Cleanup (Owner Only)
  route.delete(
    '/:wid',
    explicitWorkspace,
    requireRole('owner'),
    zValidator('query', z.object({ confirm: z.string().min(1) })),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const confirm = c.req.valid('query').confirm;
      if (!repositories.workspaces.deleteGuarded) {
        throw httpError(501, 'not_implemented', 'Workspace deletion not supported');
      }
      const actorId = c.get('userId');
      await events?.emitBefore('workspace.deleted', { workspaceId, actorId });
      const deletedKeys = await repositories.workspaces.deleteGuarded(
        workspaceId,
        actorId,
        confirm,
      );
      if (!deletedKeys) {
        throw httpError(
          400,
          'invalid_confirmation',
          'Workspace name confirmation did not match or owner access changed',
        );
      }
      if (deletedKeys.length > 0) {
        await Promise.allSettled(
          deletedKeys.map(async (key) => {
            try {
              await storage.delete(key);
            } catch {
              await repositories.storageDeletions?.enqueue?.([
                {
                  id: nanoid(),
                  storageKey: key,
                  workspaceId,
                  projectId: null,
                  reason: 'project_delete',
                  createdAt: Date.now(),
                },
              ]);
            }
          }),
        );
      }
      await events?.emitAfter('workspace.deleted', { workspaceId, actorId });
      return c.json({ ok: true, deletedWorkspaceId: workspaceId });
    },
  );

  // 3. Project Import (Notion ZIP / Lossless Backup Restore)
  route.post(
    '/:wid/projects/:pid/import',
    explicitWorkspace,
    requireRole('editor'),
    zValidator('json', projectImportSchema),
    async (c) => {
      const workspaceId = c.get('workspaceId');
      const projectId = c.req.param('pid');
      const flags = await resolveWorkspaceFeatureFlags({
        workspaces: repositories.workspaces,
        policy,
        env,
        workspaceId,
      });
      if (!flags.notionImport && !flags.workspaceExport && !flags.instanceMigration) {
        throw httpError(404, 'feature_disabled', 'Import is not enabled for this workspace');
      }
      const project = await repositories.projects.findByIdAndWorkspace(projectId, workspaceId);
      if (!project) throw httpError(404, 'not_found', 'Project not found');

      const summary = await importIntoProject({
        repositories,
        storage,
        workspaceId,
        projectId,
        actorUserId: c.get('userId'),
        payload: c.req.valid('json'),
      });
      return c.json({ ok: true, projectId, ...summary }, 201);
    },
  );

  // 4. Instance Migration Bundle Import (Source Instance -> Target Instance)
  route.post('/import-bundle', zValidator('json', bundleImportSchema), async (c) => {
    const identity = c.get('identity');
    if (!identity) throw httpError(401, 'unauthorized', 'Authentication required');

    const body = c.req.valid('json');
    if (body.sourceWorkspaceId) {
      const sourceMember = await repositories.members.findByUserId(
        body.sourceWorkspaceId,
        identity.userId,
      );
      if (sourceMember) {
        const flags = await resolveWorkspaceFeatureFlags({
          workspaces: repositories.workspaces,
          policy,
          env,
          workspaceId: body.sourceWorkspaceId,
        });
        if (!flags.instanceMigration) {
          throw httpError(
            404,
            'feature_disabled',
            'Enable Instance Data Migration in Workspace Settings before porting data',
          );
        }
      }
    } else {
      const policyFlags = policy?.featureFlags?.() ?? {};
      if (policyFlags.instanceMigration === false) {
        throw httpError(404, 'feature_disabled', 'Instance Data Migration is disabled');
      }
    }

    await policy?.authorize({ action: 'workspace.create', userId: identity.userId });
    const now = Date.now();
    const workspaceId = nanoid();
    const firstProject = body.projects[0]!;
    const firstProjectId = nanoid();

    const plan = createWorkspacePlan({
      userId: identity.userId,
      name: body.workspaceName,
      workspaceId,
      projectId: firstProjectId,
      notepadId: nanoid(),
      now,
    });
    plan.project.name = firstProject.name;
    plan.project.icon = firstProject.icon ?? null;
    plan.project.color = firstProject.color ?? null;

    await repositories.workspaces.create(plan);
    if (body.featureFlags && repositories.workspaces.updateFeatureFlags) {
      await repositories.workspaces.updateFeatureFlags(
        workspaceId,
        identity.userId,
        body.featureFlags,
      );
    }
    const results = [];

    results.push({
      projectId: firstProjectId,
      ...(await importIntoProject({
        repositories,
        storage,
        workspaceId,
        projectId: firstProjectId,
        actorUserId: identity.userId,
        payload: firstProject.data,
      })),
    });

    const projectPositions = generateNKeysBetween(
      plan.project.position,
      null,
      Math.max(1, body.projects.length - 1),
    );
    let prevProject: { id: string; position: string } = {
      id: firstProjectId,
      position: plan.project.position,
    };

    for (let i = 1; i < body.projects.length; i++) {
      const proj = body.projects[i]!;
      await policy?.authorize({
        action: 'project.create',
        userId: identity.userId,
        workspaceId,
      });
      const pid = nanoid();
      const pos = projectPositions[i - 1]!;
      const created = await repositories.projects.createGuarded(
        {
          id: pid,
          workspaceId,
          name: proj.name,
          icon: proj.icon ?? null,
          color: proj.color ?? null,
          position: pos,
          createdAt: now,
          updatedAt: now,
        },
        identity.userId,
        prevProject,
      );
      if (created) {
        prevProject = { id: pid, position: pos };
        results.push({
          projectId: pid,
          ...(await importIntoProject({
            repositories,
            storage,
            workspaceId,
            projectId: pid,
            actorUserId: identity.userId,
            payload: proj.data,
          })),
        });
      }
    }

    return c.json({ ok: true, workspaceId, projects: results }, 201);
  });

  return route;
}
