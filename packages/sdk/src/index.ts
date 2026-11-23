import sanitizeHtml from 'sanitize-html';

export const BURROW_SDK_VERSION = '0.4.0';

export type PluginDialect = 'sqlite' | 'postgres';

export type Permission =
  | 'db:own'
  | 'routes:api'
  | 'routes:public'
  | 'events:read'
  | 'events:before'
  | 'policy:override'
  | 'auth:override'
  | 'storage:override'
  | 'storage:own'
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
  /** Supported SQL dialects for migrations and PluginDb queries. */
  dialects?: readonly PluginDialect[];
  /** Other plugin IDs that must be initialized before this plugin. */
  dependencies?: readonly string[];
  /** Hostname allowlist for ctx.fetch outbound requests (e.g. ["api.example.com"]). */
  network?: readonly string[];
  /** Declared config/env key names exposed via ctx.config (sensitive core keys are always blocked). */
  configKeys?: readonly string[];
  /** Explicit allowlist of non-sensitive core tables this plugin is permitted to SELECT from (e.g. ["cards", "projects"]). */
  coreTables?: readonly string[];
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

export interface SqlFragment {
  readonly __burrowSql: true;
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
  readonly text: string;
  readonly params: readonly unknown[];
}

export interface SqlIdentifier {
  readonly __burrowIdent: true;
  readonly value: string;
}

const SAFE_TABLE_PART_RE = /^[a-z][a-z0-9_]{0,40}$/;
const AUTHENTIC_SQL_FRAGMENTS = new WeakSet<object>();
const AUTHENTIC_SQL_IDENTIFIERS = new WeakSet<object>();
const FORGED_IDENT_SQL_FRAGMENTS = new WeakSet<object>();

/** Returns true only for genuine `SqlFragment` objects minted by `sql` template helper. */
export function isAuthenticSqlFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === 'object' &&
    value !== null &&
    AUTHENTIC_SQL_FRAGMENTS.has(value) &&
    !FORGED_IDENT_SQL_FRAGMENTS.has(value)
  );
}

/** Returns true only for genuine `SqlIdentifier` objects minted by `buildPluginTableIdentifier` / `db.table()`. */
export function isAuthenticSqlIdentifier(value: unknown): value is SqlIdentifier {
  return typeof value === 'object' && value !== null && AUTHENTIC_SQL_IDENTIFIERS.has(value);
}

/**
 * Parameterized SQL tagged template helper.
 * Interpolated values become bound parameters (never string-concatenated into SQL);
 * `SqlIdentifier` instances returned by `db.table('name')` are spliced safely as validated table identifiers.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  let text = '';
  const params: unknown[] = [];
  let hasForgedIdentifier = false;
  for (let i = 0; i < strings.length; i++) {
    text += strings[i] ?? '';
    if (i < values.length) {
      const val = values[i];
      if (AUTHENTIC_SQL_IDENTIFIERS.has(val as object)) {
        text += (val as SqlIdentifier).value;
      } else {
        if (val && typeof val === 'object' && '__burrowIdent' in val) {
          hasForgedIdentifier = true;
        }
        text += '?';
        params.push(val);
      }
    }
  }
  const fragment: SqlFragment = Object.freeze({
    __burrowSql: true as const,
    strings: Object.freeze([...strings]),
    values: Object.freeze([...values]),
    text,
    params: Object.freeze(params),
  });
  AUTHENTIC_SQL_FRAGMENTS.add(fragment);
  if (hasForgedIdentifier) {
    FORGED_IDENT_SQL_FRAGMENTS.add(fragment);
  }
  return fragment;
}

/** Validate and format a plugin-owned table identifier (`plugin_<id>_<shortName>`). */
export function buildPluginTableIdentifier(pluginId: string, shortName: string): SqlIdentifier {
  const clean = shortName.trim();
  if (!SAFE_TABLE_PART_RE.test(clean)) {
    throw new Error(
      `Invalid table short name "${shortName}" for plugin "${pluginId}" (must match ${SAFE_TABLE_PART_RE.source})`,
    );
  }
  const prefix = `plugin_${pluginId.replace(/-/g, '_')}_`;
  const fullName = clean.startsWith(prefix) ? clean : `${prefix}${clean}`;
  const ident: SqlIdentifier = Object.freeze({
    __burrowIdent: true as const,
    value: fullName,
  });
  AUTHENTIC_SQL_IDENTIFIERS.add(ident);
  return ident;
}

export interface PluginDbStatement {
  sql: string | SqlFragment;
  params?: readonly unknown[];
}

export interface PluginDbQueryOptions {
  maxRows?: number;
  timeoutMs?: number;
}

export type SqlComparisonOp =
  | '='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'LIKE'
  | 'IN'
  | 'IS NULL'
  | 'IS NOT NULL';

export interface PluginTableQueryBuilder<T = Record<string, unknown>> {
  select(...columns: string[]): PluginTableQueryBuilder<T>;
  where(column: string, op: SqlComparisonOp, value?: unknown): PluginTableQueryBuilder<T>;
  orderBy(column: string, direction?: 'ASC' | 'DESC'): PluginTableQueryBuilder<T>;
  limit(count: number): PluginTableQueryBuilder<T>;
  all(options?: PluginDbQueryOptions): Promise<T[]>;
  first(options?: PluginDbQueryOptions): Promise<T | null>;
  insert(
    values: Record<string, unknown>,
    options?: PluginDbQueryOptions,
  ): Promise<{ changes: number; lastRowId?: number | string }>;
  update(
    values: Record<string, unknown>,
    options?: PluginDbQueryOptions,
  ): Promise<{ changes: number; lastRowId?: number | string }>;
  delete(options?: PluginDbQueryOptions): Promise<{ changes: number; lastRowId?: number | string }>;
}

export interface PluginDb {
  readonly pluginId: string;
  readonly prefix: string;
  readonly dialect?: PluginDialect;
  /** Returns a validated table identifier (`plugin_<id>_<shortName>`) safe for `sql` tagged templates. */
  table(shortName: string): SqlIdentifier;
  /** Tagged template helper bound to this PluginDb. */
  sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment;
  /** Safe query builder bound to a plugin-owned table with identifier validation and parameterized bindings. */
  from?<T = Record<string, unknown>>(shortName: string): PluginTableQueryBuilder<T>;
  query<T = Record<string, unknown>>(
    sql: string | SqlFragment,
    params?: readonly unknown[],
    options?: PluginDbQueryOptions,
  ): Promise<T[]>;
  first<T = Record<string, unknown>>(
    sql: string | SqlFragment,
    params?: readonly unknown[],
    options?: PluginDbQueryOptions,
  ): Promise<T | null>;
  execute(
    sql: string | SqlFragment,
    params?: readonly unknown[],
    options?: PluginDbQueryOptions,
  ): Promise<{ changes: number; lastRowId?: number | string }>;
  batch(statements: ReadonlyArray<PluginDbStatement>): Promise<void>;
}

export interface PluginMigration {
  name: string;
  sql: string;
  dialect?: PluginDialect;
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

export interface PluginLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

export interface PluginStorageObject {
  body: ReadableStream | ArrayBuffer | Uint8Array;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: Date;
}

export interface PluginStorage {
  put(key: string, data: ArrayBuffer | Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<PluginStorageObject | null>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface PluginSchemaLike<T = unknown> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export interface ValidatedPluginRouteDef<
  TParams = Record<string, string>,
  TQuery = Record<string, string>,
  TBody = unknown,
> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Default is false (requires authenticated session). Requires `'routes:public'` permission when true. */
  public?: boolean;
  /** Optional workspace `:wid` scope enforcement and minimum role check. */
  workspaceParam?: string;
  minRole?: 'viewer' | 'editor' | 'owner';
  schemas: {
    params?: PluginSchemaLike<TParams>;
    query?: PluginSchemaLike<TQuery>;
    body?: PluginSchemaLike<TBody>;
  };
  handler: (
    c: unknown,
    validated: { params: TParams; query: TQuery; body: TBody },
  ) => Promise<Response> | Response;
}

export interface WorkspaceResourceRef {
  kind: 'workspace' | 'project' | 'board' | 'card' | 'notepad';
  id: string;
  workspaceId?: string;
}

export interface WorkspaceAccessResult {
  userId: string;
  workspaceId: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface ServerPluginContext {
  readonly manifest: PluginManifest;
  readonly db: PluginDb;
  /** Declared config values only (filtered by `manifest.configKeys`, never core secrets). */
  readonly config: Readonly<Record<string, string | undefined>>;
  /** Automatic secret-redacting structured logger scoped to this plugin. */
  readonly log: PluginLogger;
  /** SSRF-hardened fetch restricted to `manifest.network` host allowlist. */
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Prefix-isolated storage client (`plugins/<id>/...`) blocking traversal and unsafe MIME types. */
  readonly storage: PluginStorage;
  /** @deprecated Prefer `ctx.config`; empty for non-core plugins. */
  readonly env: Record<string, unknown>;
  /** @deprecated Restricted for non-core plugins to prevent repository/DB bypasses. */
  readonly infra: unknown;
  readonly middleware: PluginRouteMiddleware;
  /** One-line role guard helper. */
  requireRole(minRole: 'viewer' | 'editor' | 'owner'): unknown;
  /** One-line authentication, workspace membership, and optional resource ownership check (prevents IDOR). */
  requireWorkspaceAccess(
    c: unknown,
    resource?: WorkspaceResourceRef,
  ): Promise<WorkspaceAccessResult>;
  /** Mounts a Hono router at `/api/plugins/<id>`. */
  route(app: unknown, options?: { mountPath?: string; public?: boolean }): void;
  /** Registers a schema-validated route (required for `burrow plugin validate` compliance). */
  defineRoute<TParams = Record<string, string>, TQuery = Record<string, string>, TBody = unknown>(
    def: ValidatedPluginRouteDef<TParams, TQuery, TBody>,
  ): void;
  /** Subscribe to post-commit domain events (dispatched off the hot path). */
  on<K extends keyof BurrowEventMap>(
    event: K,
    handler: (payload: BurrowEventMap[K]) => Promise<void> | void,
  ): void;
  /** Subscribe to synchronous pre-action guards before core commits. */
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

// ---------------------------------------------------------------------------
// Safe HTML / Prop Sanitization & Consent Helpers
// ---------------------------------------------------------------------------

const ALLOWED_HTML_TAGS = new Set([
  'b',
  'i',
  'em',
  'strong',
  'u',
  's',
  'code',
  'pre',
  'span',
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'a',
]);

function stripWhitespaceAndControl(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 32 || code === 127) continue;
    out += value[i]!;
  }
  return out;
}

function decodeHtmlEntities(input: string): string {
  let current = input;
  for (let pass = 0; pass < 3; pass++) {
    const next = current
      .replace(/&#x([0-9a-fA-F]+);?/g, (_m, hex: string) => {
        const cp = Number.parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      })
      .replace(/&#(\d+);?/g, (_m, dec: string) => {
        const cp = Number.parseInt(dec, 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      })
      .replace(/&colon;/gi, ':')
      .replace(/&tab;/gi, '\t')
      .replace(/&newline;/gi, '\n')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'");
    if (next === current) break;
    current = next;
  }
  return current;
}

function isSafeHref(rawHref: string): boolean {
  const decoded = decodeHtmlEntities(rawHref);
  const cleaned = stripWhitespaceAndControl(decoded).toLowerCase();
  if (!cleaned) return false;
  if (cleaned.startsWith('//') || cleaned.startsWith('/\\') || cleaned.startsWith('\\')) {
    return false;
  }
  if (
    cleaned.startsWith('http://') ||
    cleaned.startsWith('https://') ||
    cleaned.startsWith('mailto:') ||
    cleaned.startsWith('/') ||
    cleaned.startsWith('#')
  ) {
    return true;
  }
  return false;
}

/**
 * Allowlist-based HTML sanitizer for plugin UI strings rendered via `dangerouslySetInnerHTML`.
 * Strips scripts, iframes, SVG/MathML, inline event handlers, styles, protocol-relative URLs, and unsafe URI schemes.
 */
export function sanitizePluginHtml(html: string): string {
  if (typeof html !== 'string' || !html) return '';
  const cleanedNulls = html.replace(/\0/g, '');
  return sanitizeHtml(cleanedNulls, {
    allowedTags: [...ALLOWED_HTML_TAGS],
    allowedAttributes: {
      a: ['href', 'rel', 'target'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto'],
    },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'],
    transformTags: {
      a: (_tagName: string, attribs: sanitizeHtml.Attributes): sanitizeHtml.Tag => {
        const rawHref = attribs.href ?? '';
        if (rawHref && isSafeHref(rawHref)) {
          return {
            tagName: 'a',
            attribs: {
              href: rawHref,
              rel: 'noopener noreferrer',
              target: '_blank',
            },
          };
        }
        const cleanAttribs: sanitizeHtml.Attributes = {};
        return {
          tagName: 'a',
          attribs: cleanAttribs,
        };
      },
    },
  });
}

const MAX_PROP_SANITIZE_DEPTH = 32;
const URL_PROP_KEYS = new Set([
  'href',
  'url',
  'src',
  'action',
  'formaction',
  'poster',
  'cite',
  'xlink:href',
]);

/**
 * Sanitizes string values and URL fields inside props passed to plugin UI slots
 * (mention chips, card badges/footers/panels).
 */
export function sanitizePluginProps<T>(value: T, depth = 0): T {
  if (value === null || value === undefined) return value;
  if (depth > MAX_PROP_SANITIZE_DEPTH) return null as unknown as T;
  if (typeof value === 'string') {
    let stripped = value.replace(/\0/g, '');
    if (stripped.includes('<') || stripped.includes('>')) {
      stripped = sanitizeHtml(stripped, {
        allowedTags: [],
        allowedAttributes: {},
        disallowedTagsMode: 'discard',
        nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'],
      });
      stripped = stripped.replace(/<\/?[a-zA-Z][^>]*>?/g, '');
    }
    const decoded = stripWhitespaceAndControl(decodeHtmlEntities(stripped)).toLowerCase();
    if (/^(?:javascript|vbscript|data):/i.test(decoded)) {
      return '' as unknown as T;
    }
    return stripped as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePluginProps(item, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (URL_PROP_KEYS.has(k.toLowerCase()) && typeof v === 'string' && !isSafeHref(v)) {
        out[k] = null;
      } else {
        out[k] = sanitizePluginProps(v, depth + 1);
      }
    }
    return out as T;
  }
  return value;
}

const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'db:own': 'create and manage its own database tables',
  'routes:api': 'register authenticated API routes',
  'routes:public': 'register unauthenticated public routes',
  'events:read': 'read post-commit workspace events',
  'events:before': 'validate or block actions before save/create',
  'policy:override': 'enforce workspace/instance access limits',
  'auth:override': 'customize authentication providers',
  'storage:override': 'wrap file storage behavior',
  'storage:own': 'read and write plugin-scoped files',
  'mailer:override': 'customize outbound email delivery',
  'mentions:register': 'add @-mention sources',
  'cards:register': 'register custom Kanban card types',
  'ui:register': 'add slash commands, panels, settings, and routes',
};

/** Generates human-readable capability bullets for admin consent prompts. */
export function describePluginCapabilities(manifest: PluginManifest): string[] {
  const items: string[] = [];
  for (const perm of manifest.permissions) {
    const desc = PERMISSION_DESCRIPTIONS[perm];
    if (desc) items.push(desc);
  }
  for (const host of manifest.network ?? []) {
    items.push(`call ${host}`);
  }
  if ((manifest.coreTables?.length ?? 0) > 0) {
    items.push(`read core tables (${manifest.coreTables!.join(', ')})`);
  }
  if ((manifest.configKeys?.length ?? 0) > 0) {
    items.push(`read config keys (${manifest.configKeys!.join(', ')})`);
  }
  return items;
}

/** Formats a single-line human-readable consent summary for a plugin manifest. */
export function formatPluginConsentSummary(manifest: PluginManifest): string {
  const title = manifest.name ? `${manifest.name} (${manifest.id})` : manifest.id;
  const caps = describePluginCapabilities(manifest);
  if (caps.length === 0) return `${title} — This plugin requests no special capabilities.`;
  return `${title} — This plugin can: ${caps.join(', ')}.`;
}
