#!/usr/bin/env node
import path from 'node:path';
import {
  executeDatabaseFile,
  getDatabaseTarget,
  migrateDatabase,
  printTargetBanner,
  root,
  run,
} from './lib.mjs';

/**
 * Seed the local Node database; --worker explicitly selects local Worker/D1.
 */
const target = getDatabaseTarget();
if (target.kind === 'remote') {
  console.error('\n❌ ERROR: Seeding is only permitted on local databases.');
  console.error('To populate production, log in to the web app and use the UI.\n');
  process.exit(1);
}

printTargetBanner('Seed Database', target);

const sqlFile = path.join(root, 'scripts', 'seed.sql');

await migrateDatabase(target);
await executeDatabaseFile(target, sqlFile);

console.log('Seed data inserted successfully. Verifying invariants...');
run(process.execPath, [
  path.join(root, 'scripts', 'check-data.mjs'),
  ...(target.kind === 'worker' ? ['--worker'] : []),
]);

console.log('seed OK — database seeded and all invariants hold.');
