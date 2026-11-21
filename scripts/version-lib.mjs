/**
 * Pure SemVer, commit classification, and CHANGELOG rollup utilities.
 * Shared by scripts/check-version.mjs, scripts/bump-version.mjs, and unit tests.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseSemver(version) {
  const match = SEMVER_RE.exec(String(version ?? '').trim());
  if (!match) {
    throw new Error(`Invalid SemVer version "${version}" (expected MAJOR.MINOR.PATCH)`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function formatSemver({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

export function compareSemver(a, b) {
  const pa = typeof a === 'string' ? parseSemver(a) : a;
  const pb = typeof b === 'string' ? parseSemver(b) : b;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

export function bumpSemver(version, level) {
  const parsed = parseSemver(version);
  if (level === 'major') return formatSemver({ major: parsed.major + 1, minor: 0, patch: 0 });
  if (level === 'minor')
    return formatSemver({ major: parsed.major, minor: parsed.minor + 1, patch: 0 });
  if (level === 'patch')
    return formatSemver({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + 1 });
  return formatSemver(parsed);
}

const BUMP_RANK = { none: 0, patch: 1, minor: 2, major: 3 };

export function maxBumpLevel(a, b) {
  return BUMP_RANK[a] >= BUMP_RANK[b] ? a : b;
}

/**
 * Classifies a single commit into 'major' | 'minor' | 'patch' | 'none'.
 *
 * Rules:
 *  - MAJOR: Conventional commit with `!:` (e.g. `feat!:`, `fix(api)!:`) or body containing `BREAKING CHANGE:` / `BREAKING-CHANGE:`.
 *  - MINOR: `feat:` / `feat(...):`, OR added SQL migration file under `migrations/`.
 *  - PATCH: `fix:`, `security:`, `perf:`, `refactor:`, `revert:`, OR runtime code changes (`src/`, `migrations/`, `Dockerfile`, `docker-compose.yml`, `wrangler.jsonc`) not explicitly `chore(release):`.
 *  - NONE: Pure docs, tests, CI, build/chore tooling, or release commits without runtime changes.
 */
export function classifyCommit({ subject = '', body = '', files = [], addedFiles = [] }) {
  const trimmedSubject = subject.trim();
  const fullMessage = `${trimmedSubject}\n${body}`.trim();

  // Pure release commits never demand another bump on top of themselves.
  if (/^chore\(release\):/i.test(trimmedSubject)) {
    return { level: 'none', reason: 'release commit' };
  }

  // Breaking change detection
  if (
    /^[a-z]+(?:\([^)]*\))?!:/i.test(trimmedSubject) ||
    /(?:^|\n)BREAKING[ -]CHANGE:/i.test(fullMessage)
  ) {
    return { level: 'major', reason: 'breaking change' };
  }

  // Feature commits -> minor
  if (/^feat(?:\([^)]*\))?:/i.test(trimmedSubject)) {
    return { level: 'minor', reason: 'feature commit (feat)' };
  }

  // New SQL migrations -> minor
  const addedSqlMigration = addedFiles.some((f) => /^migrations\/(?:postgres\/)?[^/]+\.sql$/i.test(f));
  if (addedSqlMigration) {
    return { level: 'minor', reason: 'new database migration' };
  }

  // Explicit patch commit types
  if (/^(?:fix|security|perf|refactor|revert)(?:\([^)]*\))?:/i.test(trimmedSubject)) {
    return { level: 'patch', reason: 'fix/security/perf/refactor commit' };
  }

  // Explicit non-runtime commit types with no runtime src/ changes -> none
  const isNonRuntimePrefix = /^(?:docs|test|tests|ci|style|chore)(?:\([^)]*\))?:/i.test(
    trimmedSubject,
  );
  const touchesRuntime = files.some((f) =>
    /^(?:src\/|migrations\/|Dockerfile$|docker-compose\.yml$|wrangler\.jsonc$)/i.test(f),
  );

  // Exclude pure version-sync or test files under src/
  const touchesNonTestRuntime = files.some(
    (f) =>
      /^(?:src\/|migrations\/|Dockerfile$|docker-compose\.yml$|wrangler\.jsonc$)/i.test(f) &&
      !/\.test\.[cm]?[jt]sx?$/i.test(f) &&
      f !== 'src/core/version.ts',
  );

  if (touchesNonTestRuntime && !isNonRuntimePrefix) {
    return { level: 'patch', reason: 'runtime source changes' };
  }

  // Even a chore commit that modifies runtime code (e.g. dependency or runtime tweaks) is a patch
  // unless it is specifically chore(ci) / chore(docs) / chore(deps-dev) / chore(submodule).
  if (
    touchesNonTestRuntime &&
    isNonRuntimePrefix &&
    !/^(?:docs|test|tests|ci|style|chore\((?:ci|docs|test|tests|release)\)):/i.test(trimmedSubject)
  ) {
    return { level: 'patch', reason: 'runtime source changes' };
  }

  if (touchesRuntime && !touchesNonTestRuntime) {
    return { level: 'none', reason: 'test or version metadata only' };
  }

  return { level: 'none', reason: 'non-runtime chore/docs/ci/test commit' };
}

/**
 * Computes the highest required SemVer bump across a list of commits.
 */
export function evaluateCommitsBump(commits) {
  let requiredLevel = 'none';
  const triggers = [];

  for (const commit of commits) {
    const { level, reason } = classifyCommit(commit);
    if (level !== 'none') {
      triggers.push({
        hash: commit.hash ?? '',
        subject: commit.subject ?? '',
        level,
        reason,
      });
      requiredLevel = maxBumpLevel(requiredLevel, level);
    }
  }

  return { requiredLevel, triggers };
}

/**
 * Validates that `headVersion` satisfies the required SemVer bump relative to `baseVersion`.
 */
export function validateVersionBump({ baseVersion, headVersion, requiredLevel }) {
  // Always ensure both are valid SemVer
  parseSemver(baseVersion);
  parseSemver(headVersion);

  if (compareSemver(headVersion, baseVersion) < 0) {
    return {
      ok: false,
      expectedMinVersion: bumpSemver(baseVersion, requiredLevel),
      message: `Version regressed from ${baseVersion} to ${headVersion}.`,
    };
  }

  if (requiredLevel === 'none') {
    return { ok: true, expectedMinVersion: baseVersion };
  }

  const expectedMinVersion = bumpSemver(baseVersion, requiredLevel);
  if (compareSemver(headVersion, expectedMinVersion) < 0) {
    return {
      ok: false,
      expectedMinVersion,
      message: `Expected at least ${expectedMinVersion} (${requiredLevel} bump from ${baseVersion}), found ${headVersion}.`,
    };
  }

  return { ok: true, expectedMinVersion };
}

/**
 * Rolls up `## [Unreleased]` entries in a Keep-a-Changelog file into `## [version] - date`.
 * Returns `{ updated: boolean, content: string }`.
 */
export function rollUpChangelog(content, newVersion, dateStr) {
  const normalized = content.replace(/\r\n/g, '\n');
  const unreleasedHeader = '## [Unreleased]';
  const startIdx = normalized.indexOf(unreleasedHeader);
  if (startIdx === -1) {
    return { updated: false, content: normalized };
  }

  const afterHeaderIdx = startIdx + unreleasedHeader.length;
  const nextReleaseMatch = /\n## \[/g;
  nextReleaseMatch.lastIndex = afterHeaderIdx;
  const match = nextReleaseMatch.exec(normalized);
  const sectionEnd = match ? match.index : normalized.length;

  const unreleasedBody = normalized.slice(afterHeaderIdx, sectionEnd);

  // Check if there is at least one bullet item under Unreleased
  if (!/^\s*-\s+\S/m.test(unreleasedBody)) {
    return { updated: false, content: normalized };
  }

  // Strip empty category headings from the released section so release notes stay crisp.
  const lines = unreleasedBody.split('\n');
  const sections = [];
  let currentHeading = null;
  let currentLines = [];

  for (const line of lines) {
    if (/^###\s+/.test(line)) {
      if (currentHeading !== null) {
        sections.push({ heading: currentHeading, lines: currentLines });
      }
      currentHeading = line.trim();
      currentLines = [];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }
  if (currentHeading !== null) {
    sections.push({ heading: currentHeading, lines: currentLines });
  }

  const nonEmptySections = sections
    .map((s) => ({
      heading: s.heading,
      body: s.lines.join('\n').trim(),
    }))
    .filter((s) => s.body.length > 0);

  const releasedBody =
    nonEmptySections.length > 0
      ? nonEmptySections.map((s) => `${s.heading}\n${s.body}`).join('\n\n')
      : unreleasedBody.trim();

  const emptyUnreleasedTemplate = [
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '### Changed',
    '',
    '### Deprecated',
    '',
    '### Removed',
    '',
    '### Fixed',
    '',
    '### Security',
  ].join('\n');

  const releaseSection = `## [${newVersion}] - ${dateStr}\n\n${releasedBody}`;

  const before = normalized.slice(0, startIdx);
  const after = normalized.slice(sectionEnd);
  const updatedContent = `${before}${emptyUnreleasedTemplate}\n\n${releaseSection}${after}`;

  return { updated: true, content: updatedContent };
}
