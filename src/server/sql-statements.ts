/** Split read-only invariant SQL into statements while discarding SQL line comments. */
export function splitSqlStatements(source: string): string[] {
  return source
    .replace(/^\s*--[^\n]*/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}
