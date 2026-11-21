#!/usr/bin/env node
/**
 * Configures Git to use the versioned .githooks/ directory for pre-push CI parity checks.
 * Automatically invoked via `prepare` on local installs; safe no-op in CI and non-git environments.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true') {
  process.exit(0);
}

if (!fs.existsSync(path.join(root, '.git'))) {
  process.exit(0);
}

const hooksDir = path.join(root, '.githooks');
if (!fs.existsSync(hooksDir)) {
  process.exit(0);
}

if (process.platform !== 'win32') {
  for (const entry of fs.readdirSync(hooksDir)) {
    const full = path.join(hooksDir, entry);
    if (fs.statSync(full).isFile()) {
      try {
        fs.chmodSync(full, 0o755);
      } catch {
        // Ignore chmod errors on non-POSIX filesystems
      }
    }
  }
}

const res = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
});

if (res.status !== 0) {
  console.warn(`⚠️  Could not configure git core.hooksPath: ${(res.stderr || '').trim()}`);
  process.exit(0);
}

console.log('git hooks installed (core.hooksPath = .githooks)');
