#!/usr/bin/env node
/**
 * Full CI-parity pre-push gate (mirrors .github/workflows/ci.yml locally).
 * Runs automatically via .githooks/pre-push or manually via `pnpm run check:ci`.
 *
 * Set SKIP_PRE_PUSH=1 only for explicit emergency bypasses.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.SKIP_PRE_PUSH === '1') {
  console.warn('⚠️  SKIP_PRE_PUSH=1 set: bypassing pre-push CI parity checks.');
  process.exit(0);
}

const startedAt = Date.now();
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const env = { ...process.env };
// Never silently skip PostgreSQL or Worker tests during pre-push verification.
delete env.BURROW_TEST_SQLITE_ONLY;

function runStep(label, cmd, args, { shell = false } = {}) {
  console.log(`\n==> [pre-push] ${label}`);
  const res = spawnSync(cmd, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell,
    windowsHide: true,
  });
  if (res.error) {
    console.error(`❌ [pre-push] Failed to start "${label}": ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`\n❌ [pre-push] Push blocked: "${label}" failed (exit ${res.status}).`);
    console.error('   Fix the failure above before pushing, or re-run with `pnpm run check:ci`.');
    process.exit(res.status ?? 1);
  }
}

runStep('Sync, line-ending, migration & lockfile parity', process.execPath, [
  path.join(root, 'scripts', 'check-sync.mjs'),
]);
runStep('Build production bundles (Vite + Node server)', pnpmCmd, ['run', 'build'], {
  shell: process.platform === 'win32',
});
runStep('Verify architecture (check-basalt)', process.execPath, [
  path.join(root, 'scripts', 'check-basalt.mjs'),
]);
runStep('Verify public/private decoupling (check-decoupling)', process.execPath, [
  path.join(root, 'scripts', 'check-decoupling.mjs'),
]);
runStep('Verify dependency licenses (check-licenses)', process.execPath, [
  path.join(root, 'scripts', 'check-licenses.mjs'),
]);
runStep('Typecheck (tsc -b)', pnpmCmd, ['exec', 'tsc', '-b'], {
  shell: process.platform === 'win32',
});
runStep('Zero-warning lint (eslint --max-warnings=0 .)', pnpmCmd, [
  'exec',
  'eslint',
  '--max-warnings=0',
  '.',
], {
  shell: process.platform === 'win32',
});
runStep('Full test suite (Unit + SQLite + PostgreSQL 17 + Worker)', pnpmCmd, [
  'exec',
  'vitest',
  'run',
], {
  shell: process.platform === 'win32',
});

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n✅ [pre-push] All CI parity checks passed in ${elapsedSec}s.`);
