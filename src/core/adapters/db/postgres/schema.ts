import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  customType,
  primaryKey,
  index,
  uniqueIndex,
  pgEnum,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Burrow Drizzle schema for PostgreSQL (pg-core).
 * Domain timestamps are bigint Unix milliseconds; auth timestamps map to Date.
 * IDs are text (nanoid). Search uses a generated tsvector and GIN index.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const roleEnum = pgEnum('role', ['owner', 'editor', 'viewer']);
export const inviteRoleEnum = pgEnum('invite_role', ['editor', 'viewer']);
export const notepadKindEnum = pgEnum('notepad_kind', ['notepad', 'card']);
export const cardPriorityEnum = pgEnum('card_priority', ['low', 'medium', 'high', 'urgent']);
export const notificationTypeEnum = pgEnum('notification_type', ['mention', 'assigned']);
export const linkTargetTypeEnum = pgEnum('link_target_type', ['user', 'notepad', 'card', 'board']);

// ---------------------------------------------------------------------------
// Better Auth tables
// ---------------------------------------------------------------------------

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      precision: 3,
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
      precision: 3,
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull(),
});

// ---------------------------------------------------------------------------
// Workspace / members / invites
// ---------------------------------------------------------------------------

export const bootstrapState = pgTable(
  'bootstrap_state',
  {
    id: integer('id').primaryKey(),
    status: text('status', { enum: ['empty', 'claimed', 'complete'] }).notNull(),
    claimEmail: text('claim_email'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
  },
  (t) => [
    check('bootstrap_singleton', sql`${t.id} = 1`),
    check(
      'bootstrap_state_valid',
      sql`(${t.status} = 'empty' AND ${t.claimEmail} IS NULL AND ${t.userId} IS NULL AND ${t.workspaceId} IS NULL)
        OR (${t.status} = 'claimed' AND ${t.claimEmail} IS NOT NULL AND ${t.userId} IS NULL AND ${t.workspaceId} IS NULL)
        OR (${t.status} = 'complete' AND ((${t.userId} IS NULL AND ${t.workspaceId} IS NULL) OR (${t.claimEmail} IS NOT NULL AND ${t.userId} IS NOT NULL AND ${t.workspaceId} IS NOT NULL)))`,
    ),
  ],
);

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const members = pgTable(
  'members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: roleEnum('role').notNull(),
    joinedAt: bigint('joined_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('members_user').on(t.userId)],
);

export const invites = pgTable(
  'invites',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: inviteRoleEnum('role').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: text('invited_by').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    acceptedAt: bigint('accepted_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [uniqueIndex('invites_token_hash_uq').on(t.tokenHash)],
);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon'),
    color: text('color'),
    position: text('position').notNull(),
    archivedAt: bigint('archived_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('projects_ws').on(t.workspaceId, t.position)],
);

export const projectFiles = pgTable(
  'project_files',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    filename: text('filename'),
    byteSize: integer('byte_size'),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.storageKey] }),
    index('project_files_storage_key_idx').on(t.storageKey),
  ],
);

// ---------------------------------------------------------------------------
// Notepads
// ---------------------------------------------------------------------------

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const notepads = pgTable(
  'notepads',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): any => notepads.id, { onDelete: 'cascade' }),
    kind: notepadKindEnum('kind').notNull().default('notepad'),
    title: text('title').notNull().default('Untitled'),
    icon: text('icon'),
    coverKey: text('cover_key'),
    content: text('content').notNull().default('[]'),
    version: integer('version').notNull().default(1),
    position: text('position').notNull(),
    isFavorite: boolean('is_favorite').notNull().default(false),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    deletionOperationId: text('deletion_operation_id'),
    createdBy: text('created_by').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
    // Plain text extracted from content JSON for FTS
    plainText: text('plain_text'),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('english'::regconfig, title || ' ' || coalesce(plain_text, ''))`,
    ),
  },
  (t) => [
    index('notepads_tree').on(t.projectId, t.parentId, t.position),
    index('notepads_deleted_idx').on(t.projectId, t.deletedAt),
    index('notepads_project_deleted_position_idx').on(t.projectId, t.deletedAt, t.position),
    index('notepads_deletion_operation_idx').on(t.deletionOperationId),
    index('notepads_fts_idx').using('gin', t.searchVector),
  ],
);

// ---------------------------------------------------------------------------
// Boards, columns, cards
// ---------------------------------------------------------------------------

export const boards = pgTable(
  'boards',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon'),
    position: text('position').notNull(),
    deletedAt: bigint('deleted_at', { mode: 'number' }),
    deletionOperationId: text('deletion_operation_id'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('boards_project').on(t.projectId, t.position)],
);

export const boardColumns = pgTable(
  'board_columns',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    position: text('position').notNull(),
    wipLimit: integer('wip_limit'),
  },
  (t) => [index('columns_board').on(t.boardId, t.position)],
);

export const cards = pgTable(
  'cards',
  {
    id: text('id').primaryKey(),
    boardId: text('board_id')
      .notNull()
      .references(() => boards.id, { onDelete: 'cascade' }),
    columnId: text('column_id')
      .notNull()
      .references(() => boardColumns.id, { onDelete: 'cascade' }),
    notepadId: text('notepad_id')
      .notNull()
      .unique()
      .references(() => notepads.id, { onDelete: 'cascade' }),
    position: text('position').notNull(),
    priority: cardPriorityEnum('priority'),
    dueDate: bigint('due_date', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('cards_column').on(t.columnId, t.position)],
);

export const cardAssignees = pgTable(
  'card_assignees',
  {
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.cardId, t.userId] })],
);

export const cardSubtasks = pgTable(
  'card_subtasks',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    completed: boolean('completed').notNull().default(false),
    position: text('position').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('subtasks_card').on(t.cardId, t.position)],
);

// ---------------------------------------------------------------------------
// Card comments (discussion thread)
// ---------------------------------------------------------------------------

export const cardComments = pgTable(
  'card_comments',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('comments_card').on(t.cardId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export const tags = pgTable(
  'tags',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
  },
  (t) => [uniqueIndex('tags_project_name_uq').on(t.projectId, t.name)],
);

export const notepadTags = pgTable(
  'notepad_tags',
  {
    notepadId: text('notepad_id')
      .notNull()
      .references(() => notepads.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.notepadId, t.tagId] })],
);

// ---------------------------------------------------------------------------
// References found inside notepad content (backlinks, notification diffing)
// ---------------------------------------------------------------------------

export const notepadLinks = pgTable(
  'notepad_links',
  {
    sourceId: text('source_id')
      .notNull()
      .references(() => notepads.id, { onDelete: 'cascade' }),
    targetType: linkTargetTypeEnum('target_type').notNull(),
    targetId: text('target_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.targetType, t.targetId] }),
    index('links_target').on(t.targetType, t.targetId),
  ],
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    type: notificationTypeEnum('type').notNull(),
    actorId: text('actor_id').notNull(),
    notepadId: text('notepad_id').references(() => notepads.id, { onDelete: 'cascade' }),
    cardId: text('card_id').references(() => cards.id, { onDelete: 'cascade' }),
    readAt: bigint('read_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [index('notifications_user').on(t.userId, t.readAt, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Soft edit locks
// ---------------------------------------------------------------------------

export const editLocks = pgTable('edit_locks', {
  notepadId: text('notepad_id')
    .primaryKey()
    .references(() => notepads.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  clientId: text('client_id').notNull(),
  expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
});

// ---------------------------------------------------------------------------
// Schema export for BetterAuth
// ---------------------------------------------------------------------------

export const schema = {
  user,
  session,
  account,
  verification,
  workspaces,
  members,
  invites,
  projects,
  projectFiles,
  notepads,
  boards,
  boardColumns,
  cards,
  cardAssignees,
  cardSubtasks,
  cardComments,
  tags,
  notepadTags,
  notepadLinks,
  notifications,
  editLocks,
};
