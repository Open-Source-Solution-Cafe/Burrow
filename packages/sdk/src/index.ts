export const BURROW_SDK_VERSION = '0.4.0';

export type Permission =
  | 'db:own'
  | 'routes:api'
  | 'events:read'
  | 'events:before'
  | 'policy:override'
  | 'auth:override'
  | 'storage:override'
  | 'mailer:override'
  | 'mentions:register'
  | 'cards:register'
  | 'ui:register';

export interface PluginManifest {
  /** Unique lowercase slug matching /^[a-z][a-z0-9-]{0,30}$/. DB tables use prefix `plugin_<id>_`. */
  id: string;
  name?: string;
  version: string;
  /** SemVer range supported by the plugin (e.g. "^0.4.0"). */
  sdkVersion: string;
  permissions: readonly Permission[];
  description?: string;
}

export interface BurrowEventMap {
  'task.created': {
    workspaceId: string;
    projectId: string;
    boardId: string;
    columnId: string;
    cardId: string;
    notepadId: string;
    title: string;
    actorId: string;
    cardType?: string;
  };
  'task.updated': {
    workspaceId: string;
    projectId: string;
    cardId: string;
    actorId: string;
  };
  'task.deleted': {
    workspaceId: string;
    projectId: string;
    cardId: string;
    actorId: string;
  };
  'notepad.saved': {
    workspaceId: string;
    projectId: string;
    notepadId: string;
    version: number;
    actorId: string;
    content: string;
  };
  'workspace.created': {
    workspaceId: string;
    userId: string;
    name: string;
  };
  'workspace.deleted': {
    workspaceId: string;
    actorId: string;
  };
  'user.deleted': {
    userId: string;
  };
  'account.export': {
    userId: string;
    workspaceId: string | null;
    payload: Record<string, unknown>;
  };
}

export interface PluginDbStatement {
  sql: string;
  params?: readonly unknown[];
}

export interface PluginDb {
  readonly pluginId: string;
  readonly prefix: string;
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
  execute(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ changes: number; lastRowId?: number | string }>;
  batch(statements: ReadonlyArray<PluginDbStatement>): Promise<void>;
}

export interface PluginMigration {
  name: string;
  sql: string;
}

export interface MentionScope {
  workspaceId: string;
  projectId?: string;
  userId?: string;
}

export interface MentionCandidate {
  id: string;
  label: string;
  description?: string;
  icon?: string | null;
  kind?: string;
}

export interface MentionPreview {
  kind: string;
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  subtitle?: string;
  href?: string | null;
  badge?: string | null;
  icon?: string | null;
}

export interface MentionSourceAdapter {
  /** Must match `plugin:<pluginId>:<entityType>`. */
  kind: string;
  label: string;
  suggest(query: string, scope: MentionScope): Promise<MentionCandidate[]>;
  resolve?(
    id: string,
    scope: { workspaceId: string; projectId: string; userId?: string },
  ): Promise<MentionPreview | null>;
}

export interface AuthPublicOAuthProvider {
  id: string;
  name: string;
  kind: 'social' | 'oidc' | 'saml';
  authUrl?: string;
}

export interface AuthPublicConfigPatch {
  signupMode?: 'bootstrap-or-invite' | 'open';
  emailPasswordEnabled?: boolean;
  magicLinkEnabled?: boolean;
  oauthProviders?: AuthPublicOAuthProvider[];
}

export interface PluginRouteMiddleware {
  requireIdentity: unknown;
  requireWorkspace: unknown;
  requireRole: (minRole: 'viewer' | 'editor' | 'owner') => unknown;
}

export interface ServerPluginContext {
  readonly manifest: PluginManifest;
  readonly db: PluginDb;
  readonly env: Record<string, unknown>;
  readonly infra: unknown;
  readonly middleware: PluginRouteMiddleware;
  /** Mounts a Hono router at `/api/plugins/<id>` (or optional `mountPath` if permitted). */
  route(app: unknown, options?: { mountPath?: string }): void;
  /** Subscribe to post-commit domain events (dispatched via ExecutionContext.waitUntil when available). */
  on<K extends keyof BurrowEventMap>(
    event: K,
    handler: (payload: BurrowEventMap[K]) => Promise<void> | void,
  ): void;
  /** Subscribe to synchronous pre-action guards before core commits. Throwing aborts the operation. */
  onBefore<K extends keyof BurrowEventMap>(
    event: K,
    handler: (payload: BurrowEventMap[K]) => Promise<void> | void,
  ): void;
  registerMentionSource(source: MentionSourceAdapter): void;
  setAdapters(overrides: {
    auth?: unknown;
    storage?: unknown;
    mailer?: unknown;
    policy?: unknown;
  }): void;
}

export interface BurrowServerPlugin {
  manifest: PluginManifest;
  migrations?: ReadonlyArray<PluginMigration>;
  setup(ctx: ServerPluginContext): void | Promise<void>;
}

export type WebComponent<P = Record<string, unknown>> =
  | ((props: P) => unknown)
  | (new (props: P) => { render(): unknown });

export interface SlashExecutionContext {
  context: 'notepad' | 'card' | 'quickadd';
  workspaceId: string;
  projectId: string;
  editor?: unknown;
  insertText?: (text: string) => void;
  openModal?: (render: (close: () => void) => unknown) => void;
}

export interface SlashCommandContribution {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  group?: string;
  icon?: string;
  contexts: ReadonlyArray<'notepad' | 'card' | 'quickadd'>;
  execute: (ctx: SlashExecutionContext) => void | Promise<void>;
}

export interface MentionKindContribution {
  kind: string;
  group: string;
  renderChip?: WebComponent<{
    id: string;
    label: string;
    workspaceId?: string;
    projectId?: string;
  }>;
}

export interface CardTypeContribution {
  type: string;
  label: string;
  renderTileBadge?: WebComponent<{ card: Record<string, unknown>; workspaceId: string; projectId: string }>;
  renderTileFooter?: WebComponent<{ card: Record<string, unknown>; workspaceId: string; projectId: string }>;
  renderPanelSection?: WebComponent<{
    card: Record<string, unknown>;
    workspaceId: string;
    projectId: string;
    boardId: string;
  }>;
}

export interface SidebarPanelContribution {
  id: string;
  label: string;
  icon?: WebComponent<{ className?: string }>;
  order?: number;
  render: WebComponent<{ workspaceId: string; projectId?: string; onCloseMobile?: () => void }>;
}

export interface SettingsSectionContribution {
  id: string;
  label: string;
  description?: string;
  order?: number;
  render: WebComponent<{ workspaceId: string }>;
}

export interface WebRouteContribution {
  path: string;
  parent?: 'root' | 'shell' | 'workspace' | 'project';
  component: WebComponent<Record<string, unknown>>;
}

export interface BurrowWebPlugin {
  manifest: PluginManifest;
  slashCommands?: ReadonlyArray<SlashCommandContribution>;
  mentionKinds?: ReadonlyArray<MentionKindContribution>;
  cardTypes?: ReadonlyArray<CardTypeContribution>;
  sidebarPanels?: ReadonlyArray<SidebarPanelContribution>;
  settingsSections?: ReadonlyArray<SettingsSectionContribution>;
  routes?: ReadonlyArray<WebRouteContribution>;
}
