#!/usr/bin/env node
/**
 * Safely sync a self-hosted or one-click Cloudflare clone with upstream Burrow
 * while preserving the user's custom wrangler.jsonc bindings and package.json name.
 *
 * Usage:
 *   pnpm run sync:upstream
 *   node scripts/sync-upstream.mjs --upstream=https://github.com/Open-Source-Solution-Cafe/Burrow.git --branch=master
 *   node scripts/sync-upstream.mjs --no-commit
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_UPSTREAM_URL = 'https://github.com/Open-Source-Solution-Cafe/Burrow.git';
const DEFAULT_UPSTREAM_BRANCH = 'master';

function parseJsonc(raw) {
  let out = '';
  let inString = false;
  let escapeNext = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      } else if (ch === '\n') {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
    } else {
      out += ch;
    }
  }
  const withoutTrailingCommas = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas);
}

export function mergePreservedPackageName(upstreamPkgRaw, previousPkgName) {
  if (!previousPkgName || previousPkgName === 'burrow') {
    return upstreamPkgRaw;
  }
  return upstreamPkgRaw.replace(/("name"\s*:\s*")([^"]+)(")/, `$1${previousPkgName}$3`);
}

export function mergePreservedWranglerConfig(upstreamWranglerRaw, previousWranglerRaw) {
  if (!previousWranglerRaw) return upstreamWranglerRaw;
  try {
    const prev = parseJsonc(previousWranglerRaw);
    const next = parseJsonc(upstreamWranglerRaw);
    const merged = { ...next };
    if (prev.name) merged.name = prev.name;
    if (Array.isArray(prev.d1_databases) && prev.d1_databases.length > 0) {
      merged.d1_databases = prev.d1_databases;
    }
    if (Array.isArray(prev.r2_buckets) && prev.r2_buckets.length > 0) {
      merged.r2_buckets = prev.r2_buckets;
    }
    if (prev.routes) merged.routes = prev.routes;
    if (prev.triggers) merged.triggers = prev.triggers;
    if (prev.vars) merged.vars = { ...(next.vars ?? {}), ...prev.vars };
    return JSON.stringify(merged, null, 2) + '\n';
  } catch {
    // Fall back to preserving the user's original wrangler.jsonc verbatim if JSONC parse fails.
    return previousWranglerRaw;
  }
}

function readArgValue(args, prefix, fallback) {
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function runGit(args, { cwd = root, allowFail = false } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed:\n${(res.stderr || res.stdout || '').trim()}`);
  }
  return res;
}

export function syncUpstreamRepo({
  cwd = root,
  upstreamUrl = DEFAULT_UPSTREAM_URL,
  upstreamBranch = DEFAULT_UPSTREAM_BRANCH,
  noCommit = false,
} = {}) {
  const wranglerPath = path.join(cwd, 'wrangler.jsonc');
  const pkgPath = path.join(cwd, 'package.json');

  const previousWranglerRaw = fs.existsSync(wranglerPath)
    ? fs.readFileSync(wranglerPath, 'utf8')
    : null;
  const previousPkgName = fs.existsSync(pkgPath)
    ? (JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name ?? null)
    : null;

  console.log(`==> Fetching upstream ${upstreamUrl} (${upstreamBranch})`);
  runGit(['fetch', upstreamUrl, upstreamBranch], { cwd });

  const upstreamHead = runGit(['rev-parse', 'FETCH_HEAD'], { cwd }).stdout.trim();
  const localHead = runGit(['rev-parse', 'HEAD'], { cwd }).stdout.trim();
  if (upstreamHead === localHead) {
    console.log('Already up to date with upstream Burrow.');
    return { updated: false, version: null };
  }

  console.log('==> Merging upstream changes (preserving custom wrangler.jsonc & package name)');
  const mergeRes = runGit(
    ['merge', '-X', 'theirs', '--allow-unrelated-histories', '--no-commit', '--no-ff', 'FETCH_HEAD'],
    { cwd, allowFail: true },
  );

  // Resolve any add/add or modify/delete conflicts in favor of upstream FETCH_HEAD.
  if (mergeRes.status !== 0) {
    const unmerged = runGit(['diff', '--name-only', '--diff-filter=U'], { cwd }).stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const file of unmerged) {
      const checkout = runGit(['checkout', '--theirs', '--', file], { cwd, allowFail: true });
      if (checkout.status === 0) {
        runGit(['add', '--', file], { cwd });
      } else {
        runGit(['rm', '-f', '--', file], { cwd, allowFail: true });
      }
    }
  }

  if (previousWranglerRaw && fs.existsSync(wranglerPath)) {
    const upstreamWranglerRaw = fs.readFileSync(wranglerPath, 'utf8');
    const mergedWrangler = mergePreservedWranglerConfig(upstreamWranglerRaw, previousWranglerRaw);
    fs.writeFileSync(wranglerPath, mergedWrangler, 'utf8');
  }

  if (previousPkgName && fs.existsSync(pkgPath)) {
    const upstreamPkgRaw = fs.readFileSync(pkgPath, 'utf8');
    const mergedPkg = mergePreservedPackageName(upstreamPkgRaw, previousPkgName);
    fs.writeFileSync(pkgPath, mergedPkg, 'utf8');
  }

  runGit(['add', '-A'], { cwd });
  const staged = runGit(['diff', '--cached', '--name-only'], { cwd }).stdout.trim();
  if (!staged) {
    runGit(['merge', '--abort'], { cwd, allowFail: true });
    console.log('No file changes needed — already up to date with upstream Burrow.');
    return { updated: false, version: null };
  }

  const nextVersion = fs.existsSync(pkgPath)
    ? (JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? 'latest')
    : 'latest';

  if (!noCommit) {
    runGit(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', `chore: upgrade Burrow to v${nextVersion}`], { cwd });
    console.log(`✅ Committed upstream upgrade to v${nextVersion}.`);
  } else {
    console.log(`✅ Staged upstream upgrade to v${nextVersion} (--no-commit).`);
  }

  return { updated: true, version: nextVersion };
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const upstreamUrl = readArgValue(args, '--upstream=', process.env.BURROW_UPSTREAM_URL || DEFAULT_UPSTREAM_URL);
  const upstreamBranch = readArgValue(
    args,
    '--branch=',
    process.env.BURROW_UPSTREAM_BRANCH || DEFAULT_UPSTREAM_BRANCH,
  );
  const noCommit = args.includes('--no-commit');
  syncUpstreamRepo({ upstreamUrl, upstreamBranch, noCommit });
}
