import { AsyncLocalStorage } from 'node:async_hooks';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import nodeSqlParser from 'node-sql-parser';
import {
  buildPluginTableIdentifier,
  isAuthenticSqlFragment,
  sql as sqlTag,
  type PluginDb,
  type PluginDbQueryOptions,
  type PluginDbStatement,
  type PluginDialect,
  type PluginTableQueryBuilder,
  type SqlComparisonOp,
  type SqlFragment,
  type SqlIdentifier,
} from '@burrow/sdk';
import { pluginTablePrefix } from './manifest';
import { withPluginPostgresRole } from './postgres-isolation';

const sqlAstParser = new nodeSqlParser.Parser();

/**
 * NOTE ON DIALECT SECURITY BOUNDARIES:
 * - On PostgreSQL, plugin isolation is enforced by the database engine itself via dedicated
 *   `plugin_<id>` schemas owned by NOLOGIN `plugin_<id>_owner`, dedicated LOGIN `plugin_<id>_role`
 *   connection pools (`session_user = plugin_<id>_role`), ephemeral `plugin_<id>_migrator`
 *   migration roles, `REVOKE ALL` / explicit `coreTables` grants, locked `search_path` /
 *   timeouts, and `SECURITY INVOKER` DDL event triggers.
 * - On SQLite / Cloudflare D1 (which lack database roles, schemas, and GRANT/REVOKE), the
 *   SQL guard (`assertPluginSqlAllowed`) is a best-effort tripwire for operator-trusted plugins,
 *   NOT a cryptographic or engine-level isolation boundary.
 */

export class PluginSqlAccessError extends Error {
  constructor(
    public readonly pluginId: string,
    message: string,
  ) {
    super(`Plugin "${pluginId}" SQL access denied: ${message}`);
    this.name = 'PluginSqlAccessError';
  }
}

interface SqliteLikeStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteLikeDb {
  prepare(sql: string): SqliteLikeStatement;
  exec?(sql: string): void;
  transaction?<T>(fn: () => T): () => T;
}

export interface PostgresLikeSql {
  unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>> & { count?: number }>;
  begin?<T>(cb: (tx: any) => Promise<T> | T): Promise<any>;
}

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_QUERY_TIMEOUT_MS = 3_000;
const MIN_QUERY_TIMEOUT_MS = 10;
const MAX_QUERY_TIMEOUT_MS = 30_000;
const MAX_AST_PARSE_CHARS = 32_768;

const ownedTablesByDb = new WeakMap<object, Map<string, Set<string>>>();
const tableOwnerByDb = new WeakMap<object, Map<string, string>>();
const registeredPrefixesByDb = new WeakMap<object, Set<string>>();

function clampQueryTimeoutMs(rawTimeoutMs: number | undefined): number {
  if (typeof rawTimeoutMs !== 'number' || !Number.isFinite(rawTimeoutMs)) {
    return DEFAULT_QUERY_TIMEOUT_MS;
  }
  return Math.min(Math.max(MIN_QUERY_TIMEOUT_MS, Math.trunc(rawTimeoutMs)), MAX_QUERY_TIMEOUT_MS);
}

/** Records table names created/owned by `pluginId` on `rawDb` to prevent prefix collisions in SQLite/D1. */
export function registerPluginOwnedTables(
  rawDb: unknown,
  pluginId: string,
  tables: ReadonlyArray<string>,
  opts: { registerNamespace?: boolean } = {},
): void {
  const client = unwrapDbClient(rawDb);
  if (!client || (typeof client !== 'object' && typeof client !== 'function')) return;
  const key = client as object;
  const prefix = pluginTablePrefix(pluginId);

  let prefixes = registeredPrefixesByDb.get(key);
  if (!prefixes) {
    prefixes = new Set<string>();
    registeredPrefixesByDb.set(key, prefixes);
  }

  let ownerMap = tableOwnerByDb.get(key);
  if (!ownerMap) {
    ownerMap = new Map<string, string>();
    tableOwnerByDb.set(key, ownerMap);
  }

  if (opts.registerNamespace !== false) {
    for (const [existingTbl, existingOwner] of ownerMap) {
      if (existingOwner !== pluginId && existingTbl.startsWith(prefix)) {
        throw new PluginSqlAccessError(
          pluginId,
          `namespace "${prefix}" conflicts with table "${existingTbl}" already owned by plugin "${existingOwner}"`,
        );
      }
    }
    prefixes.add(prefix);
  }

  if (tables.length === 0) return;

  const normalizedTables: string[] = [];
  for (const t of tables) {
    const clean = t.trim().replace(/^[`"[]|[`"\]]$/g, '');
    const parts = clean.split('.');
    const tbl = (parts[parts.length - 1] ?? clean).replace(/^[`"[]|[`"\]]$/g, '').toLowerCase();
    if (!tbl) continue;

    if (!tbl.startsWith(prefix)) {
      throw new PluginSqlAccessError(
        pluginId,
        `owned table "${tbl}" must start with "${prefix}"`,
      );
    }

    for (const otherPrefix of prefixes) {
      if (otherPrefix !== prefix && tbl.startsWith(otherPrefix)) {
        throw new PluginSqlAccessError(
          pluginId,
          `cross-plugin table "${tbl}" collides with sibling plugin prefix "${otherPrefix}"`,
        );
      }
    }

    const existingOwner = ownerMap.get(tbl);
    if (existingOwner && existingOwner !== pluginId) {
      throw new PluginSqlAccessError(
        pluginId,
        `table "${tbl}" is already owned by plugin "${existingOwner}"`,
      );
    }

    normalizedTables.push(tbl);
  }

  if (normalizedTables.length === 0) return;

  let perPlugin = ownedTablesByDb.get(key);
  if (!perPlugin) {
    perPlugin = new Map<string, Set<string>>();
    ownedTablesByDb.set(key, perPlugin);
  }
  let owned = perPlugin.get(pluginId);
  if (!owned) {
    owned = new Set<string>();
    perPlugin.set(pluginId, owned);
  }
  for (const tbl of normalizedTables) {
    owned.add(tbl);
    ownerMap.set(tbl, pluginId);
  }
}

/** Extracts CREATE TABLE targets from migration or runtime DDL SQL. */
export function extractCreatedTablesFromSql(sqlText: string): string[] {
  const found: string[] = [];
  for (const stmt of splitPluginSqlStatements(sqlText)) {
    const cleaned = stripCommentsAndStrings(stmt).cleaned.replace(/\s+/g, ' ').trim();
    const m = /^CREATE\s+(?:(?:TEMP|TEMPORARY|VIRTUAL)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.[\]-]+)/i.exec(
      cleaned,
    );
    if (m?.[1]) {
      found.push(m[1]);
    }
  }
  return found;
}

const httpMethodStorage = new AsyncLocalStorage<string>();

export function runWithPluginHttpMethod<T>(method: string, fn: () => Promise<T>): Promise<T> {
  return httpMethodStorage.run(method.toUpperCase(), fn);
}

export function getCurrentPluginHttpMethod(): string | undefined {
  return httpMethodStorage.getStore();
}

function unwrapDbClient(rawDb: unknown): D1Database | SqliteLikeDb | PostgresLikeSql | null {
  if (!rawDb || typeof rawDb !== 'object' && typeof rawDb !== 'function') return null;
  if (typeof rawDb === 'object' && rawDb !== null && '$client' in rawDb) {
    return (rawDb as { $client: D1Database | SqliteLikeDb | PostgresLikeSql }).$client;
  }
  return rawDb as D1Database | SqliteLikeDb | PostgresLikeSql;
}

export function isD1Database(client: unknown): client is D1Database {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof (client as { batch?: unknown }).batch === 'function' &&
    typeof (client as { prepare?: unknown }).prepare === 'function'
  );
}

export function isPostgresClient(client: unknown): client is PostgresLikeSql {
  return (
    (typeof client === 'function' || (typeof client === 'object' && client !== null)) &&
    typeof (client as { unsafe?: unknown }).unsafe === 'function' &&
    typeof (client as { prepare?: unknown }).prepare !== 'function'
  );
}

export function detectPluginDialect(rawDb: unknown): PluginDialect {
  const client = unwrapDbClient(rawDb);
  return isPostgresClient(client) ? 'postgres' : 'sqlite';
}

function readDollarTag(sqlText: string, pos: number): string | null {
  if (sqlText[pos] !== '$') return null;
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlText.slice(pos));
  return match ? match[0] : null;
}

function isBracketIdentifierStart(source: string, idx: number, emitted: string): boolean {
  if (idx > 0 && /[A-Za-z0-9_$]/.test(source[idx - 1]!)) return false;
  if (/\bARRAY\s*$/i.test(emitted)) return false;
  let k = idx + 1;
  while (k < source.length) {
    const ch = source[k]!;
    if (ch === ']') return k > idx + 1;
    if (ch === "'" || ch === '\n' || ch === '\r' || ch === ';') return false;
    k++;
  }
  return false;
}

/**
 * Lexer-aware comment & literal stripper.
 * Properly tracks `'...'` and PG `E'...'` literals, `"..."` / `` `...` `` / SQLite `[...]`
 * identifiers (without desyncing on `ARRAY[']']`), and `$$...$$` dollar-quoted blocks.
 */
function stripCommentsAndStrings(sqlText: string): {
  cleaned: string;
  hasComments: boolean;
  hasDollarQuotes: boolean;
  rawStringLiterals: string[];
} {
  let out = '';
  let i = 0;
  const len = sqlText.length;
  let hasComments = false;
  let hasDollarQuotes = false;
  const rawStringLiterals: string[] = [];

  while (i < len) {
    const ch = sqlText[i]!;
    const next = sqlText[i + 1];

    if (ch === '-' && next === '-') {
      hasComments = true;
      i += 2;
      while (i < len && sqlText[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '*') {
      hasComments = true;
      i += 2;
      while (i < len - 1 && !(sqlText[i] === '*' && sqlText[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    // Postgres E'...' / e'...' escape string literal
    if ((ch === 'e' || ch === 'E') && next === "'" && (i === 0 || !/[A-Za-z0-9_$]/.test(sqlText[i - 1]!))) {
      const start = i;
      i += 2;
      while (i < len) {
        if (sqlText[i] === '\\') {
          i += 2;
        } else if (sqlText[i] === "'" && sqlText[i + 1] === "'") {
          i += 2;
        } else if (sqlText[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      rawStringLiterals.push(sqlText.slice(start, i));
      out += " '' ";
      continue;
    }

    if (ch === "'") {
      const start = i;
      i++;
      while (i < len) {
        if (sqlText[i] === "'" && sqlText[i + 1] === "'") {
          i += 2;
        } else if (sqlText[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      rawStringLiterals.push(sqlText.slice(start, i));
      out += " '' ";
      continue;
    }

    // Double-quoted identifier ("...")
    if (ch === '"') {
      out += ch;
      i++;
      while (i < len) {
        const c = sqlText[i]!;
        out += c;
        if (c === '"' && sqlText[i + 1] === '"') {
          out += '"';
          i += 2;
        } else if (c === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }

    // Backtick identifier (`...`)
    if (ch === '`') {
      out += ch;
      i++;
      while (i < len) {
        const c = sqlText[i]!;
        out += c;
        if (c === '`') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // SQLite bracket identifier ([...]), never triggered for Postgres ARRAY[...]
    if (ch === '[' && isBracketIdentifierStart(sqlText, i, out)) {
      out += ch;
      i++;
      while (i < len) {
        const c = sqlText[i]!;
        out += c;
        if (c === ']') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Postgres dollar-quoted string ($tag$...$tag$)
    const dollarTag = readDollarTag(sqlText, i);
    if (dollarTag) {
      hasDollarQuotes = true;
      const closeIdx = sqlText.indexOf(dollarTag, i + dollarTag.length);
      if (closeIdx === -1) {
        rawStringLiterals.push(sqlText.slice(i));
        i = len;
      } else {
        rawStringLiterals.push(sqlText.slice(i, closeIdx + dollarTag.length));
        i = closeIdx + dollarTag.length;
      }
      out += " '' ";
      continue;
    }

    out += ch;
    i++;
  }

  return { cleaned: out, hasComments, hasDollarQuotes, rawStringLiterals };
}

/** Split SQL into non-empty statements while respecting quotes, escape strings, brackets, dollar-quotes, and trigger BEGIN...END blocks. */
export function splitPluginSqlStatements(sqlText: string): string[] {
  const chunks = sqlText.split('--> statement-breakpoint');
  const statements: string[] = [];

  for (const chunk of chunks) {
    let current = '';
    let inSingleQuote = false;
    let inEscapeSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let inBracket = false;
    let activeDollarTag: string | null = null;
    let triggerDepth = 0;
    const len = chunk.length;

    for (let i = 0; i < len; i++) {
      const ch = chunk[i]!;
      const next = chunk[i + 1];

      if (
        !inSingleQuote &&
        !inEscapeSingleQuote &&
        !inDoubleQuote &&
        !inBacktick &&
        !inBracket &&
        !activeDollarTag
      ) {
        if (ch === '-' && next === '-') {
          while (i < len && chunk[i] !== '\n') i++;
          current += '\n';
          continue;
        }
        if (ch === '/' && next === '*') {
          i += 2;
          while (i < len - 1 && !(chunk[i] === '*' && chunk[i + 1] === '/')) i++;
          i++;
          current += ' ';
          continue;
        }
        const tag = readDollarTag(chunk, i);
        if (tag) {
          activeDollarTag = tag;
          current += tag;
          i += tag.length - 1;
          continue;
        }
        if ((ch === 'e' || ch === 'E') && next === "'" && (i === 0 || !/[A-Za-z0-9_$]/.test(chunk[i - 1]!))) {
          inEscapeSingleQuote = true;
          current += ch + "'";
          i++;
          continue;
        }
      } else if (activeDollarTag) {
        if (chunk.startsWith(activeDollarTag, i)) {
          current += activeDollarTag;
          i += activeDollarTag.length - 1;
          activeDollarTag = null;
          continue;
        }
        current += ch;
        continue;
      } else if (inEscapeSingleQuote) {
        if (ch === '\\') {
          current += ch + (next ?? '');
          i++;
          continue;
        }
        if (ch === "'" && next === "'") {
          current += "''";
          i++;
          continue;
        }
        if (ch === "'") {
          inEscapeSingleQuote = false;
        }
        current += ch;
        continue;
      }

      if (ch === "'" && !inDoubleQuote && !inBacktick && !inBracket) {
        if (inSingleQuote && next === "'") {
          current += "''";
          i++;
          continue;
        }
        inSingleQuote = !inSingleQuote;
        current += ch;
        continue;
      }

      if (ch === '"' && !inSingleQuote && !inBacktick && !inBracket) {
        if (inDoubleQuote && next === '"') {
          current += '""';
          i++;
          continue;
        }
        inDoubleQuote = !inDoubleQuote;
        current += ch;
        continue;
      }

      if (ch === '`' && !inSingleQuote && !inDoubleQuote && !inBracket) {
        inBacktick = !inBacktick;
        current += ch;
        continue;
      }

      if (ch === '[' && !inSingleQuote && !inDoubleQuote && !inBacktick && isBracketIdentifierStart(chunk, i, current)) {
        inBracket = true;
        current += ch;
        continue;
      }
      if (ch === ']' && inBracket) {
        inBracket = false;
        current += ch;
        continue;
      }

      if (!inSingleQuote && !inEscapeSingleQuote && !inDoubleQuote && !inBacktick && !inBracket) {
        const tail = chunk.slice(i);
        if (/^BEGIN\b/i.test(tail) && (i === 0 || /\s/.test(chunk[i - 1]!))) {
          triggerDepth++;
        } else if (/^END\b/i.test(tail) && triggerDepth > 0 && (i === 0 || /\s/.test(chunk[i - 1]!))) {
          triggerDepth--;
        }

        if (ch === ';' && triggerDepth === 0) {
          const trimmed = current.trim();
          if (trimmed) statements.push(trimmed);
          current = '';
          continue;
        }
      }

      current += ch;
    }

    const tail = current.trim();
    if (tail) statements.push(tail);
  }

  return statements;
}

function unquoteIdentSegment(raw: string): string {
  return raw.trim().replace(/^[`"[]|[`"\]]$/g, '').toLowerCase();
}

interface ParsedTableRef {
  schema: string | null;
  table: string;
}

function parseTableRef(raw: string): ParsedTableRef {
  const cleaned = raw.trim();
  const parts = cleaned.split('.');
  if (parts.length >= 2) {
    return {
      schema: unquoteIdentSegment(parts[parts.length - 2]!),
      table: unquoteIdentSegment(parts[parts.length - 1]!),
    };
  }
  return {
    schema: null,
    table: unquoteIdentSegment(cleaned),
  };
}

function assertOwnedPluginTableName(
  pluginId: string,
  prefix: string,
  table: string,
  options: AssertPluginSqlOptions,
  contextLabel = 'table access',
): void {
  if (options.otherPluginPrefixes && !options.ownedTables?.has(table)) {
    for (const otherPrefix of options.otherPluginPrefixes) {
      if (otherPrefix !== prefix && table.startsWith(otherPrefix)) {
        throw new PluginSqlAccessError(
          pluginId,
          `cross-plugin ${contextLabel} "${table}" is forbidden (prefix "${otherPrefix}")`,
        );
      }
    }
  }
  if (options.isRuntime && options.strictUnownedMultiSegment && !options.ownedTables?.has(table)) {
    const suffix = table.slice(prefix.length);
    if (suffix.includes('_')) {
      throw new PluginSqlAccessError(
        pluginId,
        `unregistered multi-segment plugin table "${table}" is forbidden (expected owned table under "${prefix}")`,
      );
    }
  }
}

function assertIdentifierPrefixed(
  pluginId: string,
  prefix: string,
  rawTarget: string,
  op: string,
  options: AssertPluginSqlOptions = {},
): void {
  const ref = parseTableRef(rawTarget);
  if (ref.schema && ref.schema !== 'main' && !prefix.startsWith(`${ref.schema}_`)) {
    throw new PluginSqlAccessError(pluginId, `${op} schema "${ref.schema}" is forbidden`);
  }
  if (!ref.table.startsWith(prefix)) {
    throw new PluginSqlAccessError(
      pluginId,
      `${op} target "${ref.table}" must start with "${prefix}"`,
    );
  }
  assertOwnedPluginTableName(pluginId, prefix, ref.table, options, op);
}

const SENSITIVE_SYSTEM_TABLES = new Set([
  '_worker_runtime_config',
  'session',
  'account',
  'verification',
  'user',
  'rate_limits',
  '_migrations',
  'd1_migrations',
  'plugin_migrations',
  'bootstrap_state',
  'pending_storage_deletions',
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'pg_roles',
  'pg_user',
  'pg_shadow',
  'pg_authid',
  'pg_tables',
  'pg_class',
  'pg_namespace',
  'pg_stat_activity',
  'pg_settings',
]);

const SAFE_CORE_READ_TABLES = new Set([
  'workspaces',
  'projects',
  'boards',
  'board_columns',
  'cards',
  'notepads',
  'members',
  'tags',
  'card_tags',
  'project_files',
  'invites',
  'v_plugin_workspaces',
  'v_plugin_projects',
  'v_plugin_cards',
  'v_plugin_notepads',
  'v_plugin_members',
]);

const CLAUSE_STOP_KEYWORDS = new Set([
  'WHERE',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'OUTER',
  'ON',
  'USING',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'OFFSET',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'RETURNING',
  'SET',
  'VALUES',
  'SELECT',
  'WITH',
  'FOR',
  'INTO',
  'WINDOW',
]);

const NON_TABLE_FROM_FUNCTIONS = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY', 'POSITION']);

function tokenizeSqlForTableScan(cleanedStmt: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = cleanedStmt.length;
  while (i < len) {
    const ch = cleanedStmt[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" && cleanedStmt[i + 1] === "'") {
      tokens.push("''");
      i += 2;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < len && cleanedStmt[j] !== close) j++;
      tokens.push(cleanedStmt.slice(i, Math.min(len, j + 1)));
      i = j + 1;
      continue;
    }
    if (ch === ',' || ch === '.' || ch === '(' || ch === ')' || ch === ';') {
      tokens.push(ch);
      i++;
      continue;
    }
    if (/[A-Za-z0-9_$-]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_$-]/.test(cleanedStmt[j]!)) j++;
      tokens.push(cleanedStmt.slice(i, j));
      i = j;
      continue;
    }
    tokens.push(ch);
    i++;
  }
  return tokens;
}

function findMatchingParenToken(tokens: readonly string[], openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < tokens.length; i++) {
    if (tokens[i] === '(') depth++;
    else if (tokens[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function readIdentRef(tokens: readonly string[], pos: number): { ref: ParsedTableRef; nextPos: number } | null {
  const first = tokens[pos];
  if (!first || first === ',' || first === '(' || first === ')' || first === ';' || first === '.') {
    return null;
  }
  if (tokens[pos + 1] === '.' && tokens[pos + 2] && tokens[pos + 2] !== '(' && tokens[pos + 2] !== ',') {
    return {
      ref: {
        schema: unquoteIdentSegment(first),
        table: unquoteIdentSegment(tokens[pos + 2]!),
      },
      nextPos: pos + 3,
    };
  }
  return {
    ref: { schema: null, table: unquoteIdentSegment(first) },
    nextPos: pos + 1,
  };
}

function extractTableReferencesFromCleaned(cleanedStmt: string): ParsedTableRef[] {
  const refs: ParsedTableRef[] = [];
  const tokens = tokenizeSqlForTableScan(cleanedStmt);
  const fnParenStack: Array<string | null> = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === '(') {
      const prev = i > 0 ? tokens[i - 1]!.toUpperCase() : null;
      fnParenStack.push(prev);
      continue;
    }
    if (tok === ')') {
      fnParenStack.pop();
      continue;
    }

    const upper = tok.toUpperCase();
    if (upper === 'REFERENCES') {
      const parsed = readIdentRef(tokens, i + 1);
      if (parsed) refs.push(parsed.ref);
      continue;
    }

    if (upper === 'JOIN') {
      let p = i + 1;
      if (tokens[p]?.toUpperCase() === 'ONLY') p++;
      if (tokens[p] === '(') continue;
      const parsed = readIdentRef(tokens, p);
      if (parsed) refs.push(parsed.ref);
      continue;
    }

    if (upper === 'FROM') {
      // Do not treat EXTRACT(EPOCH FROM ts) / SUBSTRING(x FROM 1) as FROM table lists
      const activeFn = fnParenStack[fnParenStack.length - 1];
      if (activeFn && NON_TABLE_FROM_FUNCTIONS.has(activeFn)) continue;

      let p = i + 1;
      while (p < tokens.length) {
        const cur = tokens[p]!;
        const curUpper = cur.toUpperCase();
        if (cur === ';' || cur === ')' || CLAUSE_STOP_KEYWORDS.has(curUpper)) {
          break;
        }
        if (curUpper === 'ONLY') {
          p++;
          continue;
        }
        if (cur === '(') {
          const closeIdx = findMatchingParenToken(tokens, p);
          p = closeIdx + 1;
          if (tokens[p]?.toUpperCase() === 'AS') p += 2;
          else if (tokens[p] && tokens[p] !== ',' && tokens[p] !== ';' && tokens[p] !== ')' && !CLAUSE_STOP_KEYWORDS.has(tokens[p]!.toUpperCase())) {
            p++;
          }
          if (tokens[p] === ',') {
            p++;
            continue;
          }
          break;
        }

        const parsed = readIdentRef(tokens, p);
        if (!parsed) break;
        refs.push(parsed.ref);
        p = parsed.nextPos;

        // Table-valued functions such as pragma_table_info('...')
        if (tokens[p] === '(') {
          p = findMatchingParenToken(tokens, p) + 1;
        }

        const skipSqliteIndexHint = (pos: number): number => {
          if (
            tokens[pos]?.toUpperCase() === 'NOT' &&
            tokens[pos + 1]?.toUpperCase() === 'INDEXED'
          ) {
            return pos + 2;
          }
          if (
            tokens[pos]?.toUpperCase() === 'INDEXED' &&
            tokens[pos + 1]?.toUpperCase() === 'BY' &&
            tokens[pos + 2]
          ) {
            return pos + 3;
          }
          return pos;
        };

        // SQLite index hints can appear without an alias (`FROM tbl NOT INDEXED, other`)
        p = skipSqliteIndexHint(p);

        // Skip optional AS alias or bare alias before comma
        if (tokens[p]?.toUpperCase() === 'AS') {
          p += 2;
        } else if (
          tokens[p] &&
          tokens[p] !== ',' &&
          tokens[p] !== ';' &&
          tokens[p] !== ')' &&
          tokens[p] !== '(' &&
          !CLAUSE_STOP_KEYWORDS.has(tokens[p]!.toUpperCase())
        ) {
          p++;
        }

        // SQLite index hints can also appear after `[AS] alias` (`FROM tbl AS a NOT INDEXED, other`)
        p = skipSqliteIndexHint(p);

        if (tokens[p] === ',') {
          p++;
          continue;
        }
        break;
      }
    }
  }
  return refs;
}

function collectAstRefsAndCheckTautology(
  node: unknown,
  outRefs: ParsedTableRef[],
  state: { hasTautology: boolean },
  inWhere = false,
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectAstRefsAndCheckTautology(item, outRefs, state, inWhere);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (
    obj.type !== 'column_ref' &&
    !('column' in obj) &&
    typeof obj.table === 'string' &&
    obj.table.trim()
  ) {
    outRefs.push({
      schema: typeof obj.db === 'string' && obj.db.trim() ? unquoteIdentSegment(obj.db) : null,
      table: unquoteIdentSegment(obj.table),
    });
  }

  if (inWhere && obj.type === 'binary_expr' && typeof obj.operator === 'string') {
    const op = obj.operator.toUpperCase();
    const left = obj.left as Record<string, unknown> | undefined;
    const right = obj.right as Record<string, unknown> | undefined;
    const isConstLike = (n: Record<string, unknown> | undefined): boolean => {
      if (!n) return false;
      const t = n.type;
      if (t === 'number' || t === 'single_quote_string' || t === 'string' || t === 'bool' || t === 'null') {
        return true;
      }
      if (t === 'origin' && (n.value === '?' || String(n.value ?? '').startsWith('$'))) {
        return true;
      }
      return false;
    };
    const isParamNode = (n: Record<string, unknown> | undefined): boolean =>
      Boolean(n && (n.type === 'origin' || n.type === 'var') && (n.value === '?' || String(n.value ?? '').startsWith('$')));
    const isLiteralNode = (n: Record<string, unknown> | undefined): boolean =>
      Boolean(n && (n.type === 'number' || n.type === 'single_quote_string' || n.type === 'string' || n.type === 'bool'));

    if (op === '=' || op === '!=' || op === '<>' || op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (
        (isLiteralNode(left) && isLiteralNode(right)) ||
        (isLiteralNode(left) && isParamNode(right)) ||
        (isParamNode(left) && isLiteralNode(right)) ||
        (isParamNode(left) && isParamNode(right)) ||
        (isConstLike(left) && isConstLike(right))
      ) {
        state.hasTautology = true;
      }
    }
  }

  for (const [k, v] of Object.entries(obj)) {
    if (k === 'loc') continue;
    collectAstRefsAndCheckTautology(v, outRefs, state, inWhere || k === 'where' || k === 'having');
  }
}

function inspectWithSqlAst(cleanedStmt: string): {
  refs: ParsedTableRef[];
  multiStatement: boolean;
  hasTautology: boolean;
} | null {
  if (cleanedStmt.length > MAX_AST_PARSE_CHARS) return null;
  if (cleanedStmt.split(/\bSELECT\b/i).length > 100) return null;

  for (const database of ['sqlite', 'postgresql'] as const) {
    try {
      const ast = sqlAstParser.astify(cleanedStmt, { database });
      const refs: ParsedTableRef[] = [];
      const state = { hasTautology: false };
      collectAstRefsAndCheckTautology(ast, refs, state, false);
      return {
        refs,
        multiStatement: Array.isArray(ast) && ast.length > 1,
        hasTautology: state.hasTautology,
      };
    } catch {
      // Try next dialect or fall back to deterministic token scanner for dialect-specific extensions
    }
  }
  return null;
}

function hasSqlSelectInto(cleanedStmt: string): boolean {
  if (!/^(?:SELECT|WITH)\b/i.test(cleanedStmt)) return false;
  return /\bINTO\b/i.test(cleanedStmt);
}

function isMutatingStatement(cleaned: string): boolean {
  return (
    /^(?:INSERT|REPLACE|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|TRUNCATE)\b/i.test(cleaned) ||
    /\b(?:INSERT|REPLACE|UPDATE|DELETE|MERGE)\b/i.test(cleaned)
  );
}

export interface AssertPluginSqlOptions {
  isRuntime?: boolean;
  fromSqlTag?: boolean;
  allowUnscopedCoreReads?: boolean;
  allowedCoreTables?: ReadonlySet<string>;
  enforceCoreAllowlist?: boolean;
  ownedTables?: ReadonlySet<string>;
  otherPluginPrefixes?: ReadonlySet<string>;
  strictUnownedMultiSegment?: boolean;
}

export interface CreatePluginDbOptions {
  /** Allowlisted core tables from `manifest.coreTables`. */
  coreTables?: readonly string[];
  /** Internal test hook ONLY: bypass JS lexer check to prove DB-level Postgres role enforcement. */
  enforceLexer?: boolean;
  /** Optional explicit plugin-owned table allowlist for this client. */
  ownedTables?: readonly string[];
  /** Optional sibling plugin prefixes to reject cross-plugin prefix overlap in SQLite/D1. */
  otherPluginPrefixes?: readonly string[];
  /** Whether to claim `plugin_<id>_` namespace ownership on the shared DB client (default `true`). */
  registerNamespace?: boolean;
}

export function assertPluginSqlAllowed(
  pluginId: string,
  sqlText: string,
  prefix = pluginTablePrefix(pluginId),
  options: AssertPluginSqlOptions = {},
): void {
  const rawLexed = stripCommentsAndStrings(sqlText);
  if (rawLexed.hasDollarQuotes) {
    throw new PluginSqlAccessError(pluginId, 'dollar-quoted strings are disallowed in plugin SQL');
  }
  if (options.isRuntime && rawLexed.hasComments) {
    throw new PluginSqlAccessError(pluginId, 'SQL comments are disallowed in runtime queries');
  }

  const statements = splitPluginSqlStatements(sqlText);
  if (options.isRuntime && statements.length > 1) {
    throw new PluginSqlAccessError(
      pluginId,
      'multi-statement SQL execution is disallowed in runtime queries (use db.batch)',
    );
  }

  const pluginSchemaName = prefix.endsWith('_') ? prefix.slice(0, -1) : prefix;

  for (const stmt of statements) {
    const lexed = stripCommentsAndStrings(stmt);
    const cleaned = lexed.cleaned.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;

    const astInfo = inspectWithSqlAst(cleaned);
    if (options.isRuntime && astInfo?.multiStatement) {
      throw new PluginSqlAccessError(
        pluginId,
        'multi-statement SQL execution is disallowed in runtime queries',
      );
    }

    if (options.isRuntime) {
      if (lexed.hasComments) {
        throw new PluginSqlAccessError(pluginId, 'SQL comments are disallowed in runtime queries');
      }
      if (lexed.hasDollarQuotes) {
        throw new PluginSqlAccessError(pluginId, 'dollar-quoted strings are disallowed in runtime queries');
      }
      // Block unparameterized string literals in WHERE/HAVING even when using sql`...`
      if (lexed.rawStringLiterals.length > 0) {
        const whereIdx = cleaned.search(/\b(?:WHERE|HAVING)\b/i);
        if (whereIdx !== -1 && /''/.test(cleaned.slice(whereIdx))) {
          throw new PluginSqlAccessError(
            pluginId,
            'unparameterized string literals in WHERE/HAVING are disallowed; use sql`...` or ? parameters',
          );
        }
      }
      if (/''\s*\|\||\s*\|\|\s*''/i.test(cleaned)) {
        throw new PluginSqlAccessError(pluginId, 'string concatenation operators with literals are disallowed');
      }
      if (/\bUNION\s+(?:ALL\s+)?SELECT\b/i.test(cleaned)) {
        throw new PluginSqlAccessError(pluginId, 'UNION SELECT is disallowed in runtime plugin queries');
      }
      if (astInfo?.hasTautology) {
        throw new PluginSqlAccessError(pluginId, 'tautological or constant-only WHERE comparison is disallowed');
      }
      if (
        /\b(?:OR\s+(?:(?:\d+|''|TRUE|FALSE|\?|\$\d+)\s*(?:=|!=|<>)\s*(?:\d+|''|TRUE|FALSE|\?|\$\d+)|TRUE)|(?:WHERE|HAVING)\s+(?:\d+|''|TRUE)\s*=\s*(?:\?|\$\d+|\d+|''|TRUE))\b/i.test(
          cleaned,
        )
      ) {
        throw new PluginSqlAccessError(pluginId, 'tautological WHERE/HAVING condition is disallowed');
      }
    }

    if (/\b(?:ATTACH|DETACH|VACUUM|REINDEX|COPY|TRUNCATE|GRANT|REVOKE)\b/i.test(cleaned)) {
      throw new PluginSqlAccessError(pluginId, `forbidden SQL command in "${cleaned.slice(0, 48)}"`);
    }

    if (/\bload_extension\s*\(/i.test(cleaned)) {
      throw new PluginSqlAccessError(pluginId, 'load_extension() is disallowed in plugin SQL');
    }

    if (/\b(?:FROM|JOIN|UPDATE|DELETE\s+FROM)\s+ONLY\b/i.test(cleaned)) {
      throw new PluginSqlAccessError(pluginId, 'ONLY table modifier is disallowed in plugin SQL');
    }

    if (hasSqlSelectInto(cleaned)) {
      throw new PluginSqlAccessError(pluginId, 'SELECT ... INTO is disallowed');
    }

    if (/\bMERGE\s+(?:INTO\b)?/i.test(cleaned)) {
      throw new PluginSqlAccessError(pluginId, 'MERGE is disallowed');
    }

    if (/^PRAGMA\b/i.test(cleaned)) {
      if (!/^PRAGMA\s+defer_foreign_keys\s*=\s*(?:ON|TRUE|1)\s*$/i.test(cleaned)) {
        throw new PluginSqlAccessError(
          pluginId,
          `only "PRAGMA defer_foreign_keys = ON" is permitted (got "${cleaned}")`,
        );
      }
      continue;
    }

    // Merge AST-extracted table references with deterministic token scanner references
    const tokenRefs = extractTableReferencesFromCleaned(cleaned);
    const mergedMap = new Map<string, ParsedTableRef>();
    for (const r of [...tokenRefs, ...(astInfo?.refs ?? [])]) {
      mergedMap.set(`${r.schema ?? ''}:${r.table}`, r);
    }

    for (const ref of mergedMap.values()) {
      const schema = ref.schema;
      const table = ref.table;
      if (schema) {
        if (
          schema === 'information_schema' ||
          schema.startsWith('pg_') ||
          schema.startsWith('sqlite_') ||
          (schema !== 'main' && schema !== pluginSchemaName)
        ) {
          throw new PluginSqlAccessError(
            pluginId,
            `access to schema "${schema}" is forbidden`,
          );
        }
      }

      if (
        SENSITIVE_SYSTEM_TABLES.has(table) ||
        table.startsWith('pg_') ||
        table.startsWith('sqlite_') ||
        table.startsWith('pragma_') ||
        table === 'information_schema'
      ) {
        throw new PluginSqlAccessError(
          pluginId,
          `access to system/sensitive table "${table}" is forbidden`,
        );
      }

      if (table === 'invites' && /\btoken_hash\b/i.test(cleaned)) {
        throw new PluginSqlAccessError(pluginId, 'reading invites.token_hash is forbidden');
      }

      const isPrefixedOwned = table.startsWith(prefix);
      if (isPrefixedOwned) {
        assertOwnedPluginTableName(pluginId, prefix, table, options, 'table read');
        continue;
      }

      if (table.startsWith('plugin_')) {
        throw new PluginSqlAccessError(
          pluginId,
          `cross-plugin table read "${table}" is forbidden (expected prefix "${prefix}")`,
        );
      }

      const isAllowedCore = options.enforceCoreAllowlist
        ? Boolean(options.allowedCoreTables?.has(table))
        : SAFE_CORE_READ_TABLES.has(table);
      if (!isAllowedCore) {
        throw new PluginSqlAccessError(
          pluginId,
          options.enforceCoreAllowlist
            ? `core table "${table}" must be declared in manifest.coreTables`
            : `table "${table}" is not accessible to plugins`,
        );
      }

      if (options.isRuntime) {
        const isDdlStatement = /^(?:CREATE|ALTER|DROP)\b/i.test(cleaned);
        if (!options.allowUnscopedCoreReads && !isDdlStatement) {
          const whereMatch = /\bWHERE\b([\s\S]*)$/i.exec(cleaned);
          const whereClause = whereMatch?.[1] ?? '';
          const hasColumnBoundComparison =
            /(?:\b[a-z_][a-z0-9_.]*\s*(?:=|!=|<>|<|<=|>|>=|LIKE\s+|IN\s*\()\s*(?:\?|\$\d+)|(?:\?|\$\d+)\s*(?:=|!=|<>|<|<=|>|>=)\s*[a-z_][a-z0-9_.]*\b)/i.test(
              whereClause,
            );
          if (!whereMatch || !hasColumnBoundComparison) {
            throw new PluginSqlAccessError(
              pluginId,
              `unscoped query on core table "${table}" requires a column-parameterized WHERE clause (workspace_id / scope filter)`,
            );
          }
        }
      }
    }

    // Scan every DML mutation keyword across the entire statement (catches CTEs too)
    let matchedDmlCount = 0;
    const dmlPatterns: Array<[RegExp, string]> = [
      [/\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+([`"\w.[\]-]+)/gi, 'INSERT/REPLACE'],
      [/\bUPDATE\s+(?:OR\s+\w+\s+|ONLY\s+)?([`"\w.[\]-]+)/gi, 'UPDATE'],
      [/\bDELETE\s+FROM\s+(?:ONLY\s+)?([`"\w.[\]-]+)/gi, 'DELETE'],
    ];
    for (const [re, label] of dmlPatterns) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(cleaned)) !== null) {
        if (label === 'UPDATE' && /\bON\s+CONFLICT\b[\s\S]*\bDO\s+$/i.test(cleaned.slice(0, match.index))) {
          continue;
        }
        matchedDmlCount++;
        assertIdentifierPrefixed(pluginId, prefix, match[1]!, label, options);
      }
    }
    if (/^(?:INSERT|REPLACE|UPDATE|DELETE)\b/i.test(cleaned)) {
      if (matchedDmlCount === 0) {
        throw new PluginSqlAccessError(
          pluginId,
          `unable to parse DML target in "${cleaned.slice(0, 48)}"`,
        );
      }
      continue;
    }

    // Validate DDL targets
    if (/^CREATE\s+(?:(?:TEMP|TEMPORARY|VIRTUAL)\s+)?TABLE\b/i.test(cleaned)) {
      const m = /^CREATE\s+(?:(?:TEMP|TEMPORARY|VIRTUAL)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.[\]-]+)/i.exec(
        cleaned,
      );
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE TABLE target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'CREATE TABLE', options);
      continue;
    }

    if (/^ALTER\s+TABLE\b/i.test(cleaned)) {
      const m = /^ALTER\s+TABLE\s+([`"\w.[\]-]+)/i.exec(cleaned);
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse ALTER TABLE target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'ALTER TABLE', options);
      const renameMatch = /\bRENAME\s+TO\s+([`"\w.[\]-]+)/i.exec(cleaned);
      if (renameMatch?.[1]) {
        assertIdentifierPrefixed(pluginId, prefix, renameMatch[1], 'ALTER TABLE RENAME TO', options);
      }
      continue;
    }

    if (/^DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)\b/i.test(cleaned)) {
      const m = /^DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)\s+(?:IF\s+EXISTS\s+)?([`"\w.[\]-]+)/i.exec(
        cleaned,
      );
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse DROP target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'DROP', options);
      continue;
    }

    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(cleaned)) {
      const m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.[\]-]+)\s+ON\s+([`"\w.[\]-]+)/i.exec(
        cleaned,
      );
      if (!m?.[1] || !m?.[2]) {
        throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE INDEX target');
      }
      assertIdentifierPrefixed(pluginId, prefix, m[2], 'CREATE INDEX ON', options);
      continue;
    }

    if (/^CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\b/i.test(cleaned)) {
      const m = /^CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.[\]-]+)\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:INSERT|UPDATE|DELETE)(?:\s+OF\s+[^O]+)?\s+ON\s+([`"\w.[\]-]+)/i.exec(
        cleaned,
      );
      if (!m?.[2]) {
        throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE TRIGGER target table');
      }
      assertIdentifierPrefixed(pluginId, prefix, m[2], 'CREATE TRIGGER ON', options);
      continue;
    }

    if (/^CREATE\s+VIEW\b/i.test(cleaned)) {
      const m = /^CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.[\]-]+)/i.exec(cleaned);
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE VIEW target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'CREATE VIEW', options);
      continue;
    }

    if (!/^(?:SELECT|WITH|EXPLAIN)\b/i.test(cleaned)) {
      throw new PluginSqlAccessError(
        pluginId,
        `unsupported or disallowed SQL statement: "${cleaned.slice(0, 48)}"`,
      );
    }
  }
}

/**
 * Translates `?` placeholders outside quotes to `$1, $2, ...` and normalizes common SQLite portability idioms
 * (`INSERT OR IGNORE`, `MAX(0, ...)`, `INTEGER PRIMARY KEY AUTOINCREMENT`) outside string literals and comments.
 */
export function translateSqlToPostgres(sqlText: string): string {
  const segments: Array<{ isCode: boolean; text: string }> = [];
  let i = 0;
  const len = sqlText.length;
  let codeBuf = '';

  const flushCode = () => {
    if (codeBuf) {
      segments.push({ isCode: true, text: codeBuf });
      codeBuf = '';
    }
  };

  while (i < len) {
    const ch = sqlText[i]!;
    const next = sqlText[i + 1];

    if (ch === '-' && next === '-') {
      flushCode();
      const start = i;
      i += 2;
      while (i < len && sqlText[i] !== '\n') i++;
      segments.push({ isCode: false, text: sqlText.slice(start, i) });
      continue;
    }

    if (ch === '/' && next === '*') {
      flushCode();
      const start = i;
      i += 2;
      while (i < len - 1 && !(sqlText[i] === '*' && sqlText[i + 1] === '/')) i++;
      i = Math.min(len, i + 2);
      segments.push({ isCode: false, text: sqlText.slice(start, i) });
      continue;
    }

    if ((ch === 'e' || ch === 'E') && next === "'" && (i === 0 || !/[A-Za-z0-9_$]/.test(sqlText[i - 1]!))) {
      flushCode();
      const start = i;
      i += 2;
      while (i < len) {
        if (sqlText[i] === '\\') i += 2;
        else if (sqlText[i] === "'" && sqlText[i + 1] === "'") i += 2;
        else if (sqlText[i] === "'") {
          i++;
          break;
        } else i++;
      }
      segments.push({ isCode: false, text: sqlText.slice(start, i) });
      continue;
    }

    if (ch === "'") {
      flushCode();
      const start = i;
      i++;
      while (i < len) {
        if (sqlText[i] === "'" && sqlText[i + 1] === "'") i += 2;
        else if (sqlText[i] === "'") {
          i++;
          break;
        } else i++;
      }
      segments.push({ isCode: false, text: sqlText.slice(start, i) });
      continue;
    }

    if (ch === '"') {
      flushCode();
      const start = i;
      i++;
      while (i < len) {
        if (sqlText[i] === '"' && sqlText[i + 1] === '"') i += 2;
        else if (sqlText[i] === '"') {
          i++;
          break;
        } else i++;
      }
      segments.push({ isCode: false, text: sqlText.slice(start, i) });
      continue;
    }

    codeBuf += ch;
    i++;
  }
  flushCode();

  let paramIdx = 1;
  let hasInsertOrIgnore = false;
  let hasOnConflict = false;

  const rewritten = segments.map((seg) => {
    if (!seg.isCode) return seg;
    let txt = '';
    for (let j = 0; j < seg.text.length; j++) {
      if (seg.text[j] === '?') txt += `$${paramIdx++}`;
      else txt += seg.text[j]!;
    }
    txt = txt.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, () => {
      hasInsertOrIgnore = true;
      return 'INSERT INTO';
    });
    if (/\bON\s+CONFLICT\b/i.test(txt)) {
      hasOnConflict = true;
    }
    txt = txt.replace(/\bMAX\s*\(\s*0\s*,/gi, 'GREATEST(0,');
    txt = txt.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY');
    return { isCode: true, text: txt };
  });

  if (hasInsertOrIgnore && !hasOnConflict) {
    let inserted = false;
    for (let s = 0; s < rewritten.length; s++) {
      const seg = rewritten[s]!;
      if (!seg.isCode) continue;
      const retMatch = /\bRETURNING\b/i.exec(seg.text);
      if (retMatch) {
        seg.text = `${seg.text.slice(0, retMatch.index)} ON CONFLICT DO NOTHING ${seg.text.slice(retMatch.index)}`;
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      rewritten.push({ isCode: true, text: ' ON CONFLICT DO NOTHING' });
    }
  }

  return rewritten.map((s) => s.text).join('');
}

function unwrapSqlInput(
  input: string | SqlFragment,
  pluginId: string,
  params: readonly unknown[] = [],
): { sqlText: string; boundParams: readonly unknown[]; fromSqlTag: boolean } {
  if (typeof input === 'string') {
    return { sqlText: input, boundParams: params, fromSqlTag: false };
  }
  if (isAuthenticSqlFragment(input)) {
    return { sqlText: input.text, boundParams: input.params, fromSqlTag: true };
  }
  throw new PluginSqlAccessError(pluginId, 'forged or invalid SqlFragment passed to PluginDb');
}

function assertWriteAllowedInRequest(pluginId: string, sqlText: string): void {
  const method = httpMethodStorage.getStore();
  if (method === 'GET' || method === 'HEAD') {
    const cleaned = stripCommentsAndStrings(sqlText).cleaned.replace(/\s+/g, ' ').trim();
    if (isMutatingStatement(cleaned)) {
      throw new PluginSqlAccessError(
        pluginId,
        `state-changing SQL is forbidden during HTTP ${method} requests`,
      );
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, pluginId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PluginSqlAccessError(pluginId, `query exceeded ${timeoutMs}ms timeout`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SAFE_COLUMN_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const ALLOWED_QB_OPS = new Set<SqlComparisonOp>([
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'LIKE',
  'IN',
  'IS NULL',
  'IS NOT NULL',
]);

function assertSafeColumnIdent(pluginId: string, column: string): string {
  const clean = column.trim();
  if (!SAFE_COLUMN_IDENT_RE.test(clean)) {
    throw new PluginSqlAccessError(pluginId, `invalid column identifier "${column}"`);
  }
  return clean;
}

export function createPluginDb(
  rawDb: unknown,
  pluginId: string,
  dbOptions: CreatePluginDbOptions = {},
): PluginDb {
  const client = unwrapDbClient(rawDb);
  const prefix = pluginTablePrefix(pluginId);
  const dialect: PluginDialect = isPostgresClient(client) ? 'postgres' : 'sqlite';
  const enforceLexer = dbOptions.enforceLexer !== false;
  const enforceCoreAllowlist = dbOptions.coreTables !== undefined;
  const allowedCoreTables = new Set(dbOptions.coreTables ?? []);

  registerPluginOwnedTables(rawDb, pluginId, dbOptions.ownedTables ?? [], {
    registerNamespace: dbOptions.registerNamespace,
  });

  const ensureClient = () => {
    if (!client || (!isPostgresClient(client) && typeof (client as { prepare?: unknown }).prepare !== 'function')) {
      throw new PluginSqlAccessError(pluginId, 'database binding is not available');
    }
  };

  const checkRuntimeSql = (sqlText: string, fromSqlTag: boolean) => {
    if (!enforceLexer) return;
    const clientKey =
      client && (typeof client === 'object' || typeof client === 'function') ? (client as object) : null;
    const owned = clientKey ? ownedTablesByDb.get(clientKey)?.get(pluginId) : undefined;
    const allPrefixes = clientKey ? registeredPrefixesByDb.get(clientKey) : undefined;
    const combinedOtherPrefixes = new Set<string>(dbOptions.otherPluginPrefixes ?? []);
    if (allPrefixes) {
      for (const p of allPrefixes) {
        if (p !== prefix) combinedOtherPrefixes.add(p);
      }
    }
    assertPluginSqlAllowed(pluginId, sqlText, prefix, {
      isRuntime: true,
      fromSqlTag,
      allowedCoreTables,
      enforceCoreAllowlist,
      ownedTables: owned,
      otherPluginPrefixes: combinedOtherPrefixes.size > 0 ? combinedOtherPrefixes : undefined,
      strictUnownedMultiSegment: !isPostgresClient(client),
    });
  };

  const api: PluginDb = {
    pluginId,
    prefix,
    dialect,
    table(shortName: string): SqlIdentifier {
      return buildPluginTableIdentifier(pluginId, shortName);
    },
    sql: sqlTag,

    from<T = Record<string, unknown>>(shortName: string): PluginTableQueryBuilder<T> {
      const tableIdent = buildPluginTableIdentifier(pluginId, shortName);
      let selectCols: string[] = [];
      const wheres: Array<{ sql: string; params: unknown[] }> = [];
      const orderBys: Array<{ col: string; dir: 'ASC' | 'DESC' }> = [];
      let limitVal: number | null = null;

      const buildWhereSql = (): { clause: string; params: unknown[] } => {
        if (wheres.length === 0) return { clause: '', params: [] };
        return {
          clause: ` WHERE ${wheres.map((w) => w.sql).join(' AND ')}`,
          params: wheres.flatMap((w) => w.params),
        };
      };

      const buildSelectSql = (): { sql: string; params: unknown[] } => {
        const cols = selectCols.length > 0 ? selectCols.join(', ') : '*';
        const { clause, params } = buildWhereSql();
        const orderSql =
          orderBys.length > 0
            ? ` ORDER BY ${orderBys.map((o) => `${o.col} ${o.dir}`).join(', ')}`
            : '';
        const limitSql = limitVal !== null ? ` LIMIT ${limitVal}` : '';
        return {
          sql: `SELECT ${cols} FROM ${tableIdent.value}${clause}${orderSql}${limitSql}`,
          params,
        };
      };

      const builder: PluginTableQueryBuilder<T> = {
        select(...columns: string[]) {
          selectCols = columns.map((c) => assertSafeColumnIdent(pluginId, c));
          return builder;
        },
        where(column: string, op: SqlComparisonOp, value?: unknown) {
          const safeCol = assertSafeColumnIdent(pluginId, column);
          if (!ALLOWED_QB_OPS.has(op)) {
            throw new PluginSqlAccessError(pluginId, `unsupported comparison operator "${String(op)}"`);
          }
          if (op === 'IS NULL' || op === 'IS NOT NULL') {
            wheres.push({ sql: `${safeCol} ${op}`, params: [] });
          } else if (op === 'IN') {
            if (!Array.isArray(value) || value.length === 0) {
              throw new PluginSqlAccessError(pluginId, 'IN filter requires a non-empty array');
            }
            wheres.push({
              sql: `${safeCol} IN (${value.map(() => '?').join(', ')})`,
              params: [...value],
            });
          } else {
            wheres.push({ sql: `${safeCol} ${op} ?`, params: [value] });
          }
          return builder;
        },
        orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC') {
          const safeCol = assertSafeColumnIdent(pluginId, column);
          const safeDir = direction === 'DESC' ? 'DESC' : 'ASC';
          orderBys.push({ col: safeCol, dir: safeDir });
          return builder;
        },
        limit(count: number) {
          if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) {
            throw new PluginSqlAccessError(pluginId, `invalid LIMIT value "${String(count)}"`);
          }
          limitVal = Math.min(Math.trunc(count), 5_000);
          return builder;
        },
        all(options?: PluginDbQueryOptions) {
          const { sql, params } = buildSelectSql();
          return api.query<T>(sql, params, options);
        },
        first(options?: PluginDbQueryOptions) {
          const { sql, params } = buildSelectSql();
          return api.first<T>(sql, params, options);
        },
        insert(values: Record<string, unknown>, options?: PluginDbQueryOptions) {
          const entries = Object.entries(values);
          if (entries.length === 0) {
            throw new PluginSqlAccessError(pluginId, 'insert() requires at least one column');
          }
          const cols = entries.map(([k]) => assertSafeColumnIdent(pluginId, k));
          const params = entries.map(([, v]) => v);
          const placeholders = cols.map(() => '?').join(', ');
          return api.execute(
            `INSERT INTO ${tableIdent.value} (${cols.join(', ')}) VALUES (${placeholders})`,
            params,
            options,
          );
        },
        update(values: Record<string, unknown>, options?: PluginDbQueryOptions) {
          if (wheres.length === 0) {
            throw new PluginSqlAccessError(pluginId, 'update() requires at least one where() clause');
          }
          const entries = Object.entries(values);
          if (entries.length === 0) {
            throw new PluginSqlAccessError(pluginId, 'update() requires at least one column');
          }
          const setSql = entries.map(([k]) => `${assertSafeColumnIdent(pluginId, k)} = ?`).join(', ');
          const setParams = entries.map(([, v]) => v);
          const { clause, params } = buildWhereSql();
          return api.execute(
            `UPDATE ${tableIdent.value} SET ${setSql}${clause}`,
            [...setParams, ...params],
            options,
          );
        },
        delete(options?: PluginDbQueryOptions) {
          if (wheres.length === 0) {
            throw new PluginSqlAccessError(pluginId, 'delete() requires at least one where() clause');
          }
          const { clause, params } = buildWhereSql();
          return api.execute(`DELETE FROM ${tableIdent.value}${clause}`, params, options);
        },
      };

      return builder;
    },

    async query<T = Record<string, unknown>>(
      input: string | SqlFragment,
      params: readonly unknown[] = [],
      options: PluginDbQueryOptions = {},
    ): Promise<T[]> {
      ensureClient();
      const { sqlText, boundParams, fromSqlTag } = unwrapSqlInput(input, pluginId, params);
      checkRuntimeSql(sqlText, fromSqlTag);
      if (enforceLexer) assertWriteAllowedInRequest(pluginId, sqlText);

      const maxRows = Math.min(Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS), 5_000);
      const timeoutMs = clampQueryTimeoutMs(options.timeoutMs);

      const execQuery = async (): Promise<T[]> => {
        if (isPostgresClient(client)) {
          const pgSql = translateSqlToPostgres(sqlText);
          const rows = await withPluginPostgresRole(
            client,
            pluginId,
            (roleTx) => roleTx.unsafe(pgSql, [...boundParams]),
            { coreTables: dbOptions.coreTables },
          );
          return rows.slice(0, maxRows) as T[];
        }
        if (isD1Database(client)) {
          const res = await client.prepare(sqlText).bind(...boundParams).all<T>();
          return (res.results ?? []).slice(0, maxRows);
        }
        const rows = (client as SqliteLikeDb).prepare(sqlText).all(...boundParams) as T[];
        return rows.slice(0, maxRows);
      };

      return withTimeout(execQuery(), timeoutMs, pluginId);
    },

    async first<T = Record<string, unknown>>(
      input: string | SqlFragment,
      params: readonly unknown[] = [],
      options: PluginDbQueryOptions = {},
    ): Promise<T | null> {
      ensureClient();
      const { sqlText, boundParams, fromSqlTag } = unwrapSqlInput(input, pluginId, params);
      checkRuntimeSql(sqlText, fromSqlTag);
      if (enforceLexer) assertWriteAllowedInRequest(pluginId, sqlText);

      const timeoutMs = clampQueryTimeoutMs(options.timeoutMs);
      const execFirst = async (): Promise<T | null> => {
        if (isPostgresClient(client)) {
          const pgSql = translateSqlToPostgres(sqlText);
          const rows = await withPluginPostgresRole(
            client,
            pluginId,
            (roleTx) => roleTx.unsafe(pgSql, [...boundParams]),
            { coreTables: dbOptions.coreTables },
          );
          return (rows[0] as T | undefined) ?? null;
        }
        if (isD1Database(client)) {
          return (await client.prepare(sqlText).bind(...boundParams).first<T>()) ?? null;
        }
        return ((client as SqliteLikeDb).prepare(sqlText).get(...boundParams) as T | undefined) ?? null;
      };

      return withTimeout(execFirst(), timeoutMs, pluginId);
    },

    async execute(
      input: string | SqlFragment,
      params: readonly unknown[] = [],
      options: PluginDbQueryOptions = {},
    ): Promise<{ changes: number; lastRowId?: number | string }> {
      ensureClient();
      const { sqlText, boundParams, fromSqlTag } = unwrapSqlInput(input, pluginId, params);
      checkRuntimeSql(sqlText, fromSqlTag);

      const method = httpMethodStorage.getStore();
      if (method === 'GET' || method === 'HEAD') {
        throw new PluginSqlAccessError(
          pluginId,
          `PluginDb.execute() is forbidden during HTTP ${method} requests`,
        );
      }

      const timeoutMs = clampQueryTimeoutMs(options.timeoutMs);
      const execMutate = async (): Promise<{ changes: number; lastRowId?: number | string }> => {
        if (isPostgresClient(client)) {
          const pgSql = translateSqlToPostgres(sqlText);
          const res = await withPluginPostgresRole(
            client,
            pluginId,
            (roleTx) => roleTx.unsafe(pgSql, [...boundParams]),
            { coreTables: dbOptions.coreTables },
          );
          return {
            changes: Number(res.count ?? res.length ?? 0),
          };
        }
        if (isD1Database(client)) {
          const res = await client.prepare(sqlText).bind(...boundParams).run();
          return {
            changes: Number(res.meta?.changes ?? 0),
            lastRowId: res.meta?.last_row_id,
          };
        }
        const info = (client as SqliteLikeDb).prepare(sqlText).run(...boundParams);
        return {
          changes: Number(info.changes ?? 0),
          lastRowId:
            typeof info.lastInsertRowid === 'bigint'
              ? Number(info.lastInsertRowid)
              : info.lastInsertRowid,
        };
      };

      const result = await withTimeout(execMutate(), timeoutMs, pluginId);
      const createdTables = extractCreatedTablesFromSql(sqlText);
      if (createdTables.length > 0) {
        registerPluginOwnedTables(rawDb, pluginId, createdTables);
      }
      return result;
    },

    async batch(statements: ReadonlyArray<PluginDbStatement>): Promise<void> {
      if (statements.length === 0) return;
      ensureClient();

      const method = httpMethodStorage.getStore();
      if (method === 'GET' || method === 'HEAD') {
        throw new PluginSqlAccessError(
          pluginId,
          `PluginDb.batch() is forbidden during HTTP ${method} requests`,
        );
      }

      const resolved = statements.map((s) => {
        const { sqlText, boundParams, fromSqlTag } = unwrapSqlInput(s.sql, pluginId, s.params ?? []);
        checkRuntimeSql(sqlText, fromSqlTag);
        return { sqlText, boundParams };
      });

      const execBatch = async () => {
        if (isPostgresClient(client)) {
          await withPluginPostgresRole(
            client,
            pluginId,
            async (roleTx) => {
              for (const s of resolved) {
                await roleTx.unsafe(translateSqlToPostgres(s.sqlText), [...s.boundParams]);
              }
            },
            { coreTables: dbOptions.coreTables },
          );
          return;
        }

        if (isD1Database(client)) {
          const prepared: D1PreparedStatement[] = resolved.map((s) =>
            client.prepare(s.sqlText).bind(...s.boundParams),
          );
          await client.batch(prepared);
          return;
        }

        const sqlite = client as SqliteLikeDb;
        const runAll = () => {
          for (const s of resolved) {
            sqlite.prepare(s.sqlText).run(...s.boundParams);
          }
        };
        if (typeof sqlite.transaction === 'function') {
          sqlite.transaction(runAll)();
        } else {
          runAll();
        }
      };

      await withTimeout(execBatch(), DEFAULT_QUERY_TIMEOUT_MS, pluginId);
      const createdTables = resolved.flatMap((s) => extractCreatedTablesFromSql(s.sqlText));
      if (createdTables.length > 0) {
        registerPluginOwnedTables(rawDb, pluginId, createdTables);
      }
    },
  };

  return api;
}
