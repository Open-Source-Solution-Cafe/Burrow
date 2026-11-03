import { nanoid } from 'nanoid';
import type {
  IMemberRepository,
  INotepadRepository,
  ITagRepository,
  Notepad,
  NotepadContent,
  StoredLink,
  EditLock,
  ProjectScope,
} from '../infrastructure/types';
import {
  notFound,
  forbidden,
  badRequest,
  conflict,
  payloadTooLarge,
  rethrowAmbiguousDeleteGroup,
} from './errors';
import {
  MAX_NOTEPAD_DEPTH,
  MAX_CONTENT_BYTES,
  LOCK_TTL_MS,
  contentByteLength,
} from '../shared/limits';
import { positionBetween } from './utils/ordering';
import { extractFromContent } from '../../shared/extract';
import { getDescendantIds, getDepth, getSubtreeHeight, wouldCauseCycle } from '../shared/tree';
import type { ILockAdapter } from '../adapters/lock';

export { MAX_NOTEPAD_DEPTH, MAX_CONTENT_BYTES, LOCK_TTL_MS } from '../shared/limits';

export interface CreateNotepadArgs {
  workspaceId: string;
  projectId: string;
  parentId?: string | null;
  title?: string;
  createdBy: string;
  actorUserId: string;
  position?: string;
}

export interface CreatedNotepad {
  id: string;
  position: string;
  version: number;
}

export interface MoveNotepadArgs {
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  notepadId: string;
  parentId?: string | null;
  afterId?: string | null;
}

export interface SoftDeleteNotepadArgs {
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  notepadId: string;
}

export interface RestoreNotepadArgs {
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  notepadId: string;
}

export interface PermanentDeleteNotepadArgs {
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  notepadId: string;
}

export interface SaveContentArgs {
  workspaceId: string;
  projectId: string;
  notepadId: string;
  content: string;
  baseVersion: number;
  actorId: string;
  clientId?: string;
  notepad?: Omit<NotepadContent, 'content'>;
}

export interface SaveContentResult {
  version: number;
}

export interface PreparedSave {
  row: Omit<NotepadContent, 'content'>;
  validLinks: StoredLink[];
  previousLinks: StoredLink[];
}

export interface ClaimLockArgs {
  workspaceId: string;
  notepadId: string;
  userId: string;
  clientId: string;
  takeover?: boolean;
}

export class NotepadService {
  constructor(
    private readonly repos: {
      notepads: INotepadRepository;
      tags: ITagRepository;
      members: IMemberRepository;
    },
    private readonly locks: ILockAdapter,
  ) {}

  /** Only disclose lock-holder identity after verifying membership in the resource's workspace. */
  async getLockHolder(workspaceId: string, userId: string, actorId: string) {
    const member = await this.repos.members.findByUserId(workspaceId, userId);
    return {
      userId: member?.userId,
      name: member?.name || 'Someone',
      isMe: member?.userId === actorId,
    };
  }

  private async lockedError(
    workspaceId: string,
    lock: Pick<EditLock, 'userId' | 'expiresAt'> | null,
    actorId: string,
  ) {
    const holder = lock
      ? await this.getLockHolder(workspaceId, lock.userId, actorId)
      : { name: 'Someone', isMe: false };
    return conflict(
      'locked',
      JSON.stringify({
        code: 'locked',
        holder,
        expiresAt: lock?.expiresAt,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------
  async createNotepad(args: CreateNotepadArgs): Promise<CreatedNotepad> {
    // Note: Project validation should be done by caller or project service
    // For now we assume project exists and is accessible

    let position = args.position ?? null;
    if (args.parentId) {
      const parent = await this.repos.notepads.findByIdInScope(args, args.parentId);
      if (!parent || parent.deletedAt !== null || parent.kind !== 'notepad') {
        throw notFound('not_found', 'Parent notepad not found');
      }
      const parentDepth = await getDepth(
        (id) => this.repos.notepads.getParent(args, id),
        parent.id,
      );
      if (parentDepth + 1 > MAX_NOTEPAD_DEPTH) {
        throw badRequest('too_deep', `Notepads can nest at most ${MAX_NOTEPAD_DEPTH} deep`);
      }
      if (!position) position = await this.repos.notepads.getLastChildPosition(args, parent.id);
    } else if (!position) {
      position = await this.repos.notepads.getLastRootPosition(args);
    }

    // Ensure position is never null (fallback)
    if (!position) position = 'a0';

    const id = nanoid();
    const now = Date.now();
    const title = args.title?.trim() || 'Untitled';

    const created = await this.repos.notepads.create({
      id,
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      parentId: args.parentId ?? null,
      kind: 'notepad',
      title,
      content: '[]',
      version: 1,
      position,
      isFavorite: false,
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
    }, { workspaceId: args.workspaceId, projectId: args.projectId, actorUserId: args.actorUserId, minimumRole: 'editor' });
    if (!created) throw forbidden('forbidden', 'Editor access changed while creating the notepad');

    return { id, position, version: 1 };
  }

  // ---------------------------------------------------------------------------
  // Move
  // ---------------------------------------------------------------------------
  async moveNotepad(args: MoveNotepadArgs): Promise<{ parentId: string | null; position: string }> {
    const notepad = await this.repos.notepads.findByIdInScope(args, args.notepadId);
    if (!notepad || notepad.deletedAt !== null) {
      throw notFound('not_found', 'Notepad not found');
    }

    if (notepad.kind === 'card') {
      throw badRequest('cannot_move_card_notepad', 'Cards cannot be moved in the notepad tree');
    }

    const targetParentId = args.parentId === undefined ? notepad.parentId : args.parentId;

    // Cycle check
    if (targetParentId) {
      if (
        await wouldCauseCycle(
          (rootId) =>
            getDescendantIds(
              (parentIds) => this.repos.notepads.getChildren(notepad, parentIds),
              rootId,
            ),
          args.notepadId,
          targetParentId,
        )
      ) {
        throw badRequest('cycle_detected', 'Cannot move a notepad under its own descendant');
      }

      const parent = await this.repos.notepads.findByIdInScope(notepad, targetParentId);
      if (
        !parent ||
        parent.deletedAt !== null ||
        parent.kind !== 'notepad'
      ) {
        throw notFound('not_found', 'Target parent not found');
      }

      const parentDepth = await getDepth(
        (id) => this.repos.notepads.getParent(notepad, id),
        parent.id,
      );
      const subtreeHeight = await getSubtreeHeight(
        (parentIds) => this.repos.notepads.getChildren(notepad, parentIds),
        args.notepadId,
      );
      if (parentDepth + subtreeHeight > MAX_NOTEPAD_DEPTH) {
        throw badRequest('too_deep', `Move would exceed max depth of ${MAX_NOTEPAD_DEPTH}`);
      }
    }

    // Calculate new position among target siblings
    const siblings = await this.getSiblings(
      { workspaceId: args.workspaceId, projectId: args.projectId },
      targetParentId,
    );
    const otherSiblings = siblings.filter((s) => s.id !== args.notepadId);

    let newPosition: string;
    if (!args.afterId) {
      const next = otherSiblings[0]?.position ?? null;
      newPosition = positionBetween(null, next);
    } else {
      const afterIndex = otherSiblings.findIndex((s) => s.id === args.afterId);
      if (afterIndex === -1)
        throw badRequest('invalid_after_id', 'afterId not found among siblings');
      const prev = otherSiblings[afterIndex]!.position;
      const next = otherSiblings[afterIndex + 1]?.position ?? null;
      newPosition = positionBetween(prev, next);
    }

    const moved = await this.repos.notepads.move(args.notepadId, targetParentId, newPosition, {
      workspaceId: args.workspaceId, projectId: args.projectId, actorUserId: args.actorUserId, minimumRole: 'editor',
    });
    if (!moved) throw forbidden('forbidden', 'Editor access changed while moving the notepad');
    return { parentId: targetParentId, position: newPosition };
  }

  private async getSiblings(scope: ProjectScope, parentId: string | null): Promise<Notepad[]> {
    // This is a simplified version - in reality we'd need a repository method
    // that filters by projectId, parentId, deletedAt, and kind
    // For now, we'll list all by project and filter in memory
    const all = await this.repos.notepads.listByProject(scope);
    return all.filter(
      (n) =>
        (parentId ? n.parentId === parentId : n.parentId === null) &&
        n.deletedAt === null &&
        n.kind === 'notepad',
    );
  }

  // ---------------------------------------------------------------------------
  // Soft Delete
  // ---------------------------------------------------------------------------
  async softDeleteNotepad(args: SoftDeleteNotepadArgs): Promise<void> {
    const notepad = await this.repos.notepads.findByIdInScope(
      { workspaceId: args.workspaceId, projectId: args.projectId },
      args.notepadId,
    );
    if (!notepad || notepad.deletedAt !== null) {
      throw notFound('not_found', 'Notepad not found');
    }

    if (notepad.kind === 'card') {
      throw badRequest(
        'cannot_delete_card_notepad',
        'Card notepads must be deleted via card service',
      );
    }

    const now = Date.now();
    // The repository owns the scoped subtree mutation and its index/lock cleanup.
    const deleted = await this.repos.notepads.softDelete(args.notepadId, now, {
      workspaceId: args.workspaceId, projectId: args.projectId, actorUserId: args.actorUserId, minimumRole: 'editor',
    });
    if (!deleted) throw forbidden('forbidden', 'Editor access changed while deleting the notepad');
  }

  // ---------------------------------------------------------------------------
  // Restore
  // ---------------------------------------------------------------------------
  async restoreNotepad(args: RestoreNotepadArgs): Promise<void> {
    const notepad = await this.repos.notepads.findByIdInScope(
      { workspaceId: args.workspaceId, projectId: args.projectId },
      args.notepadId,
    );
    if (!notepad || notepad.deletedAt === null) {
      throw notFound('not_found', 'Deleted notepad not found');
    }

    if (notepad.kind === 'card') {
      throw badRequest(
        'cannot_restore_card_notepad',
        'Card notepads must be restored via card service',
      );
    }

    const deleteTimestamp = notepad.deletedAt!;

    // Restore exactly the rows sharing this deletion operation.
    let matchingNotepads: Awaited<ReturnType<INotepadRepository['restore']>>;
    try {
      matchingNotepads = await this.repos.notepads.restore(args.notepadId, deleteTimestamp, {
        workspaceId: args.workspaceId, projectId: args.projectId, actorUserId: args.actorUserId, minimumRole: 'editor',
      });
    } catch (error) {
      rethrowAmbiguousDeleteGroup(error);
    }
    if (matchingNotepads === null) throw forbidden('forbidden', 'Editor access changed while restoring the notepad');
    if (!matchingNotepads.some((item) => item.id === args.notepadId)) {
      throw conflict('deletion_changed', 'This item changed while it was being restored');
    }

  }

  // ---------------------------------------------------------------------------
  // Permanent Delete
  // ---------------------------------------------------------------------------
  async permanentDeleteNotepad(args: PermanentDeleteNotepadArgs): Promise<void> {
    const notepad = await this.repos.notepads.findByIdInScope(
      { workspaceId: args.workspaceId, projectId: args.projectId },
      args.notepadId,
    );
    if (!notepad) throw notFound('not_found', 'Notepad not found');

    if (notepad.deletedAt === null) {
      throw badRequest('not_in_trash', 'Only items in trash can be permanently deleted');
    }

    const removed = await this.repos.notepads.hardDelete(args.notepadId, {
      workspaceId: args.workspaceId, projectId: args.projectId, actorUserId: args.actorUserId, minimumRole: 'owner',
    });
    if (removed === null) throw forbidden('forbidden', 'Owner access changed while deleting the notepad');
  }

  // ---------------------------------------------------------------------------
  // Content Save
  // ---------------------------------------------------------------------------
  private async prepareSave(
    args: SaveContentArgs,
    row: Omit<NotepadContent, 'content'>,
  ): Promise<PreparedSave> {
    const extraction = extractFromContent(args.content);
    const validLinks = await this.repos.notepads.filterProjectTargets(row, extraction.links);
    const previousLinks = await this.repos.notepads.listLinks(row, args.notepadId);

    return {
      row: {
        id: args.notepadId,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        title: row.title,
        version: row.version,
      },
      validLinks,
      previousLinks,
    };
  }

  async saveContent(args: SaveContentArgs): Promise<SaveContentResult> {
    if (contentByteLength(args.content) > MAX_CONTENT_BYTES) {
      throw payloadTooLarge('content_too_large', 'Notepad content exceeds 1.5 MB');
    }

    const scope = { workspaceId: args.workspaceId, projectId: args.projectId, now: Date.now() };
    const row = args.notepad ?? (await this.repos.notepads.getContent(scope, args.notepadId));
    if (!row || row.workspaceId !== args.workspaceId || row.projectId !== args.projectId) {
      throw notFound('not_found', 'Notepad not found');
    }
    // Check live edit lock only after verifying the notepad's workspace.
    const now = Date.now();
    const lock = await this.repos.notepads.getLock(scope, args.notepadId);

    if (
      lock &&
      lock.expiresAt > now &&
      (lock.userId !== args.actorId || lock.clientId !== args.clientId)
    ) {
      throw await this.lockedError(args.workspaceId, lock, args.actorId);
    }

    const prepared = await this.prepareSave(args, row);
    if (prepared.row.version !== args.baseVersion) {
      throw conflict('version_conflict', 'This notepad changed elsewhere');
    }

    try {
      const version = await this.repos.notepads.saveContentBatch({
        row: prepared.row,
        scope: { workspaceId: args.workspaceId, projectId: row.projectId, actorUserId: args.actorId, minimumRole: 'editor' },
        content: args.content,
        baseVersion: args.baseVersion,
        actorId: args.actorId,
        validLinks: prepared.validLinks,
        previousLinks: prepared.previousLinks,
        now,
        lock: args.clientId
          ? { clientId: args.clientId, userId: args.actorId, expiresAt: now + LOCK_TTL_MS }
          : undefined,
      });
      return { version };
    } catch (err) {
      if (err instanceof Error && err.message === 'lock_conflict') {
        throw await this.lockedError(
          args.workspaceId,
          await this.repos.notepads.getLock(scope, args.notepadId),
          args.actorId,
        );
      }
      if (err instanceof Error && err.message === 'version_conflict') {
        throw conflict('version_conflict', 'This notepad changed elsewhere');
      }
      if (err instanceof Error && err.message === 'workspace_write_forbidden') {
        throw forbidden('forbidden', 'Editor access changed while saving the notepad');
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Edit Locks
  // ---------------------------------------------------------------------------
  async claimLock(args: ClaimLockArgs): Promise<{ expiresAt: number }> {
    const result = await this.locks.acquire(
      args.notepadId,
      args.userId,
      args.clientId,
      LOCK_TTL_MS,
      { takeover: args.takeover },
    );

    if (!result.acquired) {
      throw await this.lockedError(
        args.workspaceId,
        result.holderUserId && result.expiresAt !== undefined
          ? { userId: result.holderUserId, expiresAt: result.expiresAt }
          : null,
        args.userId,
      );
    }

    return { expiresAt: result.expiresAt! };
  }

  async releaseLock(args: ClaimLockArgs): Promise<void> {
    await this.locks.release(args.notepadId, args.clientId, { userId: args.userId });
  }

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------
  async setNotepadTags(notepadId: string, tagIds: string[], scope: ProjectScope, actorUserId: string): Promise<void> {
    const notepad = await this.repos.notepads.findByIdInScope(scope, notepadId);
    if (!notepad) throw notFound('not_found', 'Notepad not found');

    // Invariant I9: Every tag must belong to the notepad's project
    const uniqueTagIds = [...new Set(tagIds)];
    if (uniqueTagIds.length > 0) {
      for (const tagId of uniqueTagIds) {
        const tag = await this.repos.tags.findByIdInScope(
          scope,
          tagId,
        );
        if (!tag) {
          throw badRequest('invalid_tags', 'All tags must belong to the notepad project');
        }
      }
    }

    const updated = await this.repos.notepads.setTagIds(notepadId, uniqueTagIds, {
      workspaceId: scope.workspaceId, projectId: scope.projectId, actorUserId, minimumRole: 'editor',
    });
    if (!updated) throw forbidden('forbidden', 'Editor access changed while updating notepad tags');
  }

  // ---------------------------------------------------------------------------
  // Tree Queries
  // ---------------------------------------------------------------------------
  async listByProject(scope: ProjectScope): Promise<Notepad[]> {
    return this.repos.notepads.listByProject(scope);
  }
}
