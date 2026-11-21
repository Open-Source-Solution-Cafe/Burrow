#!/usr/bin/env node
/**
 * SemVer & version-parity checker for Burrow.
 *
 * Enforces:
 *   1. Valid SemVer in package.json
 *   2. Exact parity between package.json ("version") and src/core/version.ts (APP_VERSION)
 *   3. When pushing (or comparing against remote tracking branch), ensures package.json has been
 *      bumped according to the changes being pushed (major / minor / patch).
 *
 * Usage:
 *   node scripts/check-version.mjs
 *   node scripts/check-version.mjs --base <sha-or-ref> --head <sha-or-ref>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCommitsBump, parseSemver, validateVersionBump } from './version-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO_SHA = /^0+$/;

function git(args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res;
}

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefix = `${flag}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function readPackageVersionAt(ref) {
  if (!ref) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg.version;
  }
  const res = git(['show', `${ref}:package.json`], { allowFail: true });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout).version ?? null;
  } catch {
    return null;
  }
}

function readAppVersionFromDisk() {
  const versionPath = path.join(root, 'src', 'core', 'version.ts');
  if (!fs.existsSync(versionPath)) return null;
  const content = fs.readFileSync(versionPath, 'utf8');
  const match = /export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(content);
  return match ? match[1] : null;
}

function resolveDefaultBaseRef() {
  for (const candidate of ['@{u}', 'origin/master', 'origin/main']) {
    const res = git(['rev-parse', '--verify', candidate], { allowFail: true });
    if (res.status === 0) return res.stdout.trim();
  }
  return null;
}

function loadCommitsInRange(baseRef, headRef) {
  const logRes = git(
    ['log', '--format=%H%x1f%s%x1f%b%x1e', `${baseRef}..${headRef}`],
    { allowFail: true },
  );
  if (logRes.status !== 0) return [];
  const rawRecords = logRes.stdout
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean);

  return rawRecords.map((record) => {
    const [hash = '', subject = '', body = ''] = record.split('\x1f');
    const filesRes = git(['diff-tree', '--no-commit-id', '--name-status', '-r', hash], {
      allowFail: true,
    });
    const files = [];
    const addedFiles = [];
    if (filesRes.status === 0) {
      for (const line of filesRes.stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [status, ...pathParts] = line.split('\t');
        const filePath = pathParts[pathParts.length - 1];
        if (!filePath) continue;
        files.push(filePath);
        if (status?.startsWith('A')) addedFiles.push(filePath);
      }
    }
    return { hash: hash.slice(0, 7), subject, body, files, addedFiles };
  });
}

function main() {
  const pkgVersion = readPackageVersionAt(null);
  try {
    parseSemver(pkgVersion);
  } catch (err) {
    console.error(`check: version FAILED — ${err.message}`);
    process.exit(1);
  }

  const appVersion = readAppVersionFromDisk();
  if (appVersion !== pkgVersion) {
    console.error('check: version FAILED — version parity mismatch:');
    console.error(`  package.json:        ${pkgVersion}`);
    console.error(`  src/core/version.ts: ${appVersion ?? '(missing)'}`);
    console.error('  Run `pnpm run version:bump -- --set=' + pkgVersion + ' --no-changelog` to sync.');
    process.exit(1);
  }

  // Skip commit-range bump enforcement inside shallow CI checkouts unless explicit refs are passed
  const explicitBase = readArg('--base');
  const explicitHead = readArg('--head');
  if (process.env.GITHUB_ACTIONS === 'true' && !explicitBase) {
    console.log(`check: version OK (v${pkgVersion} synced across package.json and src/core/version.ts)`);
    return;
  }

  if (!fs.existsSync(path.join(root, '.git'))) {
    console.log(`check: version OK (v${pkgVersion})`);
    return;
  }

  const headRef = explicitHead && !ZERO_SHA.test(explicitHead) ? explicitHead : 'HEAD';
  let baseRef = explicitBase;
  if (!baseRef || ZERO_SHA.test(baseRef)) {
    baseRef = resolveDefaultBaseRef();
  }

  if (!baseRef) {
    console.log(`check: version OK (v${pkgVersion}; no remote tracking branch to compare)`);
    return;
  }

  const baseVersion = readPackageVersionAt(baseRef);
  if (!baseVersion) {
    console.log(`check: version OK (v${pkgVersion}; base ref has no package.json)`);
    return;
  }

  const headVersion = readPackageVersionAt(headRef) ?? pkgVersion;
  const commits = loadCommitsInRange(baseRef, headRef);
  if (commits.length === 0) {
    console.log(`check: version OK (v${pkgVersion}; no unpushed commits ahead of base)`);
    return;
  }

  const { requiredLevel, triggers } = evaluateCommitsBump(commits);
  const verdict = validateVersionBump({
    baseVersion,
    headVersion,
    requiredLevel,
  });

  if (!verdict.ok) {
    console.error('\ncheck: version FAILED — version bump required before pushing!');
    console.error(`  Base version:          ${baseVersion}`);
    console.error(`  Current version:       ${headVersion}`);
    console.error(
      `  Detected change level: ${requiredLevel.toUpperCase()} (expected >= ${verdict.expectedMinVersion})`,
    );
    if (triggers.length > 0) {
      console.error('  Triggering commits:');
      for (const t of triggers.slice(0, 8)) {
        console.error(`    - ${t.hash} [${t.level}] ${t.subject} (${t.reason})`);
      }
    }
    console.error(
      `\n  Fix: run \`pnpm run version:bump\` (or \`pnpm run version:bump -- --${requiredLevel}\`), commit the version update, and push again.`,
    );
    process.exit(1);
  }

  console.log(
    `check: version OK (v${headVersion}; base v${baseVersion}, required=${requiredLevel}, ${commits.length} commit(s) checked)`,
  );
}

main();
