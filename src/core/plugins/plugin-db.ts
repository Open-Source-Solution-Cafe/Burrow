import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { PluginDb, PluginDbStatement } from '@burrow/sdk';
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

function unwrapDbClient(rawDb: unknown): D1Database | SqliteLikeDb {
  if (rawDb && typeof rawDb === 'object' && '$client' in rawDb) {
    return (rawDb as { $client: D1Database | SqliteLikeDb }).$client;
  }
  return rawDb as D1Database | SqliteLikeDb;
}

function isD1Database(client: unknown): client is D1Database {
  return (
    typeof client === 'object' &&
    client !== null &&
    typeof (client as { batch?: unknown }).batch === 'function' &&
    typeof (client as { prepare?: unknown }).prepare === 'function'
  );
}

/** Strip SQL comments and quoted string literals so regexes never inspect string values. */
function stripCommentsAndStrings(sqlText: string): string {
  let out = '';
  let i = 0;
  const len = sqlText.length;
  while (i < len) {
    const ch = sqlText[i]!;
    const next = sqlText[i + 1];
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < len && sqlText[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len - 1 && !(sqlText[i] === '*' && sqlText[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'") {
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
      out += " '' ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split SQL into non-empty statements while respecting quoted literals and trigger BEGIN...END blocks. */
export function splitPluginSqlStatements(sqlText: string): string[] {
  const chunks = sqlText.split('--> statement-breakpoint');
  const statements: string[] = [];

  for (const chunk of chunks) {
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let triggerDepth = 0;
    const len = chunk.length;

    for (let i = 0; i < len; i++) {
      const ch = chunk[i]!;
      const next = chunk[i + 1];

      if (!inSingleQuote && !inDoubleQuote && ch === '-' && next === '-') {
        while (i < len && chunk[i] !== '\n') i++;
        current += '\n';
        continue;
      }
      if (!inSingleQuote && !inDoubleQuote && ch === '/' && next === '*') {
        i += 2;
        while (i < len - 1 && !(chunk[i] === '*' && chunk[i + 1] === '/')) i++;
        i++;
        current += ' ';
        continue;
      }

      if (ch === "'" && !inDoubleQuote) {
        if (inSingleQuote && next === "'") {
          current += "''";
          i++;
          continue;
        }
        inSingleQuote = !inSingleQuote;
        current += ch;
        continue;
      }

      if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += ch;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote) {
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

export function assertPluginSqlAllowed(
  pluginId: string,
  sqlText: string,
  prefix = pluginTablePrefix(pluginId),
): void {
  const statements = splitPluginSqlStatements(sqlText);
  for (const stmt of statements) {
    const cleaned = stripCommentsAndStrings(stmt).replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;

    if (/\b(?:ATTACH|DETACH|VACUUM|REINDEX)\b/i.test(cleaned)) {
      throw new PluginSqlAccessError(pluginId, `forbidden SQL command in "${cleaned.slice(0, 48)}"`);
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

    // Scan every DML mutation keyword across the entire statement (catches CTEs too)
    let matchedDmlCount = 0;
    const dmlPatterns: Array<[RegExp, string]> = [
      [/\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+([`"[\w.]+)/gi, 'INSERT/REPLACE'],
      [/\bUPDATE\s+(?:OR\s+\w+\s+)?([`"[\w.]+)/gi, 'UPDATE'],
      [/\bDELETE\s+FROM\s+([`"[\w.]+)/gi, 'DELETE'],
    ];
    for (const [re, label] of dmlPatterns) {
      let match: RegExpExecArray | null;
      while ((match = re.exec(cleaned)) !== null) {
        // SQLite/Postgres upserts use `ON CONFLICT(...) DO UPDATE SET ...`, which mutates the INSERT target above.
        if (label === 'UPDATE' && /\bDO\s+$/i.test(cleaned.slice(0, match.index))) {
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
      const m = /^CREATE\s+(?:(?:TEMP|TEMPORARY|VIRTUAL)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/i.exec(
        cleaned,
      );
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE TABLE target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'CREATE TABLE');
      continue;
    }

    if (/^ALTER\s+TABLE\b/i.test(cleaned)) {
      const m = /^ALTER\s+TABLE\s+([`"[\w.]+)/i.exec(cleaned);
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse ALTER TABLE target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'ALTER TABLE');
      const renameMatch = /\bRENAME\s+TO\s+([`"[\w.]+)/i.exec(cleaned);
      if (renameMatch?.[1]) {
        assertIdentifierPrefixed(pluginId, prefix, renameMatch[1], 'ALTER TABLE RENAME TO');
      }
      continue;
    }

    if (/^DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)\b/i.test(cleaned)) {
      const m = /^DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)\s+(?:IF\s+EXISTS\s+)?([`"[\w.]+)/i.exec(
        cleaned,
      );
      if (!m?.[1]) throw new PluginSqlAccessError(pluginId, 'unable to parse DROP target');
      assertIdentifierPrefixed(pluginId, prefix, m[1], 'DROP');
      continue;
    }

    if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(cleaned)) {
      const m = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)\s+ON\s+([`"[\w.]+)/i.exec(
        cleaned,
      );
      if (!m?.[1] || !m?.[2]) {
        throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE INDEX target');
      }
      assertIdentifierPrefixed(pluginId, prefix, m[2], 'CREATE INDEX ON');
      continue;
    }

    if (/^CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\b/i.test(cleaned)) {
      const m = /^CREATE\s+(?:TEMP|TEMPORARY\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(?:INSERT|UPDATE|DELETE)(?:\s+OF\s+[^O]+)?\s+ON\s+([`"[\w.]+)/i.exec(
        cleaned,
      );
      if (!m?.[2]) {
        throw new PluginSqlAccessError(pluginId, 'unable to parse CREATE TRIGGER target table');
      }
      assertIdentifierPrefixed(pluginId, prefix, m[2], 'CREATE TRIGGER ON');
      continue;
    }

    if (/^CREATE\s+VIEW\b/i.test(cleaned)) {
      const m = /^CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.]+)/i.exec(cleaned);
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

export function createPluginDb(rawDb: unknown, pluginId: string): PluginDb {
  const client = unwrapDbClient(rawDb);
  const prefix = pluginTablePrefix(pluginId);

  const ensureClient = () => {
    if (!client || typeof (client as { prepare?: unknown }).prepare !== 'function') {
      throw new PluginSqlAccessError(pluginId, 'database binding is not available');
    }
  };

  return {
    pluginId,
    prefix,
    async query<T = Record<string, unknown>>(
      sqlText: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      ensureClient();
      assertPluginSqlAllowed(pluginId, sqlText, prefix);
      if (isD1Database(client)) {
        const res = await client.prepare(sqlText).bind(...params).all<T>();
        return res.results ?? [];
      }
      return (client as SqliteLikeDb).prepare(sqlText).all(...params) as T[];
    },

    async first<T = Record<string, unknown>>(
      sqlText: string,
      params: readonly unknown[] = [],
    ): Promise<T | null> {
      ensureClient();
      assertPluginSqlAllowed(pluginId, sqlText, prefix);
      if (isD1Database(client)) {
        return (await client.prepare(sqlText).bind(...params).first<T>()) ?? null;
      }
      return ((client as SqliteLikeDb).prepare(sqlText).get(...params) as T | undefined) ?? null;
    },

    async execute(
      sqlText: string,
      params: readonly unknown[] = [],
    ): Promise<{ changes: number; lastRowId?: number | string }> {
      ensureClient();
      assertPluginSqlAllowed(pluginId, sqlText, prefix);
      if (isD1Database(client)) {
        const res = await client.prepare(sqlText).bind(...params).run();
        return {
          changes: Number(res.meta?.changes ?? 0),
          lastRowId: res.meta?.last_row_id,
        };
      }
      const info = (client as SqliteLikeDb).prepare(sqlText).run(...params);
      return {
        changes: Number(info.changes ?? 0),
        lastRowId:
          typeof info.lastInsertRowid === 'bigint'
            ? Number(info.lastInsertRowid)
            : info.lastInsertRowid,
      };
    },

    async batch(statements: ReadonlyArray<PluginDbStatement>): Promise<void> {
      if (statements.length === 0) return;
      ensureClient();
      for (const s of statements) {
        assertPluginSqlAllowed(pluginId, s.sql, prefix);
      }
      if (isD1Database(client)) {
        const prepared: D1PreparedStatement[] = statements.map((s) =>
          client.prepare(s.sql).bind(...(s.params ?? [])),
        );
        await client.batch(prepared);
        return;
      }
      const sqlite = client as SqliteLikeDb;
      const runAll = () => {
        for (const s of statements) {
          sqlite.prepare(s.sql).run(...(s.params ?? []));
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
