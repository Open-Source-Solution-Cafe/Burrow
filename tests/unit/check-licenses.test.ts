import { describe, expect, it } from 'vitest';

// @ts-expect-error untyped local .mjs script
import * as checkLicenses from '../../scripts/check-licenses.mjs';

const { evaluateLicenses, isLicensePermitted, isPermittedToken, normalizePackages } =
  checkLicenses as any;

describe('isPermittedToken', () => {
  it('permits standard permissive licenses', () => {
    expect(isPermittedToken('MIT')).toBe(true);
    expect(isPermittedToken('ISC')).toBe(true);
    expect(isPermittedToken('0BSD')).toBe(true);
    expect(isPermittedToken('BlueOak-1.0.0')).toBe(true);
    expect(isPermittedToken('CC0-1.0')).toBe(true);
    expect(isPermittedToken('Unlicense')).toBe(true);
    expect(isPermittedToken('WTFPL')).toBe(true);
  });

  it('permits BSD variants', () => {
    expect(isPermittedToken('BSD')).toBe(true);
    expect(isPermittedToken('BSD-2-Clause')).toBe(true);
    expect(isPermittedToken('BSD-3-Clause')).toBe(true);
    expect(isPermittedToken('BSD-3-Clause-Clear')).toBe(true);
  });

  it('permits Apache variants', () => {
    expect(isPermittedToken('Apache-2.0')).toBe(true);
    expect(isPermittedToken('Apache-1.1')).toBe(true);
  });

  it('permits MPL variants', () => {
    expect(isPermittedToken('MPL-2.0')).toBe(true);
    expect(isPermittedToken('MPL-1.1')).toBe(true);
  });

  it('permits LGPL variants while rejecting GPL and AGPL', () => {
    expect(isPermittedToken('LGPL-2.1')).toBe(true);
    expect(isPermittedToken('LGPL-3.0')).toBe(true);
    expect(isPermittedToken('LGPL-3.0-or-later')).toBe(true);

    expect(isPermittedToken('GPL-2.0')).toBe(false);
    expect(isPermittedToken('GPL-3.0')).toBe(false);
    expect(isPermittedToken('GPL-3.0-only')).toBe(false);
    expect(isPermittedToken('GPL-3.0-or-later')).toBe(false);
    expect(isPermittedToken('AGPL-3.0')).toBe(false);
    expect(isPermittedToken('AGPL-3.0-or-later')).toBe(false);
  });

  it('rejects SSPL and unapproved licenses', () => {
    expect(isPermittedToken('SSPL-1.0')).toBe(false);
    expect(isPermittedToken('Commercial')).toBe(false);
    expect(isPermittedToken('Proprietary')).toBe(false);
  });

  it('rejects empty, UNKNOWN, UNLICENSED, and SEE LICENSE IN', () => {
    expect(isPermittedToken('')).toBe(false);
    expect(isPermittedToken('UNKNOWN')).toBe(false);
    expect(isPermittedToken('UNLICENSED')).toBe(false);
    expect(isPermittedToken('SEE LICENSE IN LICENSE')).toBe(false);
  });
});

describe('isLicensePermitted (SPDX expressions)', () => {
  it('passes single permitted licenses', () => {
    expect(isLicensePermitted('MIT')).toBe(true);
    expect(isLicensePermitted('Apache-2.0')).toBe(true);
    expect(isLicensePermitted('(MIT)')).toBe(true);
  });

  it('fails single forbidden licenses', () => {
    expect(isLicensePermitted('GPL-3.0')).toBe(false);
    expect(isLicensePermitted('AGPL-3.0')).toBe(false);
    expect(isLicensePermitted('SSPL-1.0')).toBe(false);
    expect(isLicensePermitted('UNKNOWN')).toBe(false);
    expect(isLicensePermitted('SEE LICENSE IN LICENSE')).toBe(false);
    expect(isLicensePermitted('')).toBe(false);
  });

  it('evaluates SPDX OR expressions: passes if any alternative is permissive', () => {
    expect(isLicensePermitted('(MIT OR GPL-3.0)')).toBe(true);
    expect(isLicensePermitted('MIT OR GPL-3.0')).toBe(true);
    expect(isLicensePermitted('GPL-3.0 OR MIT')).toBe(true);
    expect(isLicensePermitted('(MIT OR WTFPL)')).toBe(true);
    expect(isLicensePermitted('(BSD-2-Clause OR MIT OR Apache-2.0)')).toBe(true);
    expect(isLicensePermitted('GPL-2.0 OR GPL-3.0')).toBe(false);
    expect(isLicensePermitted('AGPL-3.0 OR SSPL-1.0')).toBe(false);
  });

  it('evaluates SPDX AND expressions: fails if any part is denied', () => {
    expect(isLicensePermitted('Apache-2.0 AND LGPL-3.0-or-later')).toBe(true);
    expect(isLicensePermitted('MIT AND BSD-3-Clause')).toBe(true);
    expect(isLicensePermitted('(MIT AND GPL-3.0)')).toBe(false);
    expect(isLicensePermitted('Apache-2.0 AND AGPL-3.0')).toBe(false);
    expect(isLicensePermitted('MIT AND SSPL-1.0')).toBe(false);
  });

  it('evaluates complex nested boolean expressions', () => {
    expect(isLicensePermitted('(MIT OR GPL-3.0) AND (Apache-2.0 OR AGPL-3.0)')).toBe(true);
    expect(isLicensePermitted('(MIT OR GPL-3.0) AND (GPL-2.0 OR SSPL-1.0)')).toBe(false);
    expect(isLicensePermitted('(GPL-3.0 AND MIT) OR Apache-2.0')).toBe(true);
    expect(isLicensePermitted('(GPL-3.0 AND MIT) OR AGPL-3.0')).toBe(false);
  });

  it('handles WITH exceptions', () => {
    expect(isLicensePermitted('Apache-2.0 WITH LLVM-exception')).toBe(true);
    expect(isLicensePermitted('GPL-2.0 WITH Classpath-exception-2.0')).toBe(false);
  });
});

describe('normalizePackages', () => {
  it('normalizes flat array of packages with version string', () => {
    const input = [
      { name: 'pkg-a', version: '1.0.0', license: 'MIT' },
      { name: 'pkg-b', version: '2.0.0', license: 'Apache-2.0' },
    ];
    expect(normalizePackages(input)).toEqual([
      { name: 'pkg-a', version: '1.0.0', license: 'MIT' },
      { name: 'pkg-b', version: '2.0.0', license: 'Apache-2.0' },
    ]);
  });

  it('normalizes array with versions array', () => {
    const input = [{ name: 'pkg-multi', versions: ['1.0.0', '1.1.0'], license: 'ISC' }];
    expect(normalizePackages(input)).toEqual([
      { name: 'pkg-multi', version: '1.0.0', license: 'ISC' },
      { name: 'pkg-multi', version: '1.1.0', license: 'ISC' },
    ]);
  });

  it('normalizes pnpm dictionary output', () => {
    const input = {
      MIT: [{ name: 'pkg-x', versions: ['1.0.0'], license: 'MIT' }],
      'MPL-2.0': [{ name: 'pkg-y', versions: ['2.1.0', '2.2.0'] }],
    };
    expect(normalizePackages(input)).toEqual([
      { name: 'pkg-x', version: '1.0.0', license: 'MIT' },
      { name: 'pkg-y', version: '2.1.0', license: 'MPL-2.0' },
      { name: 'pkg-y', version: '2.2.0', license: 'MPL-2.0' },
    ]);
  });
});

describe('evaluateLicenses', () => {
  it('passes when all packages have permitted licenses', () => {
    const packages = [
      { name: 'pkg-a', version: '1.0.0', license: 'MIT' },
      { name: 'pkg-b', version: '2.0.0', license: 'Apache-2.0' },
      { name: 'pkg-c', version: '3.0.0', license: 'MPL-2.0' },
    ];
    const result = evaluateLicenses(packages, []);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.staleAllowlist).toHaveLength(0);
    expect(result.allowedCount).toBe(3);
    expect(result.totalPackages).toBe(3);
  });

  it('detects forbidden licenses as violations', () => {
    const packages = [
      { name: 'good-pkg', version: '1.0.0', license: 'MIT' },
      { name: 'bad-pkg', version: '2.0.0', license: 'GPL-3.0' },
      { name: 'agpl-pkg', version: '3.0.0', license: 'AGPL-3.0' },
    ];
    const result = evaluateLicenses(packages, []);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations[0]?.name).toBe('bad-pkg');
    expect(result.violations[1]?.name).toBe('agpl-pkg');
  });

  it('allows forbidden license when matched in allowlist', () => {
    const packages = [{ name: 'allowed-gpl', version: '1.5.0', license: 'GPL-3.0' }];
    const allowList = [
      {
        name: 'allowed-gpl',
        version: '1.5.0',
        license: 'GPL-3.0',
        reason: 'Build-time CLI tool only',
        reviewDate: '2026-11-05',
      },
    ];
    const result = evaluateLicenses(packages, allowList);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.staleAllowlist).toHaveLength(0);
    expect(result.allowedCount).toBe(1);
  });

  it('supports wildcard version in allowlist', () => {
    const packages = [{ name: 'wildcard-tool', version: '2.4.1', license: 'GPL-2.0' }];
    const allowList = [
      {
        name: 'wildcard-tool',
        version: '*',
        license: 'GPL-2.0',
        reason: 'Internal generator only',
        reviewDate: '2026-11-05',
      },
    ];
    const result = evaluateLicenses(packages, allowList);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('detects stale allowlist entries when package is no longer installed', () => {
    const packages = [{ name: 'live-pkg', version: '1.0.0', license: 'MIT' }];
    const allowList = [
      {
        name: 'removed-pkg',
        version: '1.0.0',
        license: 'GPL-3.0',
        reason: 'Removed from dependencies',
        reviewDate: '2026-01-01',
      },
    ];
    const result = evaluateLicenses(packages, allowList);
    expect(result.ok).toBe(false);
    expect(result.staleAllowlist).toHaveLength(1);
    expect(result.staleAllowlist[0]?.name).toBe('removed-pkg');
  });

  it('detects stale allowlist entries when installed version does not match', () => {
    const packages = [{ name: 'upgraded-pkg', version: '2.0.0', license: 'GPL-3.0' }];
    const allowList = [
      {
        name: 'upgraded-pkg',
        version: '1.0.0',
        license: 'GPL-3.0',
        reason: 'Reviewed for 1.0.0 only',
        reviewDate: '2026-01-01',
      },
    ];
    const result = evaluateLicenses(packages, allowList);
    // 2.0.0 is not allowed by allowlist for 1.0.0, and 1.0.0 entry is stale
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.version).toBe('2.0.0');
    expect(result.staleAllowlist).toHaveLength(1);
    expect(result.staleAllowlist[0]?.version).toBe('1.0.0');
  });

  it('detects stale allowlist entries when package was relicensed to permissive', () => {
    const packages = [{ name: 'relicensed-pkg', version: '1.0.0', license: 'MIT' }];
    const allowList = [
      {
        name: 'relicensed-pkg',
        version: '1.0.0',
        license: 'GPL-3.0',
        reason: 'Was GPL in past',
        reviewDate: '2025-01-01',
      },
    ];
    const result = evaluateLicenses(packages, allowList);
    expect(result.ok).toBe(false);
    expect(result.staleAllowlist).toHaveLength(1);
  });
});
