import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error untyped local .mjs script
import * as deployLib from '../../scripts/lib.mjs';

const {
  buildSecretPlan,
  classifyWranglerError,
  collectAccounts,
  migrateDatabase,
  resolveCloudflareAccount,
  resolveRemoteProfile,
  validateEnvironmentPreflight,
  validateWranglerResourceConfig,
  verifyDeployment,
} = deployLib as any;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Cloudflare deployment preflight, recovery, secrets & verification', () => {
  describe('validateEnvironmentPreflight', () => {
    it('passes on Node ^20.19.0 or >=22.12.0 when pnpm and project binaries are available', () => {
      const result22 = validateEnvironmentPreflight({
        nodeVersion: '22.12.0',
        resolveBin: (pkg: string) => `/mock/bin/${pkg}`,
        runFn: () => ({ status: 0, stdout: '10.0.0\n', stderr: '' }),
      });
      const result20 = validateEnvironmentPreflight({
        nodeVersion: '20.19.0',
        resolveBin: (pkg: string) => `/mock/bin/${pkg}`,
        runFn: () => ({ status: 0, stdout: '10.0.0\n', stderr: '' }),
      });

      expect(result22.ok).toBe(true);
      expect(result22.errors).toEqual([]);
      expect(result22.details.nodeMajor).toBe(22);
      expect(result22.details.pnpmVersion).toBe('10.0.0');
      expect(result20.ok).toBe(true);
    });

    it('rejects unsupported Node.js versions and missing dependencies clearly', () => {
      for (const unsupported of ['18.19.0', '20.18.1', '21.7.0', '22.11.0']) {
        const res = validateEnvironmentPreflight({
          nodeVersion: unsupported,
          resolveBin: (pkg: string) => `/mock/bin/${pkg}`,
          runFn: () => ({ status: 0, stdout: '10.0.0\n', stderr: '' }),
        });
        expect(res.ok).toBe(false);
        expect(res.errors.some((e: string) => e.includes('Node.js ^20.19.0 or >=22.12.0 is required'))).toBe(true);
      }

      const result = validateEnvironmentPreflight({
        nodeVersion: '20.18.0',
        resolveBin: (pkg: string) => {
          if (pkg === 'wrangler') throw new Error('missing');
          return `/mock/bin/${pkg}`;
        },
        runFn: () => ({ status: 1, stdout: '', stderr: 'not found' }),
      });

      expect(result.ok).toBe(false);
      expect(result.errors.some((e: string) => e.includes('Node.js ^20.19.0 or >=22.12.0 is required'))).toBe(true);
      expect(result.errors.some((e: string) => e.includes('pnpm is not available'))).toBe(true);
      expect(result.errors.some((e: string) => e.includes('wrangler'))).toBe(true);
    });
  });

  describe('collectAccounts & resolveCloudflareAccount', () => {
    const acctA = '11111111111111111111111111111111';
    const acctB = '22222222222222222222222222222222';

    it('extracts unique 32-char account objects from wrangler whoami JSON', () => {
      const accounts = collectAccounts({
        loggedIn: true,
        accounts: [
          { name: 'Primary Workspace Account', id: acctA },
          { name: 'Secondary Account', id: acctB },
          { name: 'Duplicate Entry', id: acctA.toUpperCase() },
        ],
      });

      expect(accounts).toHaveLength(2);
      expect(accounts.map((a: any) => a.id.toLowerCase())).toEqual([acctA, acctB]);
    });

    it('auto-selects when exactly one account exists', async () => {
      const res = await resolveCloudflareAccount({
        accounts: [{ id: acctA, name: 'Solo' }],
        isInteractive: false,
      });

      expect(res).toEqual({
        ok: true,
        accountId: acctA,
        accountName: 'Solo',
        selectedBy: 'single',
      });
    });

    it('prompts interactively when multiple accounts exist and selects by index or ID', async () => {
      const accounts = [
        { id: acctA, name: 'First' },
        { id: acctB, name: 'Second' },
      ];

      const byIndex = await resolveCloudflareAccount({
        accounts,
        isInteractive: true,
        promptFn: async () => '1',
      });
      expect(byIndex).toEqual({
        ok: true,
        accountId: acctB,
        accountName: 'Second',
        selectedBy: 'prompt',
      });

      const byId = await resolveCloudflareAccount({
        accounts,
        isInteractive: true,
        promptFn: async () => acctA,
      });
      expect(byId).toEqual({
        ok: true,
        accountId: acctA,
        accountName: 'First',
        selectedBy: 'prompt',
      });
    });

    it('fails with actionable guidance when multiple accounts exist in non-interactive mode', async () => {
      const res = await resolveCloudflareAccount({
        accounts: [
          { id: acctA, name: 'First' },
          { id: acctB, name: 'Second' },
        ],
        isInteractive: false,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain('CLOUDFLARE_ACCOUNT_ID');
    });

    it('rejects a CLOUDFLARE_ACCOUNT_ID that does not match any active session account', async () => {
      const res = await resolveCloudflareAccount({
        accounts: [{ id: acctA, name: 'First' }],
        envAccountId: acctB,
        isInteractive: false,
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain('does not match any account');
    });
  });

  describe('validateWranglerResourceConfig', () => {
    const validCfg = {
      name: 'burrow',
      d1_databases: [{ binding: 'DB', database_name: 'burrow' }],
      r2_buckets: [{ binding: 'FILES', bucket_name: 'burrow-files' }],
    };

    it('detects fresh installation when no remote D1 database matches', () => {
      const res = validateWranglerResourceConfig(validCfg, { remoteDbs: [] });
      expect(res.ok).toBe(true);
      expect(res.mode).toBe('fresh');
      expect(res.d1Id).toBeNull();
    });

    it('detects existing installation / retry when remote D1 already exists', () => {
      const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const res = validateWranglerResourceConfig(validCfg, {
        envD1Id: uuid,
        remoteDbs: [{ name: 'burrow', uuid }],
      });
      expect(res.ok).toBe(true);
      expect(res.mode).toBe('existing');
      expect(res.d1Id).toBe(uuid);
    });

    it('detects and blocks D1_DATABASE_ID collisions between .env and Cloudflare account', () => {
      const envUuid = '11111111-1111-1111-1111-111111111111';
      const remoteUuid = '22222222-2222-2222-2222-222222222222';
      const res = validateWranglerResourceConfig(validCfg, {
        envD1Id: envUuid,
        remoteDbs: [{ name: 'burrow', uuid: remoteUuid }],
      });

      expect(res.ok).toBe(false);
      expect(res.errors[0]).toContain('D1_DATABASE_ID collision');
    });

    it('ignores a stale D1_DATABASE_ID in .env after teardown when remoteDbsLoaded is true', () => {
      const staleUuid = '99999999-9999-9999-9999-999999999999';
      const res = validateWranglerResourceConfig(validCfg, {
        envD1Id: staleUuid,
        remoteDbs: [],
        remoteDbsLoaded: true,
      });

      expect(res.ok).toBe(true);
      expect(res.mode).toBe('fresh');
      expect(res.d1Id).toBeNull();
      expect(res.warnings.some((w: string) => w.includes('Ignoring stale D1_DATABASE_ID'))).toBe(true);
    });

    it('fails clearly when d1_databases config is missing', () => {
      const res = validateWranglerResourceConfig({ name: 'burrow' }, { remoteDbs: [] });
      expect(res.ok).toBe(false);
      expect(res.errors[0]).toContain('d1_databases');
    });
  });

  describe('buildSecretPlan', () => {
    it('generates all required secrets on fresh install', () => {
      const plan = buildSecretPlan({
        existingSecrets: [],
        env: {},
        originForAuth: 'https://burrow.example.workers.dev',
      });

      expect(plan.toUpload.BETTER_AUTH_SECRET).toBeTruthy();
      expect(plan.toUpload.BOOTSTRAP_TOKEN).toBeTruthy();
      expect(plan.toUpload.BETTER_AUTH_URL).toBe('https://burrow.example.workers.dev');
      expect(plan.generatedBootstrapToken).toBe(plan.toUpload.BOOTSTRAP_TOKEN);
      expect(plan.preserved).toEqual([]);
    });

    it('preserves existing BETTER_AUTH_SECRET, BOOTSTRAP_TOKEN, and BETTER_AUTH_URL on upgrade/retry', () => {
      const plan = buildSecretPlan({
        existingSecrets: [
          { name: 'BETTER_AUTH_SECRET' },
          { name: 'BOOTSTRAP_TOKEN' },
          { name: 'BETTER_AUTH_URL' },
        ],
        env: {},
        originForAuth: 'https://burrow.example.workers.dev',
      });

      expect(plan.toUpload).toEqual({});
      expect(plan.generatedBootstrapToken).toBeNull();
      expect(plan.preserved).toEqual([
        'BETTER_AUTH_SECRET',
        'BOOTSTRAP_TOKEN',
        'BETTER_AUTH_URL',
      ]);
    });

    it('ignores short or placeholder BETTER_AUTH_SECRET values in local .env during fresh remote install', () => {
      for (const weak of [
        'local-dev-secret-change-me',
        'dev-secret-change-me-32-bytes-minimum!!',
        'too-short',
      ]) {
        const plan = buildSecretPlan({
          existingSecrets: [],
          env: { BETTER_AUTH_SECRET: weak },
          originForAuth: 'https://burrow.example.com',
        });
        expect(plan.toUpload.BETTER_AUTH_SECRET).not.toBe(weak);
        expect(plan.toUpload.BETTER_AUTH_SECRET.length).toBeGreaterThanOrEqual(32);
      }
    });

    it('rotates BOOTSTRAP_TOKEN only when explicitly requested while preserving BETTER_AUTH_SECRET', () => {
      const plan = buildSecretPlan({
        existingSecrets: ['BETTER_AUTH_SECRET', 'BOOTSTRAP_TOKEN', 'BETTER_AUTH_URL'],
        env: {},
        originForAuth: 'https://burrow.example.workers.dev',
        rotateBootstrapToken: true,
      });

      expect(plan.toUpload.BETTER_AUTH_SECRET).toBeUndefined();
      expect(plan.toUpload.BOOTSTRAP_TOKEN).toBeTruthy();
      expect(plan.generatedBootstrapToken).toBe(plan.toUpload.BOOTSTRAP_TOKEN);
      expect(plan.preserved).toContain('BETTER_AUTH_SECRET');
    });
  });

  describe('migrateDatabase data preservation guard', () => {
    it('refuses automatic destructive table drops on pre-baseline schemas during normal deploy/setup', async () => {
      const executedCommands: string[] = [];
      const mockRun = (_cmd: string, args: string[]) => {
        executedCommands.push(args.join(' '));
        if (args.includes('--json')) {
          return {
            status: 0,
            stdout: JSON.stringify([
              { results: [{ name: '0001_old_init.sql' }] },
              { results: [] },
            ]),
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      };

      await expect(
        migrateDatabase(
          { kind: 'worker', persistTo: './data' },
          { databaseName: 'burrow', runFn: mockRun },
        ),
      ).rejects.toThrow('Automatic table deletion is disabled');

      expect(executedCommands.some((cmd) => cmd.includes('DROP TABLE'))).toBe(false);
    });
  });

  describe('classifyWranglerError', () => {
    it('classifies expired auth, missing permissions, R2 disabled, and D1 UUID errors', () => {
      expect(classifyWranglerError('Authentication error [code: 10000]').category).toBe(
        'auth_expired',
      );
      expect(classifyWranglerError('Insufficient permissions [code: 10003]').category).toBe(
        'permissions_missing',
      );
      expect(
        classifyWranglerError('Please enable R2 through the Cloudflare Dashboard [code: 10042]')
          .category,
      ).toBe('r2_disabled');
      expect(classifyWranglerError('could not find database_id').category).toBe('d1_uuid');
    });
  });

  describe('verifyDeployment', () => {
    it('passes when health, auth config, version, and frontend SPA HTML all succeed', async () => {
      const mockFetch = async (url: string) => {
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true, now: 123 }), { status: 200 });
        }
        if (url.endsWith('/api/auth/config')) {
          return new Response(
            JSON.stringify({ emailPasswordEnabled: true, signupMode: 'bootstrap-or-invite' }),
            { status: 200 },
          );
        }
        if (url.endsWith('/api/system/version')) {
          return new Response(JSON.stringify({ currentVersion: '0.1.0' }), { status: 200 });
        }
        return new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
          status: 200,
        });
      };

      const res = await verifyDeployment('https://burrow.example.com/', {
        attempts: 1,
        delayMs: 0,
        fetchFn: mockFetch,
      });

      expect(res.ok).toBe(true);
      expect(res.checks).toEqual({
        health: true,
        authConfig: true,
        version: true,
        frontend: true,
      });
      expect(res.errors).toEqual([]);
    });

    it('fails clearly if /api/health returns 500 or /api/auth/config fails', async () => {
      const failHealth = async () => new Response('Server Error', { status: 500 });
      const resHealth = await verifyDeployment('https://burrow.example.com', {
        attempts: 1,
        delayMs: 0,
        fetchFn: failHealth,
      });
      expect(resHealth.ok).toBe(false);
      expect(resHealth.checks.health).toBe(false);

      const failAuth = async (url: string) => {
        if (url.endsWith('/api/health')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.endsWith('/api/auth/config')) {
          return new Response('Internal Error', { status: 500 });
        }
        if (url.endsWith('/api/system/version')) {
          return new Response(JSON.stringify({ currentVersion: '0.1.0' }), { status: 200 });
        }
        return new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
          status: 200,
        });
      };
      const resAuth = await verifyDeployment('https://burrow.example.com', {
        attempts: 1,
        delayMs: 0,
        fetchFn: failAuth,
      });
      expect(resAuth.ok).toBe(false);
      expect(resAuth.checks.authConfig).toBe(false);
      expect(resAuth.errors[0]).toContain('/api/auth/config returned HTTP 500');
    });
  });

  describe('setup.mjs -r --dry-run CLI contract', () => {
    it('prints all 10 setup stages cleanly without mutating remote state', () => {
      const res = spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'setup.mjs'), '-r', '--dry-run'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env },
        },
      );

      expect(res.status).toBe(0);
      for (let i = 1; i <= 10; i++) {
        expect(res.stdout).toContain(`Stage ${i}/10`);
      }
    });

    it('prints burrow-staging and burrow-staging-files across all 10 stages with --staging --dry-run', () => {
      const res = spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'setup.mjs'), '-r', '--staging', '--dry-run'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, CLOUDFLARE_DOMAIN: 'burrow.example.com' },
        },
      );

      expect(res.status).toBe(0);
      expect(res.stdout).toContain('burrow-staging');
      expect(res.stdout).toContain('burrow-staging-files');
      for (let i = 1; i <= 10; i++) {
        expect(res.stdout).toContain(`Stage ${i}/10`);
      }
    });
  });

  describe('resolveRemoteProfile & production safety guards', () => {
    const baseConfig = {
      name: 'burrow',
      d1_databases: [{ binding: 'DB', database_name: 'burrow', migrations_dir: 'migrations' }],
      r2_buckets: [{ binding: 'FILES', bucket_name: 'burrow-files' }],
    };

    it('maps default production profile and reads CLOUDFLARE_DOMAIN when --domain is omitted', () => {
      const profile = resolveRemoteProfile(baseConfig, {
        args: ['-r'],
        env: { CLOUDFLARE_DOMAIN: 'https://burrow.example.com/', D1_DATABASE_ID: 'prod-uuid-1' },
      });

      expect(profile.isStaging).toBe(false);
      expect(profile.envName).toBe('production');
      expect(profile.workerName).toBe('burrow');
      expect(profile.dbName).toBe('burrow');
      expect(profile.bucketName).toBe('burrow-files');
      expect(profile.localConfigFilename).toBe('wrangler.local.jsonc');
      expect(profile.d1EnvKey).toBe('D1_DATABASE_ID');
      expect(profile.envD1Id).toBe('prod-uuid-1');
      expect(profile.domain).toBe('burrow.example.com');
    });

    it('isolates --staging resources, ignores production .env keys, and blocks production domains', () => {
      const stagingProfile = resolveRemoteProfile(baseConfig, {
        args: ['-r', '--staging'],
        env: {
          CLOUDFLARE_DOMAIN: 'burrow.example.com',
          D1_DATABASE_ID: 'prod-uuid-1',
          STAGING_D1_DATABASE_ID: 'staging-uuid-2',
        },
      });

      expect(stagingProfile.isStaging).toBe(true);
      expect(stagingProfile.envName).toBe('staging');
      expect(stagingProfile.workerName).toBe('burrow-staging');
      expect(stagingProfile.dbName).toBe('burrow-staging');
      expect(stagingProfile.bucketName).toBe('burrow-staging-files');
      expect(stagingProfile.localConfigFilename).toBe('wrangler.staging.local.jsonc');
      expect(stagingProfile.d1EnvKey).toBe('STAGING_D1_DATABASE_ID');
      expect(stagingProfile.envD1Id).toBe('staging-uuid-2');
      expect(stagingProfile.domain).toBeUndefined();
      expect(stagingProfile.effectiveConfig.name).toBe('burrow-staging');
      expect(stagingProfile.effectiveConfig.d1_databases[0].database_name).toBe('burrow-staging');
      expect(stagingProfile.effectiveConfig.r2_buckets[0].bucket_name).toBe('burrow-staging-files');

      expect(() =>
        resolveRemoteProfile(baseConfig, {
          args: ['-r', '--staging', '--domain', 'burrow.osscafe.com'],
          env: {},
        }),
      ).toThrow('Refusing to attach production domain');
    });

    it('blocks non-interactive --force teardown or reset on production without explicit override', () => {
      const teardownRes = spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'teardown.mjs'), '-r', '--force'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env },
        },
      );
      expect(teardownRes.status).not.toBe(0);
      expect(teardownRes.stderr).toContain('Refusing --force teardown on PRODUCTION');

      const resetRes = spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'reset.mjs'), '-r', '--force'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env },
        },
      );
      expect(resetRes.status).not.toBe(0);
      expect(resetRes.stderr).toContain('Refusing --force reset on PRODUCTION');
    });
  });
});
