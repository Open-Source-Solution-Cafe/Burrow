import type {
  INotepadRepository,
  Notepad,
  CreateNotepadData,
  UpdateNotepadData,
  NotepadContent,
  RestoredNotepad,
  HardDeletedNotepad,
  StoredLink,
  EditLock,
  SaveContentBatchArgs,
  ProjectScope,
  NotepadMutationScope,
} from '../../../../infrastructure/types';
import { eq, ne, and, inArray, desc, sql, isNull, isNotNull, count, or, exists } from 'drizzle-orm';
import type { PostgresDb } from '../index';
import { withNotepadWrite } from '../notepad-transaction';
import {
  notepads,
  notepadTags,
  tags,
  notepadLinks,
  notifications,
  projects,
  cards,
  boards,
  boardColumns,
  members,
  editLocks,
} from '../schema';
import { positionAfterLast } from '../../../../services/utils/ordering';
import { diffLinks, resolveReferenceTargets } from '../../../../shared/links';
import { MAX_CONTENT_BYTES, contentByteLength } from '../../../../shared/limits';
import { extractPlainText } from '../../../../../shared/extract';
import type { ContentReferenceKind, ReferencePreview } from '../../../../../shared/references';

// Helper to safely get first element of array
function first<T>(arr: T[]): T | undefined {
  return arr[0];
}

export class PostgresNotepadRepository implements INotepadRepository {
  constructor(private db: PostgresDb) {}

  private sourceProjectMatches() {
    return exists(
      this.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(eq(projects.id, notepads.projectId), eq(projects.workspaceId, notepads.workspaceId)),
        ),
    );
  }

  async listByProject(scope: ProjectScope): Promise<Notepad[]> {
    // Tree metadata only: live `notepad`-kind rows (excludes cards and deleted).
    return this.db
      .select()
      .from(notepads)
      .where(
        and(
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          eq(notepads.kind, 'notepad'),
          isNull(notepads.deletedAt),
          this.sourceProjectMatches(),
        ),
      )
      .orderBy(notepads.position);
  }

  async findByIdInScope(scope: ProjectScope, id: string): Promise<Notepad | null> {
    const result = await this.db
      .select()
      .from(notepads)
      .where(
        and(
          eq(notepads.id, id),
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          this.sourceProjectMatches(),
        ),
      )
      .limit(1);
    return first(result) ?? null;
  }

  async listDeletedByProject(scope: ProjectScope): Promise<Notepad[]> {
    return this.db
      .select()
      .from(notepads)
      .where(
        and(
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          isNotNull(notepads.deletedAt),
          this.sourceProjectMatches(),
        ),
      )
      .orderBy(desc(notepads.deletedAt));
  }

  async create(data: CreateNotepadData, scope: NotepadMutationScope): Promise<boolean> {
    // Extract plain text from content JSON for FTS
    const plainText = extractPlainText(data.content);
    if (data.workspaceId !== scope.workspaceId || data.projectId !== scope.projectId) return false;
    return (await withNotepadWrite(this.db, scope, async (tx) => {
      const [project] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
      if (!project) return false;
      const result = await tx.insert(notepads).values({ ...data, plainText }).returning({ id: notepads.id });
      return result.length > 0;
    })) ?? false;
  }

  async update(id: string, data: UpdateNotepadData, scope: NotepadMutationScope): Promise<boolean> {
    return (await withNotepadWrite(this.db, scope, async (tx) => {
      const result = await tx.update(notepads).set(data).where(and(eq(notepads.id, id), eq(notepads.workspaceId, scope.workspaceId), eq(notepads.projectId, scope.projectId), isNull(notepads.deletedAt), eq(notepads.kind, 'notepad'))).returning({ id: notepads.id });
      return result.length > 0;
    })) ?? false;
  }

  async move(id: string, parentId: string | null, position: string, scope: NotepadMutationScope): Promise<boolean> {
    return (await withNotepadWrite(this.db, scope, async (tx) => {
      const result = await tx.update(notepads).set({ parentId, position, updatedAt: Date.now() }).where(and(eq(notepads.id, id), eq(notepads.workspaceId, scope.workspaceId), eq(notepads.projectId, scope.projectId), isNull(notepads.deletedAt), eq(notepads.kind, 'notepad'))).returning({ id: notepads.id });
      return result.length > 0;
    })) ?? false;
  }

  async softDelete(id: string, deletedAt: number, scope: NotepadMutationScope): Promise<boolean> {
    const deletionOperationId = crypto.randomUUID();
    return (await withNotepadWrite(this.db, scope, async (tx) => {
      const [root] = await tx
        .select({
          id: notepads.id,
          projectId: notepads.projectId,
          workspaceId: notepads.workspaceId,
          deletedAt: notepads.deletedAt,
        })
        .from(notepads)
        .where(and(eq(notepads.id, id), eq(notepads.workspaceId, scope.workspaceId), eq(notepads.projectId, scope.projectId), this.sourceProjectMatches()))
        .limit(1);
      if (!root || root.deletedAt !== null) return false;

      const ids = [root.id];
      const seen = new Set(ids);
      let parents = ids;
      while (parents.length > 0) {
        const children = await tx
          .select({ id: notepads.id })
          .from(notepads)
          .where(
            and(
              inArray(notepads.parentId, parents),
              eq(notepads.projectId, root.projectId),
              eq(notepads.workspaceId, root.workspaceId),
            ),
          );
        parents = children.map(({ id: childId }) => childId).filter((childId) => !seen.has(childId));
        for (const childId of parents) seen.add(childId);
        ids.push(...parents);
      }

      await tx
        .update(notepads)
        .set({ deletedAt, deletionOperationId, updatedAt: deletedAt })
        .where(and(inArray(notepads.id, ids), isNull(notepads.deletedAt)));
      await tx.delete(editLocks).where(inArray(editLocks.notepadId, ids));
      return true;
    })) ?? false;
  }

  async restore(id: string, deleteTimestamp: number, scope: NotepadMutationScope): Promise<RestoredNotepad[] | null> {
    return withNotepadWrite(this.db, scope, async (tx) => {
      const [root] = await tx
        .select()
        .from(notepads)
        .where(and(eq(notepads.id, id), eq(notepads.workspaceId, scope.workspaceId), eq(notepads.projectId, scope.projectId), this.sourceProjectMatches()))
        .limit(1);
      if (!root || root.deletedAt !== deleteTimestamp) return [];

      const conditions = [
        eq(notepads.workspaceId, root.workspaceId),
        eq(notepads.projectId, root.projectId),
        isNotNull(notepads.deletedAt),
        root.deletionOperationId
          ? eq(notepads.deletionOperationId, root.deletionOperationId)
          : eq(notepads.deletedAt, deleteTimestamp),
      ];
      const matching = await tx
        .select({
          id: notepads.id,
          parentId: notepads.parentId,
          title: notepads.title,
          content: notepads.content,
          projectId: notepads.projectId,
        })
        .from(notepads)
        .where(and(...conditions));

      if (!root.deletionOperationId && matching.length > 1) {
        throw new Error('ambiguous_delete_group');
      }
      if (matching.length === 0) return [];

      let newParentId = root.parentId;
      let newPosition = root.position;
      if (root.parentId) {
        const [parent] = await tx
          .select({ deletedAt: notepads.deletedAt })
          .from(notepads)
          .where(
            and(
              eq(notepads.id, root.parentId),
              eq(notepads.workspaceId, root.workspaceId),
              eq(notepads.projectId, root.projectId),
            ),
          );
        if (!parent || parent.deletedAt !== null) {
          newParentId = null;
          const [lastRoot] = await tx
            .select({ position: notepads.position })
            .from(notepads)
            .where(
              and(
                eq(notepads.projectId, root.projectId),
                eq(notepads.workspaceId, root.workspaceId),
                isNull(notepads.parentId),
                isNull(notepads.deletedAt),
                eq(notepads.kind, 'notepad'),
              ),
            )
            .orderBy(desc(notepads.position))
            .limit(1);
          if (lastRoot) newPosition = positionAfterLast(lastRoot.position);
        }
      }

      await tx
        .update(notepads)
        .set({ deletedAt: null, deletionOperationId: null, updatedAt: Date.now() })
        .where(inArray(notepads.id, matching.map(({ id: matchId }) => matchId)));

      if (newParentId !== root.parentId || newPosition !== root.position) {
        await tx
          .update(notepads)
          .set({ parentId: newParentId, position: newPosition, updatedAt: Date.now() })
          .where(eq(notepads.id, id));
      }

      return matching;
    });
  }

  async hardDelete(id: string, scope: NotepadMutationScope): Promise<HardDeletedNotepad[] | null> {
    return withNotepadWrite(this.db, scope, async (tx) => {
      const [root] = await tx
        .select({ id: notepads.id, projectId: notepads.projectId, workspaceId: notepads.workspaceId })
        .from(notepads)
        .where(and(eq(notepads.id, id), eq(notepads.workspaceId, scope.workspaceId), eq(notepads.projectId, scope.projectId), this.sourceProjectMatches()))
        .limit(1);
      if (!root) return [];

      const ids = [root.id];
      const seen = new Set(ids);
      let parents = ids;
      while (parents.length > 0) {
        const children = await tx
          .select({ id: notepads.id })
          .from(notepads)
          .where(
            and(
              inArray(notepads.parentId, parents),
              eq(notepads.projectId, root.projectId),
              eq(notepads.workspaceId, root.workspaceId),
            ),
          );
        parents = children.map(({ id: childId }) => childId).filter((childId) => !seen.has(childId));
        for (const childId of parents) seen.add(childId);
        ids.push(...parents);
      }

      const foreignChildren = await tx
        .select({ id: notepads.id })
        .from(notepads)
        .where(
          and(
            inArray(notepads.parentId, ids),
            or(
              ne(notepads.projectId, root.projectId),
              ne(notepads.workspaceId, root.workspaceId),
            ),
          ),
        );
      if (foreignChildren.length > 0) throw new Error('tree_scope_conflict');

      const result = await tx
        .select({ id: notepads.id, coverKey: notepads.coverKey })
        .from(notepads)
        .where(inArray(notepads.id, ids));
      await tx.delete(notepads).where(eq(notepads.id, id));
      return result;
    });
  }

  async countByCoverKey(coverKey: string, excludeNotepadId?: string): Promise<number> {
    const conditions = [eq(notepads.coverKey, coverKey)];
    if (excludeNotepadId) {
      conditions.push(ne(notepads.id, excludeNotepadId));
    }
    const [row] = await this.db
      .select({ count: count() })
      .from(notepads)
      .where(and(...conditions));
    return Number(row?.count ?? 0);
  }

  // Content & versioning
  async getContent(scope: ProjectScope, id: string): Promise<NotepadContent | null> {
    const result = await this.db
      .select({
        id: notepads.id,
        workspaceId: notepads.workspaceId,
        projectId: notepads.projectId,
        title: notepads.title,
        content: notepads.content,
        version: notepads.version,
      })
      .from(notepads)
      .where(and(
        eq(notepads.id, id),
        eq(notepads.workspaceId, scope.workspaceId),
        eq(notepads.projectId, scope.projectId),
        this.sourceProjectMatches(),
      ))
      .limit(1);
    return first(result) ?? null;
  }

  async saveContentBatch(args: SaveContentBatchArgs): Promise<number> {
    if (contentByteLength(args.content) > MAX_CONTENT_BYTES) {
      throw new Error('content_too_large');
    }
    const { row, content, baseVersion, actorId, validLinks, previousLinks, now, lock } = args;
    const { added, removed } = diffLinks(previousLinks, validLinks);

    const saved = await withNotepadWrite(this.db, args.scope, async (tx) => {
      await tx.select({ id: notepads.id }).from(notepads).where(eq(notepads.id, row.id)).for('update');
      const [updated] = await tx
        .update(notepads)
        .set({
          content,
          plainText: extractPlainText(content),
          version: baseVersion + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(notepads.id, row.id),
            eq(notepads.workspaceId, row.workspaceId),
            eq(notepads.projectId, row.projectId),
            eq(notepads.version, baseVersion),
            isNull(notepads.deletedAt),
          ),
        )
        .returning({ version: notepads.version });
      if (!updated) throw new Error('version_conflict');

      const [currentLock] = await tx
        .select()
        .from(editLocks)
        .where(eq(editLocks.notepadId, row.id));
      if (
        currentLock &&
        currentLock.expiresAt > Date.now() &&
        (currentLock.userId !== actorId || currentLock.clientId !== lock?.clientId)
      ) {
        throw new Error('lock_conflict');
      }

      const repo = new PostgresNotepadRepository(tx);
      const mentionedUserIds = added
        .filter((link) => link.targetType === 'user' && link.targetId !== actorId)
        .map((link) => link.targetId);
      if (mentionedUserIds.length > 0) {
        const existing = await tx
          .select({ userId: notepadLinks.targetId })
          .from(notepadLinks)
          .where(
            and(
              eq(notepadLinks.sourceId, row.id),
              eq(notepadLinks.targetType, 'user'),
              inArray(notepadLinks.targetId, mentionedUserIds),
            ),
          );
        const previouslyMentioned = new Set(existing.map((link) => link.userId));
        const values = mentionedUserIds
          .filter((userId) => !previouslyMentioned.has(userId))
          .map((userId) => ({
            id: crypto.randomUUID(),
            workspaceId: row.workspaceId,
            userId,
            type: 'mention' as const,
            actorId,
            notepadId: row.id,
            cardId: null,
            readAt: null,
            createdAt: now,
          }));
        if (values.length > 0) await tx.insert(notifications).values(values);
      }
      await repo.replaceLinks(row.id, added, removed);
      if (lock) {
        const renewal = { ...lock, userId: actorId };
        await tx
          .insert(editLocks)
          .values({ notepadId: row.id, ...renewal })
          .onConflictDoUpdate({
            target: editLocks.notepadId,
            set: renewal,
          });
      }
      return updated.version;
    });
    if (saved === null) throw new Error('workspace_write_forbidden');
    return saved;
  }

  // Tree navigation
  async getChildren(
    scope: ProjectScope,
    parentIds: string[],
  ): Promise<{ id: string; parentId: string | null }[]> {
    if (!parentIds.length) return [];
    return this.db
      .select({ id: notepads.id, parentId: notepads.parentId })
      .from(notepads)
      .where(
        and(
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          isNull(notepads.deletedAt),
          inArray(
            notepads.parentId,
            this.db
              .select({ id: notepads.id })
              .from(notepads)
              .where(
                and(
                  eq(notepads.workspaceId, scope.workspaceId),
                  eq(notepads.projectId, scope.projectId),
                  inArray(notepads.id, parentIds),
                ),
              ),
          ),
        ),
      );
  }

  async getParent(
    scope: ProjectScope,
    id: string,
  ): Promise<{ id: string; parentId: string | null } | null> {
    const [row] = await this.db
      .select({ id: notepads.id, parentId: notepads.parentId })
      .from(notepads)
      .where(
        and(
          eq(notepads.id, id),
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  private projectTargetQuery(scope: ProjectScope, type: StoredLink['targetType'], ids: string[]) {
    if (type === 'user') {
      return this.db
        .select({ id: members.userId })
        .from(members)
        .where(and(eq(members.workspaceId, scope.workspaceId), inArray(members.userId, ids)));
    }
    if (type === 'notepad') {
      return this.db
        .select({ id: notepads.id })
        .from(notepads)
        .innerJoin(
          projects,
          and(eq(projects.id, notepads.projectId), eq(projects.workspaceId, notepads.workspaceId)),
        )
        .where(
          and(
            eq(notepads.workspaceId, scope.workspaceId),
            eq(notepads.projectId, scope.projectId),
            eq(notepads.kind, 'notepad'),
            isNull(notepads.deletedAt),
            inArray(notepads.id, ids),
          ),
        );
    }
    if (type === 'card') {
      return this.db
        .select({ id: cards.id })
        .from(cards)
        .innerJoin(notepads, eq(notepads.id, cards.notepadId))
        .innerJoin(
          boards,
          and(
            eq(boards.id, cards.boardId),
            eq(boards.workspaceId, notepads.workspaceId),
            eq(boards.projectId, notepads.projectId),
          ),
        )
        .innerJoin(
          projects,
          and(eq(projects.id, boards.projectId), eq(projects.workspaceId, boards.workspaceId)),
        )
        .innerJoin(
          boardColumns,
          and(eq(boardColumns.id, cards.columnId), eq(boardColumns.boardId, boards.id)),
        )
        .where(
          and(
            eq(notepads.workspaceId, scope.workspaceId),
            eq(notepads.projectId, scope.projectId),
            eq(notepads.kind, 'card'),
            isNull(notepads.deletedAt),
            isNull(boards.deletedAt),
            inArray(cards.id, ids),
          ),
        );
    }
    return this.db
      .select({ id: boards.id })
      .from(boards)
      .innerJoin(
        projects,
        and(eq(projects.id, boards.projectId), eq(projects.workspaceId, boards.workspaceId)),
      )
      .where(
        and(
          eq(boards.workspaceId, scope.workspaceId),
          eq(boards.projectId, scope.projectId),
          isNull(boards.deletedAt),
          inArray(boards.id, ids),
        ),
      );
  }

  async resolveReference(
    scope: ProjectScope,
    kind: ContentReferenceKind,
    id: string,
  ): Promise<ReferencePreview | null> {
    const targets = this.projectTargetQuery(scope, kind, [id]);
    if (kind === 'card') {
      const [row] = await this.db
        .select({
          id: cards.id,
          workspaceId: notepads.workspaceId,
          projectId: notepads.projectId,
          title: notepads.title,
          boardId: boards.id,
          boardName: boards.name,
          columnName: boardColumns.name,
          priority: cards.priority,
        })
        .from(cards)
        .innerJoin(notepads, eq(notepads.id, cards.notepadId))
        .innerJoin(boards, eq(boards.id, cards.boardId))
        .innerJoin(boardColumns, eq(boardColumns.id, cards.columnId))
        .where(inArray(cards.id, targets))
        .limit(1);
      return row ? { kind, ...row } : null;
    }
    const table = kind === 'notepad' ? notepads : boards;
    const [row] = await this.db
      .select({
        id: table.id,
        workspaceId: table.workspaceId,
        projectId: table.projectId,
        title: kind === 'notepad' ? notepads.title : boards.name,
        icon: table.icon,
      })
      .from(table)
      .where(inArray(table.id, targets))
      .limit(1);
    return row ? { kind, ...row } : null;
  }

  async filterProjectTargets(scope: ProjectScope, links: StoredLink[]): Promise<StoredLink[]> {
    return resolveReferenceTargets(links, async (type, ids) =>
      (await this.projectTargetQuery(scope, type, ids)).map(({ id }) => id),
    );
  }

  // Tags
  async listTagIds(scope: ProjectScope, notepadId: string): Promise<string[]> {
    const result = await this.db
      .select({ tagId: notepadTags.tagId })
      .from(notepadTags)
      .innerJoin(notepads, eq(notepads.id, notepadTags.notepadId))
      .innerJoin(
        projects,
        and(eq(projects.id, notepads.projectId), eq(projects.workspaceId, notepads.workspaceId)),
      )
      .innerJoin(tags, and(eq(tags.id, notepadTags.tagId), eq(tags.projectId, notepads.projectId)))
      .where(and(
        eq(notepadTags.notepadId, notepadId),
        eq(notepads.workspaceId, scope.workspaceId),
        eq(notepads.projectId, scope.projectId),
      ));
    return result.map((r) => r.tagId);
  }

  async setTagIds(notepadId: string, tagIds: string[], scope: NotepadMutationScope): Promise<boolean> {
    return (await withNotepadWrite(this.db, scope, async (tx) => {
      const [note] = await tx.select({ id: notepads.id }).from(notepads).where(and(eq(notepads.id, notepadId), eq(notepads.workspaceId, scope.workspaceId), eq(notepads.projectId, scope.projectId), isNull(notepads.deletedAt), eq(notepads.kind, 'notepad')));
      if (!note) return false;
      if (tagIds.length > 0) {
        const valid = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.projectId, scope.projectId), inArray(tags.id, tagIds)));
        if (valid.length !== tagIds.length) return false;
      }
      await tx.delete(notepadTags).where(eq(notepadTags.notepadId, notepadId));
      if (tagIds.length > 0) await tx.insert(notepadTags).values(tagIds.map((tagId) => ({ notepadId, tagId })));
      return true;
    })) ?? false;
  }

  // Locks
  async getLock(scope: ProjectScope, notepadId: string): Promise<EditLock | null> {
    const result = await this.db
      .select({
        notepadId: editLocks.notepadId,
        userId: editLocks.userId,
        clientId: editLocks.clientId,
        expiresAt: editLocks.expiresAt,
      })
      .from(editLocks)
      .innerJoin(notepads, eq(notepads.id, editLocks.notepadId))
      .where(and(
        eq(editLocks.notepadId, notepadId),
        eq(notepads.workspaceId, scope.workspaceId),
        eq(notepads.projectId, scope.projectId),
        this.sourceProjectMatches(),
      ))
      .limit(1);
    return first(result) ?? null;
  }

  async deleteLock(notepadId: string): Promise<void> {
    await this.db.delete(editLocks).where(eq(editLocks.notepadId, notepadId));
  }

  // FTS
  async deleteFts(_notepadId: string): Promise<void> {
    // FTS is handled by generated column, no separate table
  }

  async insertFts(notepadId: string, _title: string, body: string): Promise<void> {
    // FTS is handled by generated column, no separate table
    await this.db.update(notepads).set({ plainText: body }).where(eq(notepads.id, notepadId));
  }

  // Links
  async listLinks(scope: ProjectScope, sourceId: string): Promise<StoredLink[]> {
    const result = await this.db
      .select({
        targetType: notepadLinks.targetType,
        targetId: notepadLinks.targetId,
      })
      .from(notepadLinks)
      .innerJoin(notepads, eq(notepads.id, notepadLinks.sourceId))
      .where(and(
        eq(notepadLinks.sourceId, sourceId),
        eq(notepads.workspaceId, scope.workspaceId),
        eq(notepads.projectId, scope.projectId),
        this.sourceProjectMatches(),
      ));
    return result as StoredLink[];
  }

  private async replaceLinks(
    sourceId: string,
    added: StoredLink[],
    removed: StoredLink[],
  ): Promise<void> {
    // Remove old links
    if (removed.length > 0) {
      for (const link of removed) {
        await this.db
          .delete(notepadLinks)
          .where(
            and(
              eq(notepadLinks.sourceId, sourceId),
              eq(notepadLinks.targetType, link.targetType),
              eq(notepadLinks.targetId, link.targetId),
            ),
          );
      }
    }
    // Add new links
    if (added.length > 0) {
      await this.db.insert(notepadLinks).values(
        added.map((link) => ({
          sourceId,
          targetType: link.targetType,
          targetId: link.targetId,
        })),
      );
    }
  }

  async listBacklinks(
    scope: ProjectScope,
    notepadId: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: number }>> {
    const liveCardSource = this.db
      .select({ id: cards.id })
      .from(cards)
      .innerJoin(
        boards,
        and(
          eq(boards.id, cards.boardId),
          eq(boards.workspaceId, notepads.workspaceId),
          eq(boards.projectId, notepads.projectId),
        ),
      )
      .innerJoin(
        boardColumns,
        and(eq(boardColumns.id, cards.columnId), eq(boardColumns.boardId, boards.id)),
      )
      .where(and(eq(cards.notepadId, notepads.id), isNull(boards.deletedAt)));
    return this.db
      .select({
        id: notepads.id,
        title: notepads.title,
        updatedAt: notepads.updatedAt,
        icon: notepads.icon,
      })
      .from(notepadLinks)
      .innerJoin(notepads, eq(notepads.id, notepadLinks.sourceId))
      .innerJoin(
        projects,
        and(eq(projects.id, notepads.projectId), eq(projects.workspaceId, notepads.workspaceId)),
      )
      .where(
        and(
          eq(notepadLinks.targetType, 'notepad'),
          inArray(notepadLinks.targetId, this.projectTargetQuery(scope, 'notepad', [notepadId])),
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          isNull(notepads.deletedAt),
          or(eq(notepads.kind, 'notepad'), exists(liveCardSource)),
        ),
      );
  }

  // Position helpers
  async getLastChildPosition(scope: ProjectScope, parentId: string): Promise<string | null> {
    const result = await this.db
      .select({ position: notepads.position })
      .from(notepads)
      .where(
        and(
          eq(notepads.parentId, parentId),
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          this.sourceProjectMatches(),
          eq(notepads.kind, 'notepad'),
          isNull(notepads.deletedAt),
          eq(notepads.kind, 'notepad'),
        ),
      )
      .orderBy(desc(notepads.position))
      .limit(1);
    const row = first(result);
    return row ? positionAfterLast(row.position) : null;
  }

  async getLastRootPosition(scope: ProjectScope): Promise<string | null> {
    const result = await this.db
      .select({ position: notepads.position })
      .from(notepads)
      .where(
        and(
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          this.sourceProjectMatches(),
          isNull(notepads.parentId),
          isNull(notepads.deletedAt),
          eq(notepads.kind, 'notepad'),
        ),
      )
      .orderBy(desc(notepads.position))
      .limit(1);
    const row = first(result);
    return row ? positionAfterLast(row.position) : null;
  }

  async getLastRootNotepadPosition(scope: ProjectScope): Promise<string> {
    const result = await this.db
      .select({ position: notepads.position })
      .from(notepads)
      .where(
        and(
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          this.sourceProjectMatches(),
          isNull(notepads.parentId),
          isNull(notepads.deletedAt),
          eq(notepads.kind, 'notepad'),
        ),
      )
      .orderBy(desc(notepads.position))
      .limit(1);
    const row = first(result);
    return positionAfterLast(row?.position ?? null);
  }

  // Search/suggest
  async findByPattern(
    scope: ProjectScope,
    pattern: string,
    limit: number,
  ): Promise<{ id: string; title: string; icon: string | null }[]> {
    const result = await this.db
      .select({
        id: notepads.id,
        title: notepads.title,
        icon: notepads.icon,
      })
      .from(notepads)
      .where(
        and(
          eq(notepads.workspaceId, scope.workspaceId),
          eq(notepads.projectId, scope.projectId),
          this.sourceProjectMatches(),
          eq(notepads.kind, 'notepad'),
          isNull(notepads.deletedAt),
          sql`${notepads.title} ILIKE ${`%${pattern}%`}`,
        ),
      )
      .limit(limit);
    return result;
  }
}
