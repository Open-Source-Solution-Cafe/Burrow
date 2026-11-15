#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareStorageInventory } from '../src/core/adapters/storage/inventory.ts';
import { createStorageFromEnv } from '../src/core/adapters/storage/factory.ts';
import { loadEnv } from '../src/server/env.ts';
import { selectDatabaseTarget } from '../src/server/database-target.ts';
import {
  bin,
  getWranglerConfigArgs,
  parseCliArgs,
  parseFirstJson,
  parseJsonc,
  resolveRemoteProfile,
  root,
  run,
} from './lib.mjs';

export function resolveInventoryTarget({
  args = process.argv.slice(2),
  env = process.env,
  rootDir = root,
} = {}) {
  parseCliArgs(args);
  const postgresUrl = env.DATABASE_URL;
  const isPostgres = /^postgres(ql)?:\/\//.test(postgresUrl ?? '');
  const explicitlySelectsD1 = args.some((arg) =>
    ['--remote', '--r', '-r', '--worker', '--staging', '--demo'].includes(arg),
  );
  const target = explicitlySelectsD1
    ? selectDatabaseTarget(args, { ...env, DATABASE_URL: undefined }, rootDir)
    : isPostgres
      ? { kind: 'postgres', url: postgresUrl }
      : selectDatabaseTarget(args, env, rootDir);
  if (target.kind === 'remote') {
    const baseCfg = parseJsonc(fs.readFileSync(path.join(rootDir, 'wrangler.jsonc'), 'utf8'));
    const profile = resolveRemoteProfile(baseCfg, { args, env });
    return { target, profile, databaseName: profile.dbName };
  }
  return {
    target,
    profile: null,
    databaseName: target.kind === 'worker' ? 'burrow' : null,
  };
}

export function resolveInventoryD1Execution({
  args = process.argv.slice(2),
  env = process.env,
  rootDir = root,
  getConfigArgs = getWranglerConfigArgs,
} = {}) {
  const { target, profile, databaseName } = resolveInventoryTarget({ args, env, rootDir });
  if (target.kind === 'remote') {
    const d1Args = [
      ...getConfigArgs({ required: true, purpose: 'read-only storage inventory', profile }),
      '--remote',
    ];
    return { target, profile, databaseName, d1Args };
  }
  if (target.kind === 'worker') {
    return {
      target,
      profile: null,
      databaseName: 'burrow',
      d1Args: ['--local', '--persist-to', target.persistTo],
    };
  }
  return { target, profile: null, databaseName: null, d1Args: [] };
}

async function listRegisteredKeys(target, profile, databaseName) {
  if (target.kind === 'node') {
    const { default: Database } = await import('better-sqlite3');
    const { drizzle } = await import('drizzle-orm/better-sqlite3');
    const schema = await import('../src/core/adapters/db/d1/schema.ts');
    const { createProjectFileRepository } = await import(
      '../src/core/adapters/db/d1/repositories/project-file.ts'
    );
    const db = new Database(target.sqlitePath, { readonly: true, fileMustExist: true });
    try {
      return await createProjectFileRepository(drizzle(db, { schema })).listAllStorageKeys();
    } finally {
      db.close();
    }
  }

  if (target.kind === 'postgres') {
    const postgres = (await import('postgres')).default;
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { PostgresProjectFileRepository } = await import(
      '../src/core/adapters/db/postgres/repositories/project-file.ts'
    );
    const { schema } = await import('../src/core/adapters/db/postgres/schema.ts');
    const client = postgres(target.url, { max: 1, connect_timeout: 10 });
    try {
      return await new PostgresProjectFileRepository(drizzle(client, { schema })).listAllStorageKeys();
    } finally {
      await client.end();
    }
  }

  const sqlFile = path.join(os.tmpdir(), `burrow-storage-inventory-${process.pid}.sql`);
  fs.writeFileSync(
    sqlFile,
    'SELECT DISTINCT storage_key FROM project_files ORDER BY storage_key COLLATE BINARY;\n',
    'utf8',
  );
  try {
    const d1Args =
      target.kind === 'remote'
        ? [
            ...getWranglerConfigArgs({
              required: true,
              purpose: 'read-only storage inventory',
              profile,
            }),
            '--remote',
          ]
        : ['--local', '--persist-to', target.persistTo];
    const result = run(
      bin('wrangler'),
      ['d1', 'execute', databaseName, ...d1Args, '--file', sqlFile, '--json'],
      { capture: true, quiet: true, allowFail: true, env: { CI: '1' } },
    );
    if (result.status !== 0) throw new Error(result.stderr || 'Wrangler D1 inventory query failed');
    const parsed = parseFirstJson(result.stdout);
    if (!parsed) throw new Error('Could not parse Wrangler D1 query output');
    const resultSets = Array.isArray(parsed) ? parsed : [parsed];
    return resultSets.flatMap((set) => set.results ?? set.result?.results ?? []).map((row) => row.storage_key);
  } finally {
    fs.rmSync(sqlFile, { force: true });
  }
}

async function main() {
  loadEnv({ rootDir: root });
  const { target, profile, databaseName } = resolveInventoryTarget({
    args: process.argv.slice(2),
    env: process.env,
    rootDir: root,
  });

  console.log('======================================================');
  console.log('ACTION: READ-ONLY STORAGE INVENTORY');
  console.log(
    `TARGET: ${
      target.kind === 'node'
        ? `LOCAL SQLite (${target.sqlitePath})`
        : target.kind === 'worker'
          ? `LOCAL Worker/D1 (${target.persistTo})`
          : target.kind === 'remote'
            ? `REMOTE Cloudflare ${profile.isStaging ? 'Staging' : profile.isDemo ? 'Demo' : 'Production'} D1 (${profile.dbName})`
            : 'PostgreSQL DATABASE_URL'
    }`,
  );
  console.log('======================================================\n');

  const hasS3Config = Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET);
  if ((target.kind === 'worker' || target.kind === 'remote') && !hasS3Config) {
    throw new Error(
      'D1 inventory requires S3-compatible object-store credentials in S3_ENDPOINT and S3_BUCKET; R2 bindings are only available inside the Worker.',
    );
  }

  const storageEnv = { ...process.env };
  if (target.kind === 'worker' || target.kind === 'remote') {
    // Avoid silently inspecting ./data/uploads when the D1 deployment uses R2.
    storageEnv.LOCAL_STORAGE_PATH = undefined;
  }
  const storage = createStorageFromEnv(storageEnv);
  const [registeredKeys, storedKeys] = await Promise.all([
    listRegisteredKeys(target, profile, databaseName),
    storage.listObjects(),
  ]);
  const report = compareStorageInventory(registeredKeys, storedKeys);

  console.log(`Registered keys: ${new Set(registeredKeys).size}`);
  console.log(`Stored objects: ${new Set(storedKeys).size}`);
  console.log(`Missing registered objects: ${report.missingObjects.length}`);
  for (const key of report.missingObjects) console.log(`  MISSING ${key}`);
  console.log(`Unregistered stored objects: ${report.unregisteredObjects.length}`);
  for (const key of report.unregisteredObjects) console.log(`  UNREGISTERED ${key}`);

  if (report.missingObjects.length || report.unregisteredObjects.length) process.exitCode = 1;
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectExecution) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
