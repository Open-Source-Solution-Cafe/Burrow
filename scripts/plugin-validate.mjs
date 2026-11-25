#!/usr/bin/env node
/**
 * Burrow Plugin Validator (Phase A+ & Part C)
 *
 * Offline-capable validation tool for Burrow plugins (first-party or community registry).
 * Checks:
 *   1. package.json metadata, license compliance, pinned dependencies, lockfile presence,
 *      blocked lifecycle scripts (preinstall/install/postinstall/prepare), and dependency
 *      vulnerability advisories (built-in offline database + optional `pnpm audit`).
 *   2. Static security analysis via @burrow/eslint-plugin (no eval, innerHTML without sanitizer,
 *      raw fetch, process.env, string-built SQL, child_process/vm, or unvalidated routes).
 *   3. Plugin manifest structure, network allowlist, configKeys, and migration SQL safety.
 *   4. Basalt UI style hygiene on plugin `.tsx`/`.css` files (if any).
 *
 * Usage:
 *   pnpm run plugin:validate <path-to-plugin-dir> [--json] [--audit] [--allow-no-lockfile]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import burrowEslintPlugin, { recommendedRules } from '../packages/eslint-plugin/src/index.js';
import { isLicensePermitted } from './check-licenses.mjs';

const BLOCKED_LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'preprepare',
  'postprepare',
  'prepack',
  'postpack',
  'prepublish',
  'prepublishOnly',
  'publish',
  'postpublish',
]);
const VALID_PLUGIN_LICENSES_EXTRA = new Set(['AGPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0']);
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const CONFIG_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const EXACT_SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const VALID_PERMISSIONS = new Set([
  'db:own',
  'routes:api',
  'routes:public',
  'events:read',
  'events:before',
  'policy:override',
  'auth:override',
  'storage:override',
  'storage:own',
  'mailer:override',
  'mentions:register',
  'cards:register',
  'ui:register',
]);

/**
 * Deterministic offline advisory table for supply-chain checks without requiring internet access.
 * Maps package name -> { below: string, cve: string, severity: string, summary: string }.
 */
export const OFFLINE_ADVISORIES = {
  lodash: [
    {
      below: '4.17.21',
      cve: 'CVE-2021-23337',
      severity: 'high',
      summary: 'Command injection / prototype pollution in lodash < 4.17.21',
    },
  ],
  minimist: [
    {
      below: '1.2.6',
      cve: 'CVE-2021-44906',
      severity: 'critical',
      summary: 'Prototype pollution in minimist < 1.2.6',
    },
  ],
  'node-fetch': [
    {
      below: '2.6.7',
      cve: 'CVE-2022-0235',
      severity: 'high',
      summary: 'Sensitive header exposure across redirects in node-fetch < 2.6.7',
    },
  ],
  'serialize-javascript': [
    {
      below: '3.1.0',
      cve: 'CVE-2020-7660',
      severity: 'high',
      summary: 'Remote code execution via regex in serialize-javascript < 3.1.0',
    },
  ],
};

function compareSemver(a, b) {
  const pa = a.split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isPinnedDependencySpec(spec) {
  if (typeof spec !== 'string') return false;
  const trimmed = spec.trim();
  if (!trimmed) return false;
  if (trimmed === 'workspace:*' || /^workspace:\d+\.\d+\.\d+$/.test(trimmed)) return true;
  if (/^[~^><=*x]/i.test(trimmed) || trimmed === 'latest') return false;
  if (/^(file:|link:|portal:|https?:|git\+|git:|github:|bitbucket:|gitlab:)/i.test(trimmed)) return false;
  if (/\.tgz(?:$|\?)/i.test(trimmed)) return false;
  return EXACT_SEMVER_RE.test(trimmed);
}

function stripJsComments(source) {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i++;
        out += '\n';
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) {
          if (source[i] === '\n') out += '\n';
          i++;
        }
        i++;
        continue;
      }
    }
    if (ch === '\\' && (inSingle || inDouble || inTemplate)) {
      out += ch + (next ?? '');
      i++;
      continue;
    }
    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate;
    out += ch;
  }
  return out;
}

function isPluginPackageLicenseAllowed(license) {
  if (typeof license !== 'string' || !license.trim()) return false;
  return isLicensePermitted(license) || VALID_PLUGIN_LICENSES_EXTRA.has(license.trim());
}

function walkSourceFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function validateRouteValidationUsage(rawCode, relPath, findings) {
  const code = stripJsComments(rawCode);
  const lines = code.split(/\r?\n/);
  const routeCallRe = /\b(?:ctx|context)\.route\s*\(/;
  const httpVerbRouteRe = /\b(?:router|app)\.(post|put|patch|delete|get)\s*\(\s*['"`]([^'"`]+)['"`]([^)]*)\)/g;
  const rawInputReadRe = /\b(?:c|ctx)\.req\.(?:json|query|param|valid)\b/;

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (routeCallRe.test(line)) {
      const hasValidatorAnywhere = /\bzValidator\b|\bdefineRoute\b/.test(code);
      const mutatesViaHono = /\.(post|put|patch|delete)\s*\(/.test(code);
      if (mutatesViaHono && !/\bzValidator\b/.test(code)) {
        findings.push({
          rule: 'unvalidated-route',
          severity: 'error',
          file: relPath,
          line: idx + 1,
          message:
            'Unvalidated route registration via ctx.route(): use ctx.defineRoute({ method, path, schemas, handler }) or zValidator().',
        });
      } else if (!hasValidatorAnywhere && rawInputReadRe.test(code)) {
        findings.push({
          rule: 'unvalidated-route',
          severity: 'error',
          file: relPath,
          line: idx + 1,
          message:
            'Route reads request params/query/body without schema validation. Use ctx.defineRoute({ schemas }) or zValidator().',
        });
      }
    }
  }

  let match;
  while ((match = httpVerbRouteRe.exec(code)) !== null) {
    const method = match[1].toLowerCase();
    const argsChunk = match[3] || '';
    if (method !== 'get' && !/\bzValidator\b/.test(argsChunk)) {
      const lineNum = code.slice(0, match.index).split(/\r?\n/).length;
      findings.push({
        rule: 'unvalidated-route',
        severity: 'error',
        file: relPath,
        line: lineNum,
        message: `Mutable route .${method}("${match[2]}") must validate input with ctx.defineRoute() or zValidator().`,
      });
    }
  }
}

function validateManifestObject(manifest, findings) {
  if (!manifest || typeof manifest !== 'object') {
    findings.push({
      rule: 'manifest-missing',
      severity: 'error',
      file: 'manifest.json',
      message: 'Missing valid plugin manifest object.',
    });
    return;
  }

  if (typeof manifest.id !== 'string' || !PLUGIN_ID_RE.test(manifest.id)) {
    findings.push({
      rule: 'manifest-id',
      severity: 'error',
      file: 'manifest.json',
      message: `Invalid plugin id "${manifest.id ?? ''}". Expected /^[a-z][a-z0-9-]{0,30}$/.`,
    });
  }
  if (typeof manifest.version !== 'string' || !EXACT_SEMVER_RE.test(manifest.version)) {
    findings.push({
      rule: 'manifest-version',
      severity: 'error',
      file: 'manifest.json',
      message: `Invalid plugin manifest version "${manifest.version ?? ''}". Expected SemVer x.y.z.`,
    });
  }
  if (!Array.isArray(manifest.permissions)) {
    findings.push({
      rule: 'manifest-permissions',
      severity: 'error',
      file: 'manifest.json',
      message: 'manifest.permissions must be an array.',
    });
  } else {
    for (const perm of manifest.permissions) {
      if (!VALID_PERMISSIONS.has(perm)) {
        findings.push({
          rule: 'manifest-permissions',
          severity: 'error',
          file: 'manifest.json',
          message: `Unknown permission "${perm}" in manifest.permissions.`,
        });
      }
    }
  }
  if (manifest.network !== undefined) {
    if (!Array.isArray(manifest.network)) {
      findings.push({
        rule: 'manifest-network',
        severity: 'error',
        file: 'manifest.json',
        message: 'manifest.network must be an array of exact public hostnames.',
      });
    } else {
      for (const host of manifest.network) {
        const lower = String(host).trim().toLowerCase();
        if (
          !lower ||
          lower.includes('*') ||
          lower.includes('/') ||
          lower.includes(':') ||
          lower === 'localhost' ||
          lower.endsWith('.local') ||
          lower.endsWith('.internal') ||
          /^\d+\.\d+\.\d+\.\d+$/.test(lower)
        ) {
          findings.push({
            rule: 'manifest-network',
            severity: 'error',
            file: 'manifest.json',
            message: `Invalid network allowlist host "${host}": private IPs, ports, and wildcards are forbidden.`,
          });
        }
      }
    }
  }
  if (manifest.configKeys !== undefined) {
    if (!Array.isArray(manifest.configKeys)) {
      findings.push({
        rule: 'manifest-config',
        severity: 'error',
        file: 'manifest.json',
        message: 'manifest.configKeys must be an array of ENV_VAR names.',
      });
    } else {
      for (const key of manifest.configKeys) {
        if (typeof key !== 'string' || !CONFIG_KEY_RE.test(key)) {
          findings.push({
            rule: 'manifest-config',
            severity: 'error',
            file: 'manifest.json',
            message: `Invalid configKey "${key}". Expected /^[A-Z][A-Z0-9_]{0,63}$/.`,
          });
        }
      }
    }
  }
  if (manifest.coreTables !== undefined) {
    const allowedCore = new Set([
      'workspaces',
      'projects',
      'project_files',
      'members',
      'invites',
      'boards',
      'board_columns',
      'cards',
      'notepads',
      'tags',
      'card_tags',
    ]);
    if (!Array.isArray(manifest.coreTables)) {
      findings.push({
        rule: 'manifest-core-tables',
        severity: 'error',
        file: 'manifest.json',
        message: 'manifest.coreTables must be an array of allowlisted core table names.',
      });
    } else {
      for (const tbl of manifest.coreTables) {
        if (typeof tbl !== 'string' || !allowedCore.has(tbl)) {
          findings.push({
            rule: 'manifest-core-tables',
            severity: 'error',
            file: 'manifest.json',
            message: `Core table "${tbl}" is not allowlistable in manifest.coreTables.`,
          });
        }
      }
    }
  }
}

function validateSqlMigrationFile(sqlText, relPath, findings) {
  const forbiddenPatterns = [
    { re: /\b_worker_runtime_config\b/i, msg: 'Migration references forbidden internal config table.' },
    { re: /\b(?:sqlite_master|sqlite_schema|pg_catalog|pg_roles|information_schema)\b/i, msg: 'Migration references system metadata catalog.' },
    { re: /(?:^|\s|["`[])(?:user|session|account|verification|bootstrap_state|rate_limits)(?:["`\]]|\s|$)/i, msg: 'Migration references sensitive authentication table.' },
    { re: /\b(?:ATTACH\s+DATABASE|DETACH\s+DATABASE|PRAGMA|LOAD_EXTENSION|COPY\s+\w+\s+(?:FROM|TO))\b/i, msg: 'Migration uses forbidden administrative SQL directive.' },
  ];
  for (const check of forbiddenPatterns) {
    if (check.re.test(sqlText)) {
      findings.push({
        rule: 'unsafe-migration-sql',
        severity: 'error',
        file: relPath,
        message: check.msg,
      });
    }
  }
}

/**
 * Validates a plugin directory for security, supply-chain, manifest, and static rules.
 *
 * @param {string} pluginDir
 * @param {{
 *   runPnpmAudit?: boolean;
 *   requireLockfile?: boolean;
 *   advisories?: typeof OFFLINE_ADVISORIES;
 * }} [options]
 */
export function validatePluginDirectory(pluginDir, options = {}) {
  const resolvedDir = path.resolve(pluginDir);
  const findings = [];
  const advisoryMap = options.advisories ?? OFFLINE_ADVISORIES;

  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    return {
      ok: false,
      pluginDir: resolvedDir,
      findings: [
        {
          rule: 'directory-missing',
          severity: 'error',
          file: '.',
          message: `Plugin directory does not exist: ${resolvedDir}`,
        },
      ],
    };
  }

  // 1. Supply-chain & package.json verification
  const pkgPath = path.join(resolvedDir, 'package.json');
  let pkg = null;
  if (!fs.existsSync(pkgPath)) {
    findings.push({
      rule: 'package-json-missing',
      severity: 'error',
      file: 'package.json',
      message: 'Plugin directory must include package.json.',
    });
  } else {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      findings.push({
        rule: 'package-json-invalid',
        severity: 'error',
        file: 'package.json',
        message: `Invalid JSON in package.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (pkg && typeof pkg === 'object') {
    if (!pkg.name || typeof pkg.name !== 'string') {
      findings.push({
        rule: 'package-name',
        severity: 'error',
        file: 'package.json',
        message: 'package.json must declare a package name.',
      });
    }
    if (!pkg.version || !EXACT_SEMVER_RE.test(String(pkg.version))) {
      findings.push({
        rule: 'package-version',
        severity: 'error',
        file: 'package.json',
        message: `package.json version "${pkg.version ?? ''}" must be valid SemVer.`,
      });
    }
    if (!isPluginPackageLicenseAllowed(pkg.license)) {
      findings.push({
        rule: 'package-license',
        severity: 'error',
        file: 'package.json',
        message: `Plugin license "${pkg.license ?? 'NONE'}" is not approved (expected MIT, Apache-2.0, BSD-*, ISC, or AGPL-3.0-or-later).`,
      });
    }

    // Lifecycle scripts
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      for (const scriptName of Object.keys(pkg.scripts)) {
        if (BLOCKED_LIFECYCLE_SCRIPTS.has(scriptName)) {
          findings.push({
            rule: 'blocked-lifecycle-script',
            severity: 'error',
            file: 'package.json',
            message: `Lifecycle script "${scriptName}" is forbidden in plugins (install-time code execution risk).`,
          });
        }
      }
    }

    // Disallow pkg.bin command hijacking entries
    if (
      pkg.bin !== undefined &&
      ((typeof pkg.bin === 'string' && pkg.bin.trim().length > 0) ||
        (typeof pkg.bin === 'object' && pkg.bin !== null && Object.keys(pkg.bin).length > 0))
    ) {
      findings.push({
        rule: 'blocked-bin-entry',
        severity: 'error',
        file: 'package.json',
        message: 'Plugins must not define package.json "bin" executables.',
      });
    }

    // Check pinned dependencies and lockfile presence across all dependency maps
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
      ...(pkg.optionalDependencies || {}),
      ...(pkg.peerDependencies || {}),
    };
    const nonWorkspaceDeps = Object.entries(deps).filter(
      ([, spec]) => typeof spec === 'string' && !spec.startsWith('workspace:'),
    );

    for (const [depName, spec] of Object.entries(deps)) {
      if (!isPinnedDependencySpec(spec)) {
        findings.push({
          rule: 'unpinned-dependency',
          severity: 'error',
          file: 'package.json',
          message: `Dependency "${depName}": "${spec}" must be pinned to an exact version (ranges like ^, ~, *, latest, file:, git:, and tarball URLs are rejected).`,
        });
      }

      const cleanVer = String(spec).replace(/^[~^=v]+/, '');
      if (EXACT_SEMVER_RE.test(cleanVer) && advisoryMap[depName]) {
        for (const adv of advisoryMap[depName]) {
          if (compareSemver(cleanVer, adv.below) < 0) {
            findings.push({
              rule: 'vulnerable-dependency',
              severity: 'error',
              file: 'package.json',
              message: `Dependency "${depName}@${cleanVer}" violates ${adv.cve} (${adv.severity}): ${adv.summary}`,
            });
          }
        }
      }
    }

    if (options.requireLockfile !== false && nonWorkspaceDeps.length > 0) {
      const candidateLocks = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json']
        .map((name) => path.join(resolvedDir, name))
        .filter((p) => fs.existsSync(p));
      const validLock = candidateLocks.some((lockPath) => {
        try {
          const stat = fs.statSync(lockPath);
          if (!stat.isFile() || stat.size === 0) return false;
          const content = fs.readFileSync(lockPath, 'utf8').trim();
          if (!content) return false;
          if (lockPath.endsWith('.json')) {
            const parsed = JSON.parse(content);
            return Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0);
          }
          return content.includes('lockfileVersion') || content.includes(':');
        } catch {
          return false;
        }
      });
      if (!validLock) {
        findings.push({
          rule: 'missing-lockfile',
          severity: 'error',
          file: 'pnpm-lock.yaml',
          message:
            'Plugins with external dependencies must ship a valid non-empty lockfile (pnpm-lock.yaml or package-lock.json).',
        });
      }
    }

    // Check installed node_modules licenses and postinstall scripts if present
    const nmDir = path.join(resolvedDir, 'node_modules');
    if (fs.existsSync(nmDir)) {
      const scanInstalled = (baseDir) => {
        for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          if (entry.name.startsWith('.')) continue;
          const entryPath = path.join(baseDir, entry.name);
          if (entry.name.startsWith('@')) {
            scanInstalled(entryPath);
            continue;
          }
          const depPkgPath = path.join(entryPath, 'package.json');
          if (!fs.existsSync(depPkgPath)) continue;
          try {
            const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'));
            if (depPkg.scripts) {
              for (const s of Object.keys(depPkg.scripts)) {
                if (BLOCKED_LIFECYCLE_SCRIPTS.has(s)) {
                  findings.push({
                    rule: 'dependency-lifecycle-script',
                    severity: 'error',
                    file: path.relative(resolvedDir, depPkgPath).replace(/\\/g, '/'),
                    message: `Installed dependency "${depPkg.name}" declares blocked lifecycle script "${s}".`,
                  });
                }
              }
            }
            const lic =
              typeof depPkg.license === 'string' ? depPkg.license : depPkg.license?.type || '';
            if (!isLicensePermitted(lic)) {
              findings.push({
                rule: 'dependency-license',
                severity: 'error',
                file: path.relative(resolvedDir, depPkgPath).replace(/\\/g, '/'),
                message: `Dependency "${depPkg.name}" has unapproved license "${lic || 'UNKNOWN'}".`,
              });
            }
          } catch {
            // ignore unreadable dep manifest
          }
        }
      };
      scanInstalled(nmDir);
    }

    if (
      options.runPnpmAudit &&
      fs.existsSync(path.join(resolvedDir, 'pnpm-lock.yaml'))
    ) {
      const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      const auditRes = spawnSync(pnpmCmd, ['audit', '--prod', '--json'], {
        cwd: resolvedDir,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        windowsHide: true,
      });
      if (auditRes.stdout) {
        try {
          const parsed = JSON.parse(auditRes.stdout);
          const advisories = parsed.advisories ? Object.values(parsed.advisories) : [];
          for (const adv of advisories) {
            findings.push({
              rule: 'pnpm-audit',
              severity: 'error',
              file: 'pnpm-lock.yaml',
              message: `${adv.module_name}: ${adv.title || 'Known vulnerability'} (${adv.severity || 'unknown'})`,
            });
          }
        } catch {
          // non-JSON offline output ignored
        }
      }
    }
  }

  // 2. Optional manifest.json check
  const manifestJsonPath = path.join(resolvedDir, 'manifest.json');
  if (fs.existsSync(manifestJsonPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
      validateManifestObject(manifest, findings);
    } catch (err) {
      findings.push({
        rule: 'manifest-json-invalid',
        severity: 'error',
        file: 'manifest.json',
        message: `Invalid JSON in manifest.json: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 3. Static security ESLint rules + route schema enforcement + SQL migrations
  const linter = new Linter({ configType: 'flat', cwd: resolvedDir });
  const eslintFlatConfig = [
    {
      files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts,jsx}'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
      },
      plugins: {
        '@burrow': burrowEslintPlugin,
      },
      rules: recommendedRules,
    },
  ];

  const allFiles = walkSourceFiles(resolvedDir);
  for (const fullPath of allFiles) {
    const relPath = path.relative(resolvedDir, fullPath).replace(/\\/g, '/');
    const ext = path.extname(fullPath).toLowerCase();

    if (ext === '.sql') {
      const sqlText = fs.readFileSync(fullPath, 'utf8');
      validateSqlMigrationFile(sqlText, relPath, findings);
      continue;
    }

    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'].includes(ext)) {
      const code = fs.readFileSync(fullPath, 'utf8');
      const messages = linter.verify(code, eslintFlatConfig, relPath);
      for (const msg of messages) {
        findings.push({
          rule: msg.ruleId || 'eslint-security',
          severity: 'error',
          file: relPath,
          line: msg.line,
          column: msg.column,
          message: msg.message,
        });
      }
      validateRouteValidationUsage(code, relPath, findings);
    }
  }

  return {
    ok: findings.length === 0,
    pluginDir: resolvedDir,
    findings,
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const runAudit = args.includes('--audit');
  const allowNoLockfile = args.includes('--allow-no-lockfile');
  const targetArg = args.find((a) => !a.startsWith('-'));

  if (!targetArg) {
    console.error(
      'Usage: pnpm run plugin:validate <plugin-dir> [--json] [--audit] [--allow-no-lockfile]',
    );
    process.exit(1);
  }

  const result = validatePluginDirectory(targetArg, {
    runPnpmAudit: runAudit,
    requireLockfile: !allowNoLockfile,
  });

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`plugin:validate PASS (${result.pluginDir})`);
  } else {
    console.error(`plugin:validate FAIL (${result.pluginDir}) — ${result.findings.length} issue(s):`);
    for (const f of result.findings) {
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      console.error(`  - [${f.rule}] ${loc}: ${f.message}`);
    }
  }

  process.exit(result.ok ? 0 : 1);
}

const isEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntrypoint) {
  runCli();
}
