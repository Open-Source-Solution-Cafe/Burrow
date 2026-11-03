import type { IStorageAdapter } from '../adapters/storage';
import type { ISearchAdapter } from '../adapters/search';
import type { ILockAdapter } from '../adapters/lock';
import type { IEmailProvider } from '../adapters/email';
import type { ExtractedLink } from '../../shared/extract';
import type { ContentReferenceKind, ReferencePreview } from '../../shared/references';

/**
 * Minimal auth provider interface for the core app factory.
 * Implementations (e.g. BetterAuth) live in the platform layer.
 */
export interface AuthProvider {
  /** Resolve account identity and profile fields from request headers, or null. */
  getSession(
    headers: Headers,
  ): Promise<{ userId: string; email?: string; name?: string; image?: string | null } | null>;
  /** Hono handler for auth endpoints (sign-in, sign-up, etc.). */
  handler(req: Request): Promise<Response>;
}

/**
 * Repository container — all repository interfaces the services depend on.
 * The platform layer provides implementations (D1, Postgres, etc.).
 */
export interface RepositoryContainer {
  workspaces: IWorkspaceRepository;
  projects: IProjectRepository;
  boards: IBoardRepository;
  cards: ICardRepository;
  notepads: INotepadRepository;
  projectFiles: IProjectFileRepository;
  tags: ITagRepository;
  notifications: INotificationRepository;
  members: IMemberRepository;
  invites: IInviteRepository;
}

/**
 * Full infrastructure bundle passed to `createCoreApp`.
 * The platform entrypoint (Worker, Node, etc.) assembles this.
 */
export interface Infrastructure {
  repositories: RepositoryContainer;
  storage: IStorageAdapter;
  search: ISearchAdapter;
  locks: ILockAdapter;
  auth: AuthProvider;
  email: IEmailProvider;
  bootstrapToken: string;
  appUrl?: string;
}

/** Explicit project boundary for repository traversal and resource relationships. */
export interface ProjectScope {
  workspaceId: string;
  projectId: string;
}

// ---------------------------------------------------------------------------
// Repository Interfaces (shapes derived from current worker services)
// ---------------------------------------------------------------------------

export interface IWorkspaceRepository {
  findById(id: string): Promise<Workspace | null>;
  /** Lists only workspaces where this account currently has a membership. */
  listByUser(userId: string): Promise<WorkspaceMembership[]>;
  /** Claim the empty installation for an email; only the same claimant can retry. */
  claimBootstrap(email: string): Promise<boolean>;
  /** Atomically finish the claim for the matching account, or return its already completed workspace on retry. */
  completeBootstrap(email: string, plan: WorkspaceProvisioningPlan): Promise<Workspace | null>;
  /** Atomically create or replay a workspace, owner membership, starter project and starter notepad. */
  create(plan: WorkspaceProvisioningPlan): Promise<Workspace>;
  /** Rename only when the actor is still an owner in this workspace. */
  rename(workspaceId: string, actorUserId: string, name: string): Promise<boolean>;
  count(): Promise<number>;
  releaseBootstrap?(email: string): Promise<boolean>;
}

export interface WorkspaceMembership {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  createdAt: number;
}

export interface WorkspaceProvisioningPlan {
  workspace: Workspace;
  owner: CreateMemberData;
  project: CreateProjectData;
  notepad: CreateNotepadData;
}

export interface IProjectRepository {
  listByWorkspace(workspaceId: string): Promise<Project[]>;
  /** Legacy single-project file reads may resolve a project only when this account remains a member. */
  findByIdForMember(projectId: string, userId: string): Promise<Project | null>;
  findByIdAndWorkspace(id: string, workspaceId: string): Promise<Project | null>;
  /** Insert only if the actor is currently an editor/owner and the active workspace tail matches. */
  createGuarded(
    data: CreateProjectData,
    actorUserId: string,
    expectedLast: ProjectPosition | null,
  ): Promise<boolean>;
  /** Update only the named workspace's project while the actor is currently an editor/owner. */
  updateGuarded(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    data: UpdateProjectData,
  ): Promise<boolean>;
  /** Move only if current actor, target position, and adjacent active workspace projects match the snapshot. */
  moveGuarded(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    position: string,
    expected: ProjectMoveSnapshot,
  ): Promise<boolean>;
  /** Revalidate owner/workspace/confirmation inside the delete transaction; return distinct pre-cascade cover and project-file keys for post-commit reference checks. */
  hardDeleteGuarded(
    workspaceId: string,
    actorUserId: string,
    projectId: string,
    confirmName: string,
  ): Promise<string[] | null>;
}

export interface ProjectFile {
  projectId: string;
  storageKey: string;
  contentType: string;
  createdBy: string;
  createdAt: number;
  /** Original display filename when known; legacy registrations may omit it. */
  filename?: string | null;
  /** Stored object size in bytes when known; legacy registrations may omit it. */
  byteSize?: number | null;
}

export interface IProjectFileRepository {
  /** Register a project/key pair once; a shared key may have one registration per project. */
  register(file: ProjectFile): Promise<boolean>;
  /** Finds metadata only for the requested project/key pair. */
  findByProjectAndKey(projectId: string, storageKey: string): Promise<ProjectFile | null>;
  /** Counts registrations across all projects that reference this storage key. */
  countByStorageKey(storageKey: string): Promise<number>;
  /** Lists sorted, distinct project IDs that register this storage key. */
  listProjectIdsByStorageKey(storageKey: string): Promise<string[]>;
  /** Lists distinct storage keys registered to the requested project. */
  listStorageKeysByProject(projectId: string): Promise<string[]>;
  /** Lists every distinct registered storage key in deterministic order for read-only inventory. */
  listAllStorageKeys(): Promise<string[]>;
}

export interface ProjectPosition {
  id: string;
  position: string;
}
export interface ProjectMoveSnapshot {
  targetPosition: string;
  previous: ProjectPosition | null;
  next: ProjectPosition | null;
}

/** Actor and workspace scope required for an atomic board/column write. */
export interface BoardMutationScope {
  workspaceId: string;
  actorUserId: string;
  minimumRole: 'editor' | 'owner';
}

export interface IBoardRepository {
  /** Live boards in the explicit workspace/project pair whose stored ownership agrees with the project. */
  listByProject(scope: ProjectScope): Promise<Board[]>;
  /** Returns a board only when its project and workspace both match this scope. */
  findByIdInScope(scope: ProjectScope, id: string): Promise<Board | null>;
  /** Atomically create a board and its starter columns only for a current editor/owner in the workspace. */
  createWithColumns(
    data: CreateBoardData,
    columns: CreateColumnData[],
    scope: BoardMutationScope,
  ): Promise<boolean>;
  /** Update only a live board in scope for a current editor/owner. */
  updateGuarded(id: string, data: UpdateBoardData, scope: BoardMutationScope): Promise<boolean>;
  /** Soft-delete a board and its live card bodies only for a current editor/owner in scope. */
  softDeleteGuarded(id: string, deletedAt: number, scope: BoardMutationScope): Promise<boolean>;
  /** Restores only card bodies carrying this board's stored deletion-operation ID. */
  restoreGuarded(id: string, scope: BoardMutationScope): Promise<boolean>;
  /** Permanently delete only a trashed board for a current workspace owner. */
  hardDeleteGuarded(id: string, scope: BoardMutationScope): Promise<boolean>;
  // Trash
  /** Deleted boards in the explicit workspace/project pair whose stored ownership agrees with the project. */
  listDeletedByProject(scope: ProjectScope): Promise<Board[]>;
  // Columns
  /** Columns for a board in the supplied workspace and project; foreign/mismatched boards return no rows. */
  listColumns(scope: ProjectScope, boardId: string): Promise<BoardColumn[]>;
  /** Returns a column only when its board and project both match this scope. */
  findColumnByIdInScope(scope: ProjectScope, columnId: string): Promise<BoardColumn | null>;
  createColumnGuarded(data: CreateColumnData, scope: BoardMutationScope): Promise<boolean>;
  updateColumnGuarded(
    id: string,
    data: UpdateColumnData,
    scope: BoardMutationScope,
  ): Promise<boolean>;
  moveColumnGuarded(id: string, position: string, scope: BoardMutationScope): Promise<boolean>;
  /** Move any cards to a same-board destination (when supplied) and delete the empty column atomically. */
  deleteColumnGuarded(
    id: string,
    moveToColumnId: string | null,
    scope: BoardMutationScope,
  ): Promise<boolean>;
  /** Returns a live board with live, source-consistent cards only in the explicit project/workspace scope. */
  getBoardWithDetails(scope: ProjectScope, boardId: string): Promise<BoardWithDetails | null>;
}

export interface ICardRepository {
  /** Returns a card only when its board, column, body, project and workspace agree with scope; includes trash for lifecycle checks. */
  findByIdInScope(scope: ProjectScope, id: string): Promise<Card | null>;
  /** Returns a source-consistent live card on a live board; identity metadata requires membership in the scoped workspace. */
  getCardWithDetails(scope: ProjectScope, id: string): Promise<CardWithDetails | null>;
  /**
   * Atomically validate the actor's editor role and persist a workspace/project plan and all child rows.
   * Existing linked notes remain unchanged; newly linked notes and card bodies are live,
   * and only the service-selected assignees receive assignment notifications.
   */
  createFromPlan(plan: CardPlan): Promise<boolean>;
  /** Atomically update card metadata, assignees, tags, title/index and assignment notifications. */
  updateGuarded(args: UpdateCardMutation): Promise<boolean>;
  /** Move a live card to a live same-workspace column while the actor is still an editor. */
  moveGuarded(
    id: string,
    columnId: string,
    position: string,
    scope: CardMutationScope,
  ): Promise<boolean>;
  // Subtasks
  /** Subtasks for a card whose board, column and body agree with the supplied workspace and project. */
  listSubtasks(scope: ProjectScope, cardId: string): Promise<CardSubtask[]>;
  createSubtaskGuarded(
    data: CreateSubtaskData,
    scope: CardMutationScope,
  ): Promise<CardSubtask | null>;
  updateSubtaskGuarded(
    id: string,
    cardId: string,
    data: UpdateSubtaskData,
    scope: CardMutationScope,
  ): Promise<boolean>;
  deleteSubtaskGuarded(id: string, cardId: string, scope: CardMutationScope): Promise<boolean>;
  // Assignees
  /** Assignees for a card whose board, column and body agree with the supplied workspace and project. */
  listAssignees(scope: ProjectScope, cardId: string): Promise<CardAssignee[]>;
  validateAssignees(workspaceId: string, userIds: string[]): Promise<{ userId: string }[]>;
  // Tags
  /** Tags for a notepad body only when both its project and workspace match scope. */
  listTagIds(scope: ProjectScope, notepadId: string): Promise<string[]>;
  // Comments
  /** Comments for a card whose board, column and body agree with the supplied workspace and project. */
  listComments(scope: ProjectScope, cardId: string): Promise<Comment[]>;
  /** Creates a comment and current-member mention notifications atomically if the actor is still an editor. */
  createCommentGuarded(args: CreateCommentMutation): Promise<Comment | null>;
  /** Returns a comment only when its card and source graph belong to the supplied workspace/project. */
  getComment(scope: ProjectScope, id: string, cardId: string): Promise<Comment | null>;
  /** Deletes only if the actor remains an editor and owns the comment or is a workspace owner. */
  deleteCommentGuarded(
    id: string,
    cardId: string,
    scope: CardMutationScope,
  ): Promise<CommentDeleteResult>;
  // Queries
  /** Live cards in a column whose board, body, column and project agree with the supplied scope. */
  listByColumn(scope: ProjectScope, columnId: string): Promise<Card[]>;
  /** Workspace-assigned live cards with consistent board, project, body and column ownership. */
  getMyTasks(workspaceId: string, userId: string, filters: MyTasksFilters): Promise<MyTaskItem[]>;
  /** Live cards on live boards in this project/workspace with consistent board/column/body ownership; foreign/deleted IDs are omitted. */
  getCardsSummary(scope: ProjectScope, cardIds: string[]): Promise<CardSummary[]>;
  // Search/suggest
  /** Live, source-consistent cards on live boards in the explicit workspace/project scope. */
  findByPattern(
    scope: ProjectScope,
    pattern: string,
    limit: number,
  ): Promise<{ id: string; title: string; boardName: string; priority: CardPriority | null }[]>;
}

export interface CardMutationScope {
  workspaceId: string;
  actorUserId: string;
  minimumRole: 'editor' | 'owner';
}

export interface UpdateCardMutation {
  cardId: string;
  scope: CardMutationScope;
  data: UpdateCardData;
  assigneeIds?: string[];
  tagIds?: string[];
  title?: { value: string; plainText: string };
  /** Candidate recipients; adapters notify only newly added current members. */
  assignmentNotifications?: Array<{ id: string; userId: string }>;
  now: number;
}

export interface CreateCommentMutation {
  data: CreateCommentData;
  scope: CardMutationScope;
  /** Notification IDs are allocated by the service; stale/nonmember mention targets are omitted by adapters. */
  mentionNotifications: Array<{ id: string; userId: string }>;
  now: number;
}

export type CommentDeleteResult = 'deleted' | 'not_found' | 'forbidden';

export interface INotepadRepository {
  /** Live, consistent note-tree rows only for the explicit workspace/project pair; excludes card bodies and trash. */
  listByProject(scope: ProjectScope): Promise<Notepad[]>;
  /** Returns a note or card body only when its project and workspace both match this scope. */
  findByIdInScope(scope: ProjectScope, id: string): Promise<Notepad | null>;
  /** Create the note and index row only if the actor remains an editor in its project workspace. */
  create(data: CreateNotepadData, scope: NotepadMutationScope): Promise<boolean>;
  /** Update only a live note in scope while the actor remains an editor/owner. */
  update(id: string, data: UpdateNotepadData, scope: NotepadMutationScope): Promise<boolean>;
  /** Move only a live note in scope while the actor remains an editor/owner. */
  move(
    id: string,
    parentId: string | null,
    position: string,
    scope: NotepadMutationScope,
  ): Promise<boolean>;
  /** Soft-delete the live subtree rooted at id in one write command; preserve deleted descendants and require current editor membership. */
  softDelete(id: string, deletedAt: number, scope: NotepadMutationScope): Promise<boolean>;
  /** Restore only rows carrying the root's deletion-operation ID; return null when actor scope is no longer authorized. */
  restore(
    id: string,
    deleteTimestamp: number,
    scope: NotepadMutationScope,
  ): Promise<RestoredNotepad[] | null>;
  /** Hard-delete the scoped subtree atomically; reject corrupt cross-project child edges and return removed cover metadata; null means unauthorized. */
  hardDelete(id: string, scope: NotepadMutationScope): Promise<HardDeletedNotepad[] | null>;
  // Trash
  /** Trashed rows for the explicit workspace/project pair whose stored scope agrees with the project. */
  listDeletedByProject(scope: ProjectScope): Promise<Notepad[]>;
  // Content & versioning
  /** Returns content only when the notepad belongs to the explicit workspace/project pair. */
  getContent(scope: ProjectScope, id: string): Promise<NotepadContent | null>;
  /** Commit content, version, index, links, mentions and optional lock renewal together. */
  saveContentBatch(args: SaveContentBatchArgs): Promise<number>;
  /** Keep live content targets in this project and user targets in this workspace; deduplicate references. */
  filterProjectTargets(scope: ProjectScope, links: StoredLink[]): Promise<StoredLink[]>;
  /** Minimal live preview in the source project; missing, deleted, corrupt or foreign targets return null. */
  resolveReference(
    scope: ProjectScope,
    kind: ContentReferenceKind,
    id: string,
  ): Promise<ReferencePreview | null>;
  // Tree navigation (for core services)
  /** Live children within both scope IDs; foreign parent IDs yield no rows. */
  getChildren(
    scope: ProjectScope,
    parentIds: string[],
  ): Promise<{ id: string; parentId: string | null }[]>;
  /** Scoped topology lookup, including trashed rows; foreign/missing IDs return null. */
  getParent(
    scope: ProjectScope,
    id: string,
  ): Promise<{ id: string; parentId: string | null } | null>;
  /**
   * Counts how many notepads currently reference the given coverKey.
   * If excludeNotepadId is specified, excludes that notepad row from the count.
   */
  countByCoverKey(coverKey: string, excludeNotepadId?: string): Promise<number>;
  // Tags
  /** Tag IDs associated with a note only when the note and tags are in the explicit project/workspace scope. */
  listTagIds(scope: ProjectScope, notepadId: string): Promise<string[]>;
  /** Replace note tag associations only while the actor remains an editor in this project. */
  setTagIds(notepadId: string, tagIds: string[], scope: NotepadMutationScope): Promise<boolean>;
  // Locks (delegated to lock adapter, but repo may need to read/delete lock row)
  /** Fetches the raw edit lock row only when its notepad belongs to the explicit workspace/project pair. */
  getLock(scope: ProjectScope, notepadId: string): Promise<EditLock | null>;
  /** Unconditionally removes any edit lock row for notepadId (e.g. on soft-delete or cleanup). */
  deleteLock(notepadId: string): Promise<void>;
  // FTS (delegated to search adapter, but repo may need direct FTS ops)
  deleteFts(notepadId: string): Promise<void>;
  insertFts(notepadId: string, title: string, body: string): Promise<void>;
  // Links
  /** Stored outgoing links for a source note in the explicit project/workspace scope. */
  listLinks(scope: ProjectScope, sourceId: string): Promise<StoredLink[]>;
  /** Live sources and target must belong to this project/workspace; missing, deleted or foreign targets return no backlinks. */
  listBacklinks(
    scope: ProjectScope,
    notepadId: string,
  ): Promise<Array<{ id: string; title: string; updatedAt: number }>>;
  // Position helpers
  /** Returns next position after the last live note child in scope, or null; card bodies and trash are excluded. */
  getLastChildPosition(scope: ProjectScope, parentId: string): Promise<string | null>;
  /** Returns next position after the last live root note in scope, or null; card bodies and trash are excluded. */
  getLastRootPosition(scope: ProjectScope): Promise<string | null>;
  /** Returns next root note position in scope, or the initial position when empty. */
  getLastRootNotepadPosition(scope: ProjectScope): Promise<string>;
  // Search/suggest
  findByPattern(
    scope: ProjectScope,
    pattern: string,
    limit: number,
  ): Promise<{ id: string; title: string; icon: string | null }[]>;
}

/** Actor and tenant scope required by every note/tree/content write command. */
export interface NotepadMutationScope {
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  minimumRole: 'editor' | 'owner';
}

/** Explicit tenant and actor scope for project tag mutations. */
export type TagMutationScope = NotepadMutationScope;

export interface ITagRepository {
  /** All tags for the explicit workspace/project pair; tags from inconsistent projects are omitted. */
  listByProject(scope: ProjectScope): Promise<Tag[]>;
  /** Returns a tag only when its project and workspace both match this scope. */
  findByIdInScope(scope: ProjectScope, id: string): Promise<Tag | null>;
  /** Create only when the actor retains editor access to the requested project workspace. */
  createGuarded(data: CreateTagData, scope: TagMutationScope): Promise<Tag | null>;
  /** Update only a tag in scope while the actor retains editor access. */
  updateGuarded(id: string, data: UpdateTagData, scope: TagMutationScope): Promise<boolean>;
  /** Delete only a tag in scope while the actor retains editor access. */
  deleteGuarded(id: string, scope: TagMutationScope): Promise<boolean>;
  /** Finds a tag name only in the explicit workspace/project pair. */
  findByName(scope: ProjectScope, name: string): Promise<Tag | null>;
  /** Returns only requested tags that belong to the explicit workspace/project pair. */
  validateByProject(scope: ProjectScope, tagIds: string[]): Promise<{ id: string }[]>;
  /** Matching tags only in the explicit workspace/project pair. */
  findByPattern(
    scope: ProjectScope,
    pattern: string,
    limit: number,
  ): Promise<{ id: string; name: string; color: string | null }[]>;
}

export interface INotificationRepository {
  listByUser(userId: string, workspaceId: string, unreadOnly: boolean): Promise<Notification[]>;
  /** Mark only the requested unread notifications owned by this user in this workspace; empty IDs are a no-op. */
  markRead(userId: string, workspaceId: string, notificationIds: string[]): Promise<void>;
  /** Mark only this user's unread notifications in this workspace; preserve already-read timestamps. */
  markAllRead(userId: string, workspaceId: string): Promise<void>;
  createMentions(args: {
    workspaceId: string;
    notepadId: string;
    cardId: string | null;
    actorId: string;
    userIds: string[];
    now: number;
  }): Promise<void>;
  createAssignments(args: {
    workspaceId: string;
    notepadId: string;
    cardId: string;
    actorId: string;
    userIds: string[];
    now: number;
  }): Promise<void>;
}

export interface IMemberRepository {
  listByWorkspace(workspaceId: string): Promise<Member[]>;
  findByUserId(workspaceId: string, userId: string): Promise<Member | null>;
  findByUserIds(workspaceId: string, userIds: string[]): Promise<{ userId: string }[]>;
  findByPattern(
    workspaceId: string,
    pattern: string,
    limit: number,
  ): Promise<{ userId: string; name: string; email: string; image: string | null }[]>;
  /** Atomically require a current workspace owner and preserve at least one owner. */
  updateRole(args: ChangeRoleArgs): Promise<void>;
  /** Atomically require a current owner or self, preserve at least one owner, and remove only this workspace's membership/assignments/locks; preserve account sessions. */
  remove(args: RemoveMemberArgs): Promise<void>;
  create(data: CreateMemberData): Promise<Member>;
  /**
   * Checks whether a user account exists for the given email address (case-insensitive).
   */
  userExists(email: string): Promise<boolean>;
}

export interface ChangeRoleArgs {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  newRole: 'owner' | 'editor' | 'viewer';
}

export interface RemoveMemberArgs {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
}

export interface IInviteRepository {
  listPending(workspaceId: string): Promise<Invite[]>;
  findByTokenHash(tokenHash: string): Promise<Invite | null>;
  create(data: CreateInviteData): Promise<Invite>;
  /** Atomically consume a valid matching invite and create membership, preserving an existing role.
   * An existing membership in another workspace does not block the invite; returns null for
   * invalid, consumed, expired or email-mismatched invitations. */
  acceptForUser(
    tokenHash: string,
    userId: string,
    now: number,
  ): Promise<{
    workspaceId: string;
    role: 'owner' | 'editor' | 'viewer';
  } | null>;
  delete(id: string, workspaceId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Entity Types (minimal shapes matching the database schema)
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
}

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  color: string | null;
  position: string;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectData {
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  color: string | null;
  position: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateProjectData {
  name?: string;
  icon?: string | null;
  color?: string | null;
  archivedAt?: number | null;
  updatedAt: number;
}

export interface Board {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  icon: string | null;
  position: string;
  deletedAt: number | null;
  deletionOperationId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateBoardData {
  id: string;
  workspaceId: string;
  projectId: string;
  name: string;
  icon: string | null;
  position: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateBoardData {
  name?: string;
  icon?: string | null;
  updatedAt: number;
}

export interface BoardColumn {
  id: string;
  boardId: string;
  name: string;
  color: string | null;
  position: string;
  wipLimit: number | null;
}

export interface BoardWithDetails extends Board {
  columns: Array<
    BoardColumn & {
      cards: Array<{
        id: string;
        columnId: string;
        notepadId: string;
        title: string;
        position: string;
        priority: CardPriority | null;
        dueDate: number | null;
        createdAt: number;
        assignees: Array<{ userId: string; name: string; image?: string | null }>;
        tags: Array<{ id: string; name: string; color?: string | null }>;
        totalSubtasks: number;
        completedSubtasks: number;
      }>;
    }
  >;
}

export interface CreateColumnData {
  id: string;
  boardId: string;
  name: string;
  color: string | null;
  position: string;
  wipLimit: number | null;
}

export interface UpdateColumnData {
  name?: string;
  color?: string | null;
  wipLimit?: number | null;
}

export interface Card {
  id: string;
  boardId: string;
  columnId: string;
  notepadId: string;
  position: string;
  priority: CardPriority | null;
  dueDate: number | null;
  createdAt: number;
  projectId: string;
  title?: string;
  content?: string;
  version?: number;
  workspaceId?: string;
  deletedAt?: number | null;
}

export interface CardWithDetails extends Card {
  title: string;
  content: string;
  version: number;
  workspaceId: string;
  boardName: string;
  columnName: string;
  assignees: Array<{ userId: string; name: string; image?: string | null }>;
  tags: Array<{ id: string; name: string; color?: string | null }>;
  subtasks: CardSubtask[];
  lock: { userId?: string; clientId?: string; name: string; expiresAt: number } | null;
}

/** Validated creation inputs shared by every adapter; IDs and time are supplied by the service. */
export interface CardPlan {
  workspaceId: string;
  projectId: string;
  boardId: string;
  columnId: string;
  actorId: string;
  cardId: string;
  notepadId: string;
  title: string;
  content: string;
  plainText: string;
  priority: CardPriority | null;
  dueDate: number | null;
  assigneeIds: string[];
  tagIds: string[];
  assignmentNotifications: Array<{ id: string; userId: string }>;
  cardPosition: string;
  linkedNotepad: { id: string; position: string; title: string; mode: 'existing' | 'new' } | null;
  now: number;
}

export interface UpdateCardData {
  columnId?: string;
  position?: string;
  priority?: CardPriority | null;
  dueDate?: number | null;
}

export type CardPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface Notepad {
  id: string;
  workspaceId: string;
  projectId: string;
  parentId: string | null;
  kind: 'notepad' | 'card';
  title: string;
  icon: string | null;
  coverKey: string | null;
  content: string;
  version: number;
  position: string;
  isFavorite: boolean;
  deletedAt: number | null;
  deletionOperationId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNotepadData {
  id: string;
  workspaceId: string;
  projectId: string;
  parentId: string | null;
  kind: 'notepad' | 'card';
  title: string;
  content: string;
  version: number;
  position: string;
  isFavorite: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpdateNotepadData {
  title?: string;
  icon?: string | null;
  coverKey?: string | null;
  isFavorite?: boolean;
  updatedAt: number;
}

export interface NotepadContent {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  content: string;
  version: number;
}

export interface RestoredNotepad {
  id: string;
  parentId: string | null;
  title: string;
  content: string;
  projectId: string;
}

export interface HardDeletedNotepad {
  id: string;
  coverKey: string | null;
}

export interface NotepadBacklink {
  id: string;
  title: string;
  updatedAt: number;
  icon?: string | null;
}

export interface Tag {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
}

export interface CreateTagData {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
}

export interface UpdateTagData {
  name?: string;
  color?: string | null;
}

export interface Notification {
  id: string;
  workspaceId: string;
  userId: string;
  type: 'mention' | 'assigned';
  actorId: string;
  actorName: string | null;
  actorImage?: string | null;
  targetTitle?: string | null;
  notepadId: string | null;
  cardId: string | null;
  readAt: number | null;
  createdAt: number;
}

export interface Member {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: number;
  name?: string;
  email?: string;
  image?: string | null;
}

export interface CreateMemberData {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: number;
}

export interface Invite {
  id: string;
  workspaceId: string;
  email: string;
  role: 'editor' | 'viewer';
  tokenHash: string;
  invitedBy: string;
  expiresAt: number;
  acceptedAt: number | null;
  createdAt: number;
}

export interface CreateInviteData {
  id: string;
  workspaceId: string;
  email: string;
  role: 'editor' | 'viewer';
  tokenHash: string;
  invitedBy: string;
  expiresAt: number;
  createdAt: number;
}

export interface CardSubtask {
  id: string;
  cardId: string;
  title: string;
  completed: boolean;
  position: string;
  createdAt: number;
}

export interface CreateSubtaskData {
  id: string;
  cardId: string;
  title: string;
  completed: boolean;
  position: string;
  createdAt: number;
}

export interface UpdateSubtaskData {
  title?: string;
  completed?: boolean;
  position?: string;
}

export interface CardAssignee {
  cardId: string;
  userId: string;
  name: string;
  image: string | null;
}

export interface MyTasksFilters {
  status?: 'all' | 'open' | 'completed';
  projectId?: string;
}

export interface MyTaskItem {
  id: string;
  notepadId: string;
  boardId: string;
  columnId: string;
  projectId: string;
  title: string;
  dueDate: number | null;
  priority: CardPriority | null;
  isCompleted: boolean;
  createdAt: number;
  boardName: string;
  columnName: string;
  projectName: string;
  projectIcon: string | null;
  projectColor: string | null;
  tags: Array<{ id: string; name: string; color: string | null }>;
}

export interface CardSummary {
  id: string;
  notepadId: string;
  title: string;
  boardId: string;
  boardName: string;
  columnId: string;
  columnName: string;
  priority: CardPriority | null;
  dueDate: number | null;
  assignees: Array<{ userId: string; name: string; image: string | null }>;
}

export interface Comment {
  id: string;
  cardId: string;
  userId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  name: string;
  image: string | null;
}

export interface CreateCommentData {
  id: string;
  cardId: string;
  userId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export type StoredLink = ExtractedLink;

export interface EditLock {
  notepadId: string;
  userId: string;
  clientId: string;
  expiresAt: number;
}

export interface SaveContentBatchArgs {
  row: { id: string; workspaceId: string; projectId: string; title: string };
  scope: NotepadMutationScope;
  content: string;
  baseVersion: number;
  actorId: string;
  validLinks: StoredLink[];
  previousLinks: StoredLink[];
  now: number;
  lock?: { clientId: string; userId: string; expiresAt: number };
}
