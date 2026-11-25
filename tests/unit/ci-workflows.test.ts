import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error untyped local .mjs script
import { extractReleaseNotes } from '../../scripts/extract-release-notes.mjs';

const root = path.resolve('.');
const ciWorkflowPath = path.join(root, '.github/workflows/ci.yml');
const demoWorkflowPath = path.join(root, '.github/workflows/demo-reset.yml');
const releaseWorkflowPath = path.join(root, '.github/workflows/release.yml');
const syncWorkflowPath = path.join(root, '.github/workflows/sync-upstream.yml');
const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
const hasCiWorkflow = fs.existsSync(ciWorkflowPath);
const hasDemoWorkflow = fs.existsSync(demoWorkflowPath);
const hasReleaseWorkflow = fs.existsSync(releaseWorkflowPath);
const hasSyncWorkflow = fs.existsSync(syncWorkflowPath);

describe('GitHub Actions workflows security and coverage', () => {
  it('pins pnpm@10.15.0 in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      packageManager?: string;
    };
    expect(pkg.packageManager).toBe('pnpm@10.15.0');
  });

  it.skipIf(!hasCiWorkflow && !isGitHubActions)(
    'pins pnpm@10.15.0, enables PostgreSQL 17, runs full checks, and holds no Cloudflare secrets in CI',
    () => {
      const ci = fs.readFileSync(ciWorkflowPath, 'utf8');
      expect(ci).toContain('pnpm/action-setup@v4');
      expect(ci).toMatch(/version:\s*['"]?10\.15\.0['"]?/);
      expect(ci).toContain('postgres:17');
      expect(ci).toContain('BURROW_TEST_POSTGRES_URL');
      expect(ci).toContain('tsc -b');
      expect(ci).toContain('eslint --max-warnings=0');
      expect(ci).toContain('check-sync.mjs');
      expect(ci).toContain('check-version.mjs');
      expect(ci).toContain('check-decoupling.mjs');
      expect(ci).toContain('check-licenses.mjs');
      expect(ci).toContain('vitest run');
      expect(ci).toContain('contents: read');
      expect(ci).not.toContain('CLOUDFLARE_API_TOKEN');
      expect(ci).not.toContain('DEMO_CLOUDFLARE');
    },
  );

  it('keeps local pre-push git hook aligned with GitHub CI parity checks', () => {
    const hook = fs.readFileSync(path.join(root, '.githooks/pre-push'), 'utf8');
    expect(hook).not.toContain('\r');
    expect(hook).toContain('scripts/pre-push.mjs');

    const prePush = fs.readFileSync(path.join(root, 'scripts/pre-push.mjs'), 'utf8');
    for (const required of [
      'check-version.mjs',
      'check-sync.mjs',
      "'build'",
      'check-basalt.mjs',
      'check-decoupling.mjs',
      'check-licenses.mjs',
      'tsc',
      'eslint',
      'vitest',
    ]) {
      expect(prePush).toContain(required);
    }
  });

  it.skipIf(!hasDemoWorkflow && !isGitHubActions)(
    'keeps scheduled demo reset explicitly confirmed and guarded by BURROW_ALLOW_DEMO_RESET',
    () => {
      const demo = fs.readFileSync(demoWorkflowPath, 'utf8');
      expect(demo).toContain('DEMO_CLOUDFLARE_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN');
      expect(demo).toContain('--remote --confirm-demo-reset=RESET-DEMO-BURROW --confirm=burrow');
      expect(demo).toContain('BURROW_ALLOW_DEMO_RESET');
    },
  );

  it.skipIf(!hasReleaseWorkflow && !isGitHubActions)(
    'auto-publishes GitHub Releases from package.json and CHANGELOG.md with least-privilege GITHUB_TOKEN',
    () => {
      const release = fs.readFileSync(releaseWorkflowPath, 'utf8');
      expect(release).toContain('contents: write');
      expect(release).toContain('gh release view');
      expect(release).toContain('gh release create');
      expect(release).toContain('scripts/extract-release-notes.mjs');
      expect(release).not.toContain('CLOUDFLARE_API_TOKEN');
      expect(release).not.toContain('DEMO_CLOUDFLARE');
    },
  );

  it.skipIf(!hasSyncWorkflow && !isGitHubActions)(
    'keeps sync-upstream.yml gated to forks/clones on dispatch events without interpolating secrets in run blocks',
    () => {
      const sync = fs.readFileSync(syncWorkflowPath, 'utf8');
      expect(sync).toContain('repository_dispatch:');
      expect(sync).toContain('burrow-update');
      expect(sync).toContain('workflow_dispatch:');
      expect(sync).toContain("github.repository != 'Open-Source-Solution-Cafe/Burrow'");
      expect(sync).toContain('node scripts/sync-upstream.mjs');
      expect(sync).toContain('core.hooksPath=/dev/null');
      const runBlocks = sync.match(/run:\s*\|[\s\S]*?(?=\n\s*(?:- name:|steps:|jobs:|$))/g) ?? [];
      for (const block of runBlocks) {
        expect(block).not.toMatch(/\$\{\{\s*secrets\./);
      }
    },
  );

  it('extracts matching release notes section cleanly from CHANGELOG.md', () => {
    const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    const notes040 = extractReleaseNotes(changelog, 'v0.4.0');
    expect(notes040).toContain('### Added');
    expect(notes040).toContain('UpdateAvailableBanner');
    expect(notes040).not.toContain('## [0.3.1]');

    expect(extractReleaseNotes(changelog, '99.99.99')).toBe('');
  });
});
