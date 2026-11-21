import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../../src/core/version';
// @ts-expect-error untyped local .mjs script
import * as versionLib from '../../scripts/version-lib.mjs';

const {
  bumpSemver,
  classifyCommit,
  compareSemver,
  evaluateCommitsBump,
  parseSemver,
  rollUpChangelog,
  validateVersionBump,
} = versionLib as any;

const root = path.resolve('.');

describe('SemVer version parity and pre-push bump classification', () => {
  it('keeps package.json version strictly synced with src/core/version.ts APP_VERSION', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe(APP_VERSION);
    expect(() => parseSemver(pkg.version)).not.toThrow();
  });

  it('parses, compares, and bumps SemVer strings accurately', () => {
    expect(parseSemver('0.2.0')).toEqual({ major: 0, minor: 2, patch: 0 });
    expect(compareSemver('0.2.0', '0.2.1')).toBe(-1);
    expect(compareSemver('0.3.0', '0.2.9')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(bumpSemver('0.2.5', 'patch')).toBe('0.2.6');
    expect(bumpSemver('0.2.5', 'minor')).toBe('0.3.0');
    expect(bumpSemver('0.2.5', 'major')).toBe('1.0.0');
  });

  it('classifies breaking, minor, patch, and non-runtime commits accurately', () => {
    expect(
      classifyCommit({ subject: 'feat!: drop legacy endpoint', files: ['src/core/app.ts'] }).level,
    ).toBe('major');
    expect(
      classifyCommit({
        subject: 'refactor: update schema',
        body: 'BREAKING CHANGE: old API removed',
        files: ['src/core/app.ts'],
      }).level,
    ).toBe('major');
    expect(
      classifyCommit({ subject: 'feat(editor): add callout block', files: ['src/web/App.tsx'] })
        .level,
    ).toBe('minor');
    expect(
      classifyCommit({
        subject: 'chore: add table migration',
        files: ['migrations/0006_new.sql'],
        addedFiles: ['migrations/0006_new.sql'],
      }).level,
    ).toBe('minor');
    expect(
      classifyCommit({ subject: 'fix(api): prevent null crash', files: ['src/core/app.ts'] }).level,
    ).toBe('patch');
    expect(
      classifyCommit({ subject: 'security(auth): tighten cookie flags', files: ['src/core/app.ts'] })
        .level,
    ).toBe('patch');
    expect(
      classifyCommit({ subject: 'docs: clarify readme', files: ['README.md'] }).level,
    ).toBe('none');
    expect(
      classifyCommit({ subject: 'chore(ci): update workflow', files: ['.github/workflows/ci.yml'] })
        .level,
    ).toBe('none');
    expect(
      classifyCommit({
        subject: 'chore(release): prepare v0.3.0',
        files: ['package.json', 'src/core/version.ts', 'CHANGELOG.md'],
      }).level,
    ).toBe('none');
  });

  it('evaluates multi-commit ranges using the highest required bump level', () => {
    const result = evaluateCommitsBump([
      { hash: 'aaa1111', subject: 'docs: update readme', files: ['README.md'], addedFiles: [] },
      { hash: 'bbb2222', subject: 'fix: trim input', files: ['src/core/app.ts'], addedFiles: [] },
      {
        hash: 'ccc3333',
        subject: 'feat: add export modal',
        files: ['src/web/App.tsx'],
        addedFiles: [],
      },
    ]);
    expect(result.requiredLevel).toBe('minor');
    expect(result.triggers).toHaveLength(2);

    expect(
      validateVersionBump({ baseVersion: '0.2.0', headVersion: '0.2.0', requiredLevel: 'minor' })
        .ok,
    ).toBe(false);
    expect(
      validateVersionBump({ baseVersion: '0.2.0', headVersion: '0.2.1', requiredLevel: 'minor' })
        .ok,
    ).toBe(false);
    expect(
      validateVersionBump({ baseVersion: '0.2.0', headVersion: '0.3.0', requiredLevel: 'minor' })
        .ok,
    ).toBe(true);
    expect(
      validateVersionBump({ baseVersion: '0.2.0', headVersion: '0.2.1', requiredLevel: 'patch' })
        .ok,
    ).toBe(true);
    expect(
      validateVersionBump({ baseVersion: '0.2.0', headVersion: '0.2.0', requiredLevel: 'none' })
        .ok,
    ).toBe(true);
  });

  it('rolls up Keep-a-Changelog Unreleased bullets into a dated release section', () => {
    const sample = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '- New feature A',
      '',
      '### Changed',
      '',
      '### Fixed',
      '- Fixed bug B',
      '',
      '## [0.2.0] - 2026-11-15',
      '',
      '### Added',
      '- Earlier item',
      '',
    ].join('\n');

    const rolled = rollUpChangelog(sample, '0.3.0', '2026-11-21');
    expect(rolled.updated).toBe(true);
    expect(rolled.content).toContain('## [Unreleased]\n\n### Added\n');
    expect(rolled.content).toContain('## [0.3.0] - 2026-11-21\n\n### Added\n- New feature A\n\n### Fixed\n- Fixed bug B');
    expect(rolled.content).not.toContain('## [0.3.0] - 2026-11-21\n\n### Changed');
    expect(rolled.content).toContain('## [0.2.0] - 2026-11-15');
  });
});
