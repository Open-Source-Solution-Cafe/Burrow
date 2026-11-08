import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_VOCABULARY = [
  'stripe',
  'billing',
  'enterprise',
  'burrow-cloud',
  'cloud.',
  'organization',
  'org_id',
  'tenant',
  'coolify',
];

export const VOCABULARY_REGEXPS = [
  { term: 'stripe', regex: /(?:\b|_|[a-z])stripe\w*/i },
  { term: 'billing', regex: /(?:\b|_|[a-z])billing\w*/i },
  { term: 'enterprise', regex: /(?:\b|_|[a-z])enterprise\w*/i },
  { term: 'burrow-cloud', regex: /burrow-cloud/i },
  { term: 'cloud.', regex: /(?:\b)cloud\./i },
  { term: 'organization', regex: /(?:\b|_|[a-z])organizat\w*/i },
  { term: 'org_id', regex: /(?:\b|_)org_id\w*/i },
  { term: 'tenant', regex: /(?:\b|_|[a-z])(?:tenant|tenancy)\w*|multitenant/i },
  { term: 'coolify', regex: /(?:\b|_|[a-z])coolify\w*/i },
];

export const DEFAULT_TARGET_DIRS = ['src', 'migrations', 'tests', 'scripts', 'docs'];

export const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.bin',
  '.exe',
]);

/**
 * Checks if a violation on a line in a file is permitted by the allowlist.
 *
 * @param {string} relativePath - Normalized path with forward slashes
 * @param {string} line - Full text of the line
 * @param {string} term - Matched vocabulary term name
 * @param {Array<{path: string, pattern: string, reason: string}>} allowList
 * @param {Set<object>} [matchedEntries] - Optional set to collect matched entries
 * @returns {boolean}
 */
export function isAllowlisted(relativePath, line, term, allowList = [], matchedEntries = null) {
  const normPath = relativePath.replace(/\\/g, '/');
  for (const entry of allowList) {
    if (!entry || !entry.path) continue;
    const entryPath = entry.path.replace(/\\/g, '/');
    if (entryPath !== normPath) continue;

    // Reason is mandatory
    if (!entry.reason || typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
      continue;
    }

    const pattern = (entry.pattern || '').trim();
    let matchesPattern = false;

    if (pattern === '*' || pattern === '.*') {
      matchesPattern = true;
    } else if (pattern.toLowerCase() === term.toLowerCase()) {
      matchesPattern = true;
    } else {
      try {
        const re = new RegExp(pattern, 'i');
        if (re.test(line) || re.test(term)) {
          matchesPattern = true;
        }
      } catch {
        if (
          line.toLowerCase().includes(pattern.toLowerCase()) ||
          term.toLowerCase() === pattern.toLowerCase()
        ) {
          matchesPattern = true;
        }
      }
    }

    if (matchesPattern) {
      if (matchedEntries) {
        matchedEntries.add(entry);
      }
      return true;
    }
  }
  return false;
}

/**
 * Finds SaaS vocabulary violations in text.
 *
 * @param {string} relativePath
 * @param {string} content
 * @param {Array<{path: string, pattern: string, reason: string}>} allowList
 * @param {Array<{term: string, regex: RegExp}>} [vocabRules]
 * @param {Set<object>} [matchedEntries]
 * @returns {Array<{file: string, line: number, column: number, term: string, snippet: string}>}
 */
export function findViolationsInText(
  relativePath,
  content,
  allowList = [],
  vocabRules = VOCABULARY_REGEXPS,
  matchedEntries = null,
) {
  const violations = [];
  const lines = content.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (const rule of vocabRules) {
      const match = rule.regex.exec(line);
      if (match) {
        if (!isAllowlisted(relativePath, line, rule.term, allowList, matchedEntries)) {
          violations.push({
            file: relativePath.replace(/\\/g, '/'),
            line: lineIndex + 1,
            column: match.index + 1,
            term: rule.term,
            snippet: line.trim(),
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Evaluates the public repository against SaaS vocabulary decoupling rules.
 *
 * @param {string} rootDir
 * @param {Array<{path: string, pattern: string, reason: string}>} allowList
 * @param {object} [options]
 * @returns {{ok: boolean, violations: Array<object>, staleAllowlist: Array<object>, filesScanned: number}}
 */
export function evaluateDecoupling(rootDir, allowList = [], options = {}) {
  const targetDirs = options.targetDirs || DEFAULT_TARGET_DIRS;
  const vocabRules = options.vocabRules || VOCABULARY_REGEXPS;
  const excludeFiles = new Set(
    (options.excludeFiles || ['scripts/decoupling-allowlist.json']).map((f) =>
      f.replace(/\\/g, '/'),
    ),
  );

  const violations = [];
  const matchedEntries = new Set();
  let filesScanned = 0;

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === '.tsbuild' ||
          entry.name === '.wrangler'
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (excludeFiles.has(relPath)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        let content;
        try {
          content = fs.readFileSync(fullPath, 'utf8');
        } catch {
          continue;
        }

        // Skip binary content
        if (content.includes('\0')) continue;

        filesScanned++;
        const fileViolations = findViolationsInText(
          relPath,
          content,
          allowList,
          vocabRules,
          matchedEntries,
        );
        violations.push(...fileViolations);
      }
    }
  }

  for (const dirName of targetDirs) {
    walk(path.join(rootDir, dirName));
  }

  const staleAllowlist = [];
  for (const entry of allowList) {
    if (!entry || !entry.path) continue;
    if (!matchedEntries.has(entry)) {
      staleAllowlist.push(entry);
    }
  }

  const ok = violations.length === 0 && (!options.failOnStale || staleAllowlist.length === 0);

  return {
    ok,
    violations,
    staleAllowlist,
    filesScanned,
  };
}

export function runCli() {
  const allowlistPath = path.join(root, 'scripts', 'decoupling-allowlist.json');
  let allowList = [];
  if (fs.existsSync(allowlistPath)) {
    try {
      allowList = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
    } catch (err) {
      console.error(`check: decoupling FAILED to parse ${allowlistPath}: ${err.message}`);
      process.exit(1);
    }
  }

  const result = evaluateDecoupling(root, allowList);

  if (!result.ok) {
    console.error('\n❌ DECOUPLING CHECK FAILED: Found SaaS vocabulary in public repository\n');
    console.error(`Violations (${result.violations.length}):`);
    for (const v of result.violations) {
      console.error(`  - ${v.file}:${v.line}:${v.column} [term: "${v.term}"]`);
      console.error(`    ${v.snippet}`);
    }
    console.error(
      '\nIf this is an allowable generic usage, add a reasoned entry to scripts/decoupling-allowlist.json.\n',
    );
    process.exit(1);
  }

  if (result.staleAllowlist.length > 0) {
    console.warn(
      `check: decoupling warning: ${result.staleAllowlist.length} unused allowlist entries:`,
    );
    for (const s of result.staleAllowlist) {
      console.warn(`  - ${s.path} (pattern: "${s.pattern}")`);
    }
  }

  console.log(
    `check: decoupling OK (${result.filesScanned} files scanned, 0 violations, ${allowList.length} allowlisted)`,
  );
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isDirectRun) {
  runCli();
}
