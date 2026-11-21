#!/usr/bin/env node
/**
 * Regenerates src/worker/d1-migrations.ts from migrations/*.sql using canonical LF line endings.
 * Run with: pnpm run db:sync-d1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(root, 'src', 'worker', 'd1-migrations.ts');

export function buildD1MigrationsSource(repoRoot = root) {
  const dir = path.join(repoRoot, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const entries = files.map((name) => ({
    name,
    sql: fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
  }));
  return (
    '/** Auto-synced from migrations/*.sql for zero-config Worker D1 initialization. */\n' +
    'export const D1_MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = ' +
    JSON.stringify(entries, null, 2) +
    ';\n'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = buildD1MigrationsSource(root);
  fs.writeFileSync(outPath, source, 'utf8');
  console.log(`db:sync-d1 OK (${path.relative(root, outPath)} updated with canonical LF endings)`);
}
