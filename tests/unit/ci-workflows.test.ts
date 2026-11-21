import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('.');

describe('GitHub Actions workflows security and coverage', () => {
  it('pins pnpm@10.15.0, enables PostgreSQL 17, runs full checks, and holds no Cloudflare secrets in CI', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      packageManager?: string;
    };
    expect(pkg.packageManager).toBe('pnpm@10.15.0');

    const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('pnpm/action-setup@v4');
    expect(ci).toMatch(/version:\s*['"]?10\.15\.0['"]?/);
    expect(ci).toContain('postgres:17');
    expect(ci).toContain('BURROW_TEST_POSTGRES_URL');
    expect(ci).toContain('tsc -b');
    expect(ci).toContain('eslint --max-warnings=0');
    expect(ci).toContain('check-sync.mjs');
    expect(ci).toContain('check-decoupling.mjs');
    expect(ci).toContain('check-licenses.mjs');
    expect(ci).toContain('vitest run');
    expect(ci).toContain('contents: read');
    expect(ci).not.toContain('CLOUDFLARE_API_TOKEN');
    expect(ci).not.toContain('DEMO_CLOUDFLARE');
  });

  it('keeps local pre-push git hook aligned with GitHub CI parity checks', () => {
    const hook = fs.readFileSync(path.join(root, '.githooks/pre-push'), 'utf8');
    expect(hook).not.toContain('\r');
    expect(hook).toContain('scripts/pre-push.mjs');

    const prePush = fs.readFileSync(path.join(root, 'scripts/pre-push.mjs'), 'utf8');
    for (const required of [
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

  it('keeps scheduled demo reset explicitly confirmed and guarded by BURROW_ALLOW_DEMO_RESET', () => {
    const demo = fs.readFileSync(path.join(root, '.github/workflows/demo-reset.yml'), 'utf8');
    expect(demo).toContain('DEMO_CLOUDFLARE_API_TOKEN || secrets.CLOUDFLARE_API_TOKEN');
    expect(demo).toContain('--remote --confirm-demo-reset=RESET-DEMO-BURROW --confirm=burrow');
    expect(demo).toContain('BURROW_ALLOW_DEMO_RESET');
  });
});
