#!/usr/bin/env node
/**
 * Automatically determines the required SemVer bump (major / minor / patch) from commits
 * since the last version update (or applies an explicit --major / --minor / --patch / --set=X.Y.Z),
 * updates package.json, src/core/version.ts, and rolls up CHANGELOG.md ## [Unreleased].
 *
 * Usage:
 *   pnpm run version:bump                 # Auto-detect minor/patch/major from commits
 *   pnpm run version:bump -- --patch      # Force patch bump
 *   pnpm run version:bump -- --minor      # Force minor bump
 *   pnpm run version:bump -- --major      # Force major bump
 *   pnpm run version:bump -- --set=0.3.0  # Set explicit version
 *   pnpm run version:bump -- --dry-run    # Preview without modifying files
 *   pnpm run version:bump -- --no-changelog
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bumpSemver,
  evaluateCommitsBump,
  parseSemver,
  rollUpChangelog,
} from './version-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readFlagValue(prefix) {
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function findLastVersionChangeCommit(currentVersion) {
  const res = git(['log', '-n', '100', '--format=%H', '--', 'package.json'], { allowFail: true });
  if (res.status !== 0) return null;
  const hashes = res.stdout.split(/\r?\n/).filter(Boolean);
  for (const hash of hashes) {
    const parentRes = git(['show', `${hash}^:package.json`], { allowFail: true });
    if (parentRes.status !== 0) continue;
    try {
      const parentVersion = JSON.parse(parentRes.stdout).version;
      if (parentVersion && parentVersion !== currentVersion) {
        return hash;
      }
    } catch {
      // ignore unparseable historical package.json
    }
  }
  return null;
}

function loadCommitsSince(baseRef) {
  const range = baseRef ? `${baseRef}..HEAD` : 'HEAD';
  const logRes = git(['log', '--format=%H%x1f%s%x1f%b%x1e', range], { allowFail: true });
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
  const pkgPath = path.join(root, 'package.json');
  const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  const currentVersion = pkg.version;
  parseSemver(currentVersion);

  const dryRun = hasFlag('--dry-run');
  const skipChangelog = hasFlag('--no-changelog');
  const explicitSet = readFlagValue('--set=');

  let nextVersion;
  let detectedLevel = 'explicit';
  let triggers = [];

  if (explicitSet) {
    parseSemver(explicitSet);
    nextVersion = explicitSet;
  } else if (hasFlag('--major')) {
    detectedLevel = 'major';
    nextVersion = bumpSemver(currentVersion, 'major');
  } else if (hasFlag('--minor')) {
    detectedLevel = 'minor';
    nextVersion = bumpSemver(currentVersion, 'minor');
  } else if (hasFlag('--patch')) {
    detectedLevel = 'patch';
    nextVersion = bumpSemver(currentVersion, 'patch');
  } else {
    const baseRef = findLastVersionChangeCommit(currentVersion);
    const commits = loadCommitsSince(baseRef);
    const evaluation = evaluateCommitsBump(commits);
    detectedLevel = evaluation.requiredLevel;
    triggers = evaluation.triggers;
    if (detectedLevel === 'none') {
      console.log(
        `version:bump: no major/minor/patch runtime changes detected since v${currentVersion}.`,
      );
      console.log('  Use --patch, --minor, --major, or --set=X.Y.Z to force a bump.');
      return;
    }
    nextVersion = bumpSemver(currentVersion, detectedLevel);
  }

  console.log(`Version bump (${detectedLevel}): v${currentVersion} -> v${nextVersion}`);
  if (triggers.length > 0) {
    console.log('  Detected from commits:');
    for (const t of triggers.slice(0, 10)) {
      console.log(`    - ${t.hash} [${t.level}] ${t.subject} (${t.reason})`);
    }
  }

  if (dryRun) {
    console.log('  (--dry-run: no files modified)');
    return;
  }

  // 1. Update package.json preserving indentation and trailing newline
  const updatedPkgRaw = pkgRaw.replace(
    /("version"\s*:\s*")([^"]+)(")/,
    `$1${nextVersion}$3`,
  );
  fs.writeFileSync(pkgPath, updatedPkgRaw, 'utf8');
  console.log(`  updated package.json -> ${nextVersion}`);

  // 2. Update src/core/version.ts
  const versionTsPath = path.join(root, 'src', 'core', 'version.ts');
  if (fs.existsSync(versionTsPath)) {
    fs.writeFileSync(versionTsPath, `export const APP_VERSION = '${nextVersion}';\n`, 'utf8');
    console.log(`  updated src/core/version.ts -> ${nextVersion}`);
  }

  // 3. Roll up CHANGELOG.md ## [Unreleased] if it has entries
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (!skipChangelog && fs.existsSync(changelogPath)) {
    const today = new Date().toISOString().slice(0, 10);
    const currentChangelog = fs.readFileSync(changelogPath, 'utf8');
    const rolled = rollUpChangelog(currentChangelog, nextVersion, today);
    if (rolled.updated) {
      fs.writeFileSync(changelogPath, rolled.content, 'utf8');
      console.log(`  updated CHANGELOG.md -> ## [${nextVersion}] - ${today}`);
    } else {
      console.log('  CHANGELOG.md has no [Unreleased] entries to roll up (left unchanged)');
    }
  }
}

main();
