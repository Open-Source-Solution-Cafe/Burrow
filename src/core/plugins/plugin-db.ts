import { AsyncLocalStorage } from 'node:async_hooks';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import {
  buildPluginTableIdentifier,
  sql as sqlTag,
  type PluginDb,
  type PluginDbQueryOptions,
  type PluginDbStatement,
  type PluginDialect,
  type SqlFragment,
  type SqlIdentifier,
} from '@burrow/sdk';
import { pluginTablePrefix } from './manifest';

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
  begin<T>(cb: (tx: PostgresLikeSql) => Promise<T>): Promise<T>;
}

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_QUERY_TIMEOUT_MS = 3_000;

const httpMethodStorage = new AsyncLocalStorage<string>();

export function runWithPluginHttpMethod<T>(method: string, fn: () => Promise<T>): Promise<T> {
  return httpMethodStorage.run(method.toUpperCase(), fn);
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

/**
 * Lexer-aware comment & literal stripper.
 * Properly tracks `'...'` literals, `"..."` / `` `...` `` / `[...]` identifiers,
 * and Postgres `$$...$$` / `$tag$...$tag$` dollar-quoted blocks so quoted apostrophes never desync state.
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

    // Bracket identifier ([...])
    if (ch === '[') {
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

/** Split SQL into non-empty statements while respecting quotes, identifiers, dollar-quotes, and trigger BEGIN...END blocks. */
export function splitPluginSqlStatements(sqlText: string): string[] {
  const chunks = sqlText.split('--> statement-breakpoint');
  const statements: string[] = [];

  for (const chunk of chunks) {
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inBacktick = false;
    let inBracket = false;
    let activeDollarTag: string | null = null;
    let triggerDepth = 0;
    const len = chunk.length;

    for (let i = 0; i < len; i++) {
      const ch = chunk[i]!;
      const next = chunk[i + 1];

      if (!inSingleQuote && !inDoubleQuote && !inBacktick && !inBracket && !activeDollarTag) {
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
      } else if (activeDollarTag) {
        if (chunk.startsWith(activeDollarTag, i)) {
          current += activeDollarTag;
          i += activeDollarTag.length - 1;
          activeDollarTag = null;
          continue;
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
          i += 2 - 1;
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

      if (ch === '[' && !inSingleQuote && !inDoubleQuote && !inBacktick) {
        inBracket = true;
        current += ch;
        continue;
      }
      if (ch === ']' && inBracket) {
        inBracket = false;
        current += ch;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && !inBacktick && !inBracket) {
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

function normalizeIdentifier(raw: string): string {
  const trimmed = raw.trim().replace(/^[`"[]|[`"\]]$/g, '');
  const parts = trimmed.split('.');
  const table = parts[parts.length - 1] ?? trimmed;
  return table.replace(/^[`"[]|[`"\]]$/g, '').toLowerCase();
}

function assertIdentifierPrefixed(pluginId: string, prefix: string, rawTarget: string, op: string): void {
  const target = normalizeIdentifier(rawTarget);
  if (!target.startsWith(prefix)) {
    throw new PluginSqlAccessError(
      pluginId,
      `${op} target "${target}" must start with "${prefix}"`,
    );
  }
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

function extractReferencedTables(cleanedStmt: string): string[] {
  const tables: string[] = [];
  const re = /\b(?:FROM|JOIN)\s+([`"\w.[\]-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cleanedStmt)) !== null) {
    const raw = match[1]!;
    if (raw.startsWith('(')) continue;
    tables.push(normalizeIdentifier(raw));
  }
  return tables;
}

function isMutatingStatement(cleaned: string): boolean {
  return /^(?:INSERT|REPLACE|UPDATE|DELETE|CREATE|ALTER|DROP|MERGE|TRUNCATE)\b/i.test(cleaned) ||
    /\b(?:INSERT|REPLACE|UPDATE|DELETE|MERGE)\b/i.test(cleaned);
}

export interface AssertPluginSqlOptions {
  isRuntime?: boolean;
  fromSqlTag?: boolean;
  allowUnscopedCoreReads?: boolean;
}

export function assertPluginSqlAllowed(
  pluginId: string,
  sqlText: string,
  prefix = pluginTablePrefix(pluginId),
  options: AssertPluginSqlOptions = {},
): void {
  if (options.isRuntime) {
    const rawLexed = stripCommentsAndStrings(sqlText);
    if (rawLexed.hasComments) {
      throw new PluginSqlAccessError(pluginId, 'SQL comments are disallowed in runtime queries');
    }
    if (rawLexed.hasDollarQuotes) {
      throw new PluginSqlAccessError(pluginId, 'dollar-quoted strings are disallowed in runtime queries');
    }
  }

  const statements = splitPluginSqlStatements(sqlText);
  if (options.isRuntime && statements.length > 1) {
    throw new PluginSqlAccessError(
      pluginId,
      'multi-statement SQL execution is disallowed in runtime queries (use db.batch)',
    );
  }

  for (const stmt of statements) {
    const lexed = stripCommentsAndStrings(stmt);
    const cleaned = lexed.cleaned.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;

    if (options.isRuntime) {
      if (lexed.hasComments) {
        throw new PluginSqlAccessError(pluginId, 'SQL comments are disallowed in runtime queries');
      }
      if (lexed.hasDollarQuotes) {
        throw new PluginSqlAccessError(pluginId, 'dollar-quoted strings are disallowed in runtime queries');
      }
      // Block string-concatenated SQLi patterns and unparameterized WHERE string literals
      if (!options.fromSqlTag && lexed.rawStringLiterals.length > 0) {
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
    }

    if (/\b(?:ATTACH|DETACH|VACUUM|REINDEX|COPY|TRUNCATE|GRANT|REVOKE)\b/i.test(cleaned)) {
      throw new PluginSqlAccessError(pluginId, `forbidden SQL command in "${cleaned.slice(0, 48)}"`);
    }

    if (/\bSELECT\b[\s\S]*\bINTO\b/i.test(cleaned)) {
      throw new PluginSqlAccessError(pluginId, 'SELECT ... INTO is disallowed');
    }

    if (/\bMERGE\s+INTO\b/i.test(cleaned)) {
      throw new PluginSqlAccessError(pluginId, 'MERGE INTO is disallowed');
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

    // Check referenced tables on reads/joins to block secret & cross-plugin table reads
    const referenced = extractReferencedTables(cleaned);
    for (const table of referenced) {
      if (
        SENSITIVE_SYSTEM_TABLES.has(table) ||
        table.startsWith('pg_') ||
        table.startsWith('sqlite_') ||
        table === 'information_schema'
      ) {
        throw new PluginSqlAccessError(
          pluginId,
          `access to system/sensitive table "${table}" is forbidden`,
        );
      }
      if (table.startsWith('plugin_') && !table.startsWith(prefix)) {
        throw new PluginSqlAccessError(
          pluginId,
          `cross-plugin table read "${table}" is forbidden (expected prefix "${prefix}")`,
        );
      }
      if (table === 'invites' && /\btoken_hash\b/i.test(cleaned)) {
        throw new PluginSqlAccessError(pluginId, 'reading invites.token_hash is forbidden');
      }
      if (
        options.isRuntime &&
        !options.allowUnscopedCoreReads &&
        !table.startsWith(prefix) &&
        SAFE_CORE_READ_TABLES.has(table) &&
        !/\bWHERE\b/i.test(cleaned)
      ) {
        throw new PluginSqlAccessError(
          pluginId,
          `unscoped query on core table "${table}" requires a WHERE clause (workspace_id / scope filter)`,
        );
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
        // SQLite/Postgres upserts use `ON CONFLICT(...) DO UPDATE SET ...`, which mutates the INSERT target above.
        if (label === 'UPDATE' && /\bON\s+CONFLICT\b[\s\S]*\bDO\s+$/i.test(cleaned.slice(0, match.index))) {
          continue;
        }
        matchedDmlCount++;
        assertIdentifierPrefixed(pluginId, prefix, match[1]!, label);
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
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'CREATE TABLE');
      continue;
    }

    if (/^ALTER\s+TABLE\b/i.test(cleaned)) {
      const m = /^ALTER\s+TABLE\s+([`"\w.[\]-]+)/i.exec(cleaned);
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse ALTER TABLE target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'ALTER TABLE');
      const renameMatch = /\bRENAME\s+TO\s+([`"\w.[\]-]+)/i.exec(cleaned);
      if (renameMatch?.[1]) {
        assertIdentifierPrefixed(pluginId, prefix, renameMatch[1], 'ALTER TABLE RENAME TO');
      }
      continue;
    }

    if (/^DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)\b/i.test(cleaned)) {
      const m = /^DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)\s+(?:IF\s+EXISTS\s+)?([`"\w.[\]-]+)/i.exec(
        cleaned,
      );
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse DROP target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'DROP');
      continue;
    }

    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(cleaned)) {
      const m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.[\]-]+)\s+ON\s+([`"\w.[\]-]+)/i.exec(
        cleaned,
      );
      if (!m?.[1] || !m?.[2]) {
        throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE INDEX target');
      }
      assertIdentifierPrefixed(pluginId, prefix, m[2], 'CREATE INDEX ON');
      continue;
    }

    if (/^CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\b/i.test(cleaned)) {
      const m = /^CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.[\]-]+)\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:INSERT|UPDATE|DELETE)(?:\s+OF\s+[^O]+)?\s+ON\s+([`"\w.[\]-]+)/i.exec(
        cleaned,
      );
      if (!m?.[2]) {
        throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE TRIGGER target table');
      }
      assertIdentifierPrefixed(pluginId, prefix, m[2], 'CREATE TRIGGER ON');
      continue;
    }

    if (/^CREATE\s+VIEW\b/i.test(cleaned)) {
      const m = /^CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\w.[\]-]+)/i.exec(cleaned);
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE VIEW target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'CREATE VIEW');
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
 * (`INSERT OR IGNORE`, `MAX(0, ...)`) when targeting PostgreSQL.
 */
export function translateSqlToPostgres(sqlText: string): string {
  let out = '';
  let paramIdx = 1;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i]!;
    const next = sqlText[i + 1];

    if (ch === "'" && !inDouble) {
      out += ch;
      if (inSingle && next === "'") {
        out += "'";
        i++;
      } else {
        inSingle = !inSingle;
      }
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (ch === '?' && !inSingle && !inDouble) {
      out += `$${paramIdx++}`;
      continue;
    }
    out += ch;
  }

  let hasInsertOrIgnore = false;
  out = out.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, () => {
    hasInsertOrIgnore = true;
    return 'INSERT INTO';
  });

  if (hasInsertOrIgnore && !/\bON\s+CONFLICT\b/i.test(out)) {
    const returningMatch = /\bRETURNING\b/i.exec(out);
    if (returningMatch) {
      out = `${out.slice(0, returningMatch.index)} ON CONFLICT DO NOTHING ${out.slice(returningMatch.index)}`;
    } else {
      out = `${out} ON CONFLICT DO NOTHING`;
    }
  }

  out = out.replace(/\bMAX\s*\(\s*0\s*,/gi, 'GREATEST(0,');
  out = out.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY');

  return out;
}

function unwrapSqlInput(
  input: string | SqlFragment,
  params: readonly unknown[] = [],
): { sqlText: string; boundParams: readonly unknown[]; fromSqlTag: boolean } {
  if (typeof input === 'string') {
    return { sqlText: input, boundParams: params, fromSqlTag: false };
  }
  if (input && typeof input === 'object' && input.__burrowSql === true) {
    return { sqlText: input.text, boundParams: input.params, fromSqlTag: true };
  }
  throw new Error('Invalid SQL argument passed to PluginDb');
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

export function createPluginDb(rawDb: unknown, pluginId: string): PluginDb {
  const client = unwrapDbClient(rawDb);
  const prefix = pluginTablePrefix(pluginId);
  const dialect: PluginDialect = isPostgresClient(client) ? 'postgres' : 'sqlite';

  const ensureClient = () => {
    if (!client || (!isPostgresClient(client) && typeof (client as { prepare?: unknown }).prepare !== 'function')) {
      throw new PluginSqlAccessError(pluginId, 'database binding is not available');
    }
  };

  return {
    pluginId,
    prefix,
    dialect,
    table(shortName: string): SqlIdentifier {
      return buildPluginTableIdentifier(pluginId, shortName);
    },
    sql: sqlTag,

    async query<T = Record<string, unknown>>(
      input: string | SqlFragment,
      params: readonly unknown[] = [],
      options: PluginDbQueryOptions = {},
    ): Promise<T[]> {
      ensureClient();
      const { sqlText, boundParams, fromSqlTag } = unwrapSqlInput(input, params);
      assertPluginSqlAllowed(pluginId, sqlText, prefix, { isRuntime: true, fromSqlTag });
      assertWriteAllowedInRequest(pluginId, sqlText);

      const maxRows = Math.min(Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS), 5_000);
      const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

      const execQuery = async (): Promise<T[]> => {
        if (isPostgresClient(client)) {
          const pgSql = translateSqlToPostgres(sqlText);
          const rows = await client.unsafe(pgSql, [...boundParams]);
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
      const { sqlText, boundParams, fromSqlTag } = unwrapSqlInput(input, params);
      assertPluginSqlAllowed(pluginId, sqlText, prefix, { isRuntime: true, fromSqlTag });
      assertWriteAllowedInRequest(pluginId, sqlText);

      const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
      const execFirst = async (): Promise<T | null> => {
        if (isPostgresClient(client)) {
          const pgSql = translateSqlToPostgres(sqlText);
          const rows = await client.unsafe(pgSql, [...boundParams]);
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
      const { sqlText, boundParams, fromSqlTag } = unwrapSqlInput(input, params);
      assertPluginSqlAllowed(pluginId, sqlText, prefix, { isRuntime: true, fromSqlTag });

      const method = httpMethodStorage.getStore();
      if (method === 'GET' || method === 'HEAD') {
        throw new PluginSqlAccessError(
          pluginId,
          `PluginDb.execute() is forbidden during HTTP ${method} requests`,
        );
      }

      const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
      const execMutate = async (): Promise<{ changes: number; lastRowId?: number | string }> => {
        if (isPostgresClient(client)) {
          const pgSql = translateSqlToPostgres(sqlText);
          const res = await client.unsafe(pgSql, [...boundParams]);
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

      return withTimeout(execMutate(), timeoutMs, pluginId);
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
        const { sqlText, boundParams, fromSqlTag } = unwrapSqlInput(s.sql, s.params ?? []);
        assertPluginSqlAllowed(pluginId, sqlText, prefix, { isRuntime: true, fromSqlTag });
        return { sqlText, boundParams };
      });

      if (isPostgresClient(client)) {
        await client.begin(async (tx) => {
          for (const s of resolved) {
            await tx.unsafe(translateSqlToPostgres(s.sqlText), [...s.boundParams]);
          }
        });
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
    },
  };
}
