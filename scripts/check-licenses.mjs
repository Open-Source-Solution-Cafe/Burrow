import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Checks whether an atomic license token is permitted under Burrow policy.
 * Permitted: LGPL-*, MPL-*, Apache-*, MIT, BSD-*, ISC, 0BSD, BlueOak-*, CC0-*, Unlicense, WTFPL.
 * Denied: AGPL-*, GPL-* (except LGPL), SSPL-*, UNKNOWN, UNLICENSED, SEE LICENSE IN..., or unapproved.
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isPermittedToken(token) {
  if (!token || typeof token !== 'string') return false;
  const t = token.trim();
  if (!t) return false;

  // Explicit forbidden patterns
  if (/UNKNOWN/i.test(t)) return false;
  if (/SEE LICENSE IN/i.test(t)) return false;
  if (/UNLICENSED/i.test(t)) return false;
  if (/^AGPL/i.test(t)) return false;
  if (/^SSPL/i.test(t)) return false;

  // LGPL is permitted; standard GPL is forbidden
  if (/^LGPL/i.test(t)) return true;
  if (/^GPL/i.test(t) || /^GNU General Public License/i.test(t)) return false;

  // Permitted permissive and weak-copyleft licenses
  if (/^MIT$/i.test(t)) return true;
  if (/^ISC$/i.test(t)) return true;
  if (/^0BSD$/i.test(t)) return true;
  if (/^BlueOak(-.*)?$/i.test(t)) return true;
  if (/^CC0(-.*)?$/i.test(t)) return true;
  if (/^Unlicense$/i.test(t)) return true;
  if (/^WTFPL$/i.test(t)) return true;
  if (/^BSD(-.*)?$/i.test(t)) return true;
  if (/^Apache(-.*)?$/i.test(t)) return true;
  if (/^MPL(-.*)?$/i.test(t)) return true;
  if (/^CC-BY(-.*)?$/i.test(t)) return true;
  if (/^(Zlib|Python-2\.0)$/i.test(t)) return true;

  return false;
}

/**
 * Tokenizes an SPDX license expression into parentheses, operators, and license identifiers.
 *
 * @param {string} expression
 * @returns {string[]}
 */
export function tokenizeSpdx(expression) {
  if (!expression || typeof expression !== 'string') return [];
  const raw = expression.trim();
  if (!raw) return [];
  return raw
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["'`]|["'`,]$/g, ''))
    .filter(Boolean);
}

/**
 * Evaluates an SPDX license expression according to boolean precedence:
 * - OR expressions pass if ANY alternative is permissive (e.g. `(MIT OR GPL-3.0)`)
 * - AND expressions fail if ANY part is denied (e.g. `(MIT AND GPL-3.0)`)
 * - Parentheses override grouping
 *
 * @param {string} expression
 * @returns {boolean}
 */
export function isLicensePermitted(expression) {
  if (!expression || typeof expression !== 'string') return false;
  const raw = expression.trim();
  if (!raw) return false;

  if (/UNKNOWN/i.test(raw)) return false;
  if (/SEE LICENSE IN/i.test(raw)) return false;
  if (/UNLICENSED/i.test(raw)) return false;

  const tokens = tokenizeSpdx(raw);
  if (tokens.length === 0) return false;

  let pos = 0;

  function peek() {
    return tokens[pos];
  }

  function consume() {
    const t = tokens[pos];
    pos++;
    return t;
  }

  function parseOr() {
    let result = parseAnd();
    while (pos < tokens.length && peek()?.toUpperCase() === 'OR') {
      consume();
      const right = parseAnd();
      result = result || right;
    }
    return result;
  }

  function parseAnd() {
    let result = parsePrimary();
    while (pos < tokens.length && peek()?.toUpperCase() === 'AND') {
      consume();
      const right = parsePrimary();
      result = result && right;
    }
    return result;
  }

  function parsePrimary() {
    if (pos >= tokens.length) return false;
    const token = peek();
    if (token === '(') {
      consume(); // consume '('
      const inner = parseOr();
      if (peek() === ')') {
        consume(); // consume ')'
      }
      return inner;
    }

    const lic = consume();
    if (pos < tokens.length && peek()?.toUpperCase() === 'WITH') {
      consume(); // consume 'WITH'
      if (pos < tokens.length) {
        consume(); // consume exception identifier
      }
    }
    return isPermittedToken(lic);
  }

  try {
    const res = parseOr();
    return Boolean(res);
  } catch {
    return false;
  }
}

/**
 * Flattens either raw `pnpm licenses list --json` output or an array of package objects
 * into a uniform list of `{ name, version, license }`.
 *
 * @param {any} input
 * @returns {Array<{ name: string, version: string, license: string }>}
 */
export function normalizePackages(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    const list = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.versions)) {
        for (const v of item.versions) {
          list.push({
            name: item.name || '',
            version: String(v),
            license: item.license || 'UNKNOWN',
          });
        }
      } else {
        list.push({
          name: item.name || '',
          version: String(item.version || '0.0.0'),
          license: item.license || 'UNKNOWN',
        });
      }
    }
    return list;
  }
  if (typeof input === 'object') {
    const list = [];
    for (const [licenseKey, pkgs] of Object.entries(input)) {
      if (Array.isArray(pkgs)) {
        for (const pkg of pkgs) {
          if (!pkg || typeof pkg !== 'object') continue;
          const lic = pkg.license || licenseKey;
          const versions = Array.isArray(pkg.versions)
            ? pkg.versions
            : [pkg.version || '0.0.0'];
          for (const v of versions) {
            list.push({
              name: pkg.name || '',
              version: String(v),
              license: lic,
            });
          }
        }
      }
    }
    return list;
  }
  return [];
}

/**
 * Evaluates dependency licenses against Burrow policies and the explicit allowlist.
 *
 * @param {any} packages Raw `pnpm licenses list --json` object or package array
 * @param {Array<{ name: string, version: string, license?: string, reason?: string, reviewDate?: string }>} [allowList=[]]
 * @returns {{
 *   ok: boolean,
 *   violations: Array<{ name: string, version: string, license: string, reason: string }>,
 *   staleAllowlist: Array<{ name: string, version: string, license?: string, reason?: string, reviewDate?: string }>,
 *   totalPackages: number,
 *   allowedCount: number
 * }}
 */
export function evaluateLicenses(packages, allowList = []) {
  const normalizedPkgs = normalizePackages(packages);
  const allowListArray = Array.isArray(allowList) ? allowList : [];

  const violations = [];
  const matchedAllowlistIndices = new Set();
  let allowedCount = 0;

  for (const pkg of normalizedPkgs) {
    if (isLicensePermitted(pkg.license)) {
      allowedCount++;
      continue;
    }

    // Check allowlist for explicit exception
    let matchedIndex = -1;
    for (let i = 0; i < allowListArray.length; i++) {
      const entry = allowListArray[i];
      if (!entry || typeof entry !== 'object') continue;
      const nameMatch = entry.name === pkg.name;
      const versionMatch =
        !entry.version || entry.version === '*' || entry.version === pkg.version;
      const licenseMatch =
        !entry.license || entry.license.toLowerCase() === pkg.license.toLowerCase();
      if (nameMatch && versionMatch && licenseMatch) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex !== -1) {
      matchedAllowlistIndices.add(matchedIndex);
      allowedCount++;
    } else {
      violations.push({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license,
        reason: `License "${pkg.license}" is forbidden or not permitted without an allowlist entry`,
      });
    }
  }

  // Detect stale allowlist entries: entries that are no longer installed
  const staleAllowlist = [];
  for (let i = 0; i < allowListArray.length; i++) {
    const entry = allowListArray[i];
    if (!entry || typeof entry !== 'object') continue;
    const isInstalled = normalizedPkgs.some(
      (pkg) =>
        pkg.name === entry.name &&
        (!entry.version || entry.version === '*' || pkg.version === entry.version) &&
        (!entry.license || pkg.license.toLowerCase() === entry.license.toLowerCase()),
    );
    if (!isInstalled) {
      staleAllowlist.push(entry);
    }
  }

  const ok = violations.length === 0 && staleAllowlist.length === 0;

  return {
    ok,
    violations,
    staleAllowlist,
    totalPackages: normalizedPkgs.length,
    allowedCount,
  };
}

export function runCli() {
  const res = spawnSync('pnpm', ['licenses', 'list', '--json'], {
    shell: process.platform === 'win32',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.error) {
    console.error(`check: licenses FAILED to run pnpm: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`check: licenses FAILED: pnpm licenses list exited with code ${res.status}`);
    process.exit(res.status || 1);
  }

  let packagesData;
  try {
    packagesData = JSON.parse(res.stdout);
  } catch (err) {
    console.error(`check: licenses FAILED to parse pnpm output: ${err.message}`);
    process.exit(1);
  }

  const scriptAllowlist = path.join(root, 'scripts', 'license-allowlist.json');
  const rootAllowlist = path.join(root, 'license-allowlist.json');
  const allowlistPath = fs.existsSync(scriptAllowlist) ? scriptAllowlist : rootAllowlist;
  let allowList = [];
  if (fs.existsSync(allowlistPath)) {
    try {
      allowList = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    } catch (err) {
      console.error(`check: licenses FAILED to parse ${allowlistPath}: ${err.message}`);
      process.exit(1);
    }
  }

  const result = evaluateLicenses(packagesData, allowList);

  if (!result.ok) {
    console.error('\n❌ LICENSE CHECK FAILED\n');
    if (result.violations.length > 0) {
      console.error(`Violations (${result.violations.length}):`);
      for (const v of result.violations) {
        console.error(`  - ${v.name}@${v.version} [${v.license}]: ${v.reason}`);
      }
    }
    if (result.staleAllowlist.length > 0) {
      console.error(`\nStale Allowlist Entries (${result.staleAllowlist.length}):`);
      for (const s of result.staleAllowlist) {
        console.error(
          `  - ${s.name}@${s.version} [${s.license || 'any'}] is in license-allowlist.json but not installed`,
        );
      }
    }
    process.exit(1);
  }

  console.log(
    `check: licenses OK (${result.totalPackages} packages scanned, 0 violations, ${allowList.length} allowlisted)`,
  );
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectRun) {
  runCli();
}
