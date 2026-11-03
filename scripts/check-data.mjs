#!/usr/bin/env node
import path from 'node:path';
import { loadEnv } from '../src/server/env.ts';
import { executeDatabaseFile, getDatabaseTarget, printTargetBanner, root } from './lib.mjs';

/**
 * Run the canonical invariant queries against the selected database.
 *
 * Targets:
 *   (default)              Local Node SQLite database
 *   --worker               Local Worker/D1 persisted under ./data
 *   --remote, --r, -r      Remote Cloudflare D1 database
 */
const postgresSelected = process.argv.slice(2).includes('--postgres');
let target;
if (postgresSelected) {
  if (process.argv.slice(2).some((arg) => ['--remote', '--worker'].includes(arg))) {
    throw new Error('Cannot combine --postgres with --remote or --worker');
  }
  loadEnv({ rootDir: root });
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('Set DATABASE_URL to a PostgreSQL connection URL before running --postgres');
  }
  target = { kind: 'postgres', url };
} else {
  target = getDatabaseTarget();
}
printTargetBanner('Check Data Invariants', target);

const invariantFile = target.kind === 'postgres'
  ? 'check-invariants.postgres.sql'
  : 'check-invariants.sql';
const sqlFile = path.join(root, 'scripts', invariantFile);
const resultSets = await executeDatabaseFile(target, sqlFile, { readOnly: true });
const offenders = [];
let queryIndex = 0;
for (const rs of resultSets) {
  queryIndex++;
  const rows = rs?.results ?? rs?.rows ?? [];
  for (const row of rows) offenders.push(row);
}

if (offenders.length > 0) {
  console.error(`check:data FAILED — ${offenders.length} offending row(s):`);
  for (const row of offenders) console.error(`  ${JSON.stringify(row)}`);
  process.exit(1);
}

console.log(`check:data OK — all invariants hold (${queryIndex} queries, ${target.kind})`);
