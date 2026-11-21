#!/usr/bin/env node
/**
 * Cross-platform sync & parity guard to catch CI mismatches before pushing:
 *   1. Embedded Worker D1_MIGRATIONS byte-for-byte parity (LF-only) with migrations/*.sql
 *   2. 1:1 filename parity between SQLite (migrations/*.sql) and PostgreSQL (migrations/postgres/*.sql)
 *   3. Git index LF hygiene (catches accidental CRLF committed on Windows) + LF hook files
 *   4. Lockfile consistency (pnpm-lock.yaml <-> package.json) via offline --frozen-lockfile check
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildD1MigrationsSource } from './sync-d1-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function checkD1MigrationsSync() {
  const d1Path = path.join(root, 'src', 'worker', 'd1-migrations.ts');
  if (!fs.existsSync(d1Path)) {
    failures.push('Missing src/worker/d1-migrations.ts. Run "pnpm run db:sync-d1".');
    return;
  }
  const actual = fs.readFileSync(d1Path, 'utf8');
  if (actual.includes('\r') || actual.includes('\\r')) {
    failures.push(
      'src/worker/d1-migrations.ts contains CR (\\r) line endings. Run "pnpm run db:sync-d1" to normalize to LF.',
    );
    return;
  }
  const expected = buildD1MigrationsSource(root);
  if (actual !== expected) {
    failures.push(
      'src/worker/d1-migrations.ts is out of sync with migrations/*.sql. Run "pnpm run db:sync-d1".',
    );
  }
}

function checkMigrationDialectParity() {
  const sqliteDir = path.join(root, 'migrations');
  const pgDir = path.join(root, 'migrations', 'postgres');
  const sqliteFiles = fs
    .readdirSync(sqliteDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const pgFiles = fs
    .readdirSync(pgDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const missingInPg = sqliteFiles.filter((name) => !pgFiles.includes(name));
  const missingInSqlite = pgFiles.filter((name) => !sqliteFiles.includes(name));

  if (missingInPg.length > 0) {
    failures.push(
      `SQLite migrations missing PostgreSQL counterpart in migrations/postgres/: ${missingInPg.join(', ')}`,
    );
  }
  if (missingInSqlite.length > 0) {
    failures.push(
      `PostgreSQL migrations missing SQLite counterpart in migrations/: ${missingInSqlite.join(', ')}`,
    );
  }
}

function checkLineEndings() {
  const hooksDir = path.join(root, '.githooks');
  if (fs.existsSync(hooksDir)) {
    for (const entry of fs.readdirSync(hooksDir)) {
      const full = path.join(hooksDir, entry);
      if (!fs.statSync(full).isFile()) continue;
      if (fs.readFileSync(full, 'utf8').includes('\r')) {
        failures.push(`.githooks/${entry} contains CRLF line endings; convert to LF.`);
      }
    }
  }

  if (!fs.existsSync(path.join(root, '.git'))) return;
  const res = spawnSync('git', ['ls-files', '--eol'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0) return;

  const crlfInIndex = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.includes('i/crlf') && line.includes('eol=lf')) {
      const tabIdx = line.indexOf('\t');
      crlfInIndex.push(tabIdx >= 0 ? line.slice(tabIdx + 1).trim() : line.trim());
    }
  }
  if (crlfInIndex.length > 0) {
    failures.push(
      `Tracked LF files have CRLF in git index (run "git add --renormalize ."): ${crlfInIndex.slice(0, 10).join(', ')}`,
    );
  }
}

function checkLockfileParity() {
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.SKIP_LOCKFILE_CHECK === '1') {
    return;
  }
  const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const res = spawnSync(
    pnpmCmd,
    ['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts', '--offline'],
    {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      windowsHide: true,
    },
  );
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-5).join('\n  ');
    failures.push(
      `pnpm-lock.yaml does not match package.json (--frozen-lockfile failed). Run "pnpm install" and commit pnpm-lock.yaml.\n  ${detail}`,
    );
  }
}

checkD1MigrationsSync();
checkMigrationDialectParity();
checkLineEndings();
checkLockfileParity();

if (failures.length > 0) {
  console.error('check: sync FAILED');
  for (const msg of failures) console.error(`  - ${msg}`);
  process.exit(1);
}

console.log('check: sync OK (D1 migrations, SQLite/Postgres parity, LF hygiene, lockfile)');
