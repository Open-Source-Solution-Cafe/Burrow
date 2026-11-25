import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error untyped local .mjs script
import * as deployLib from '../../scripts/lib.mjs';
// @ts-expect-error untyped local .mjs script
import * as deployScript from '../../scripts/deploy.mjs';
// @ts-expect-error untyped local .mjs script
import * as syncUpstreamScript from '../../scripts/sync-upstream.mjs';
// @ts-expect-error untyped local .mjs script
import * as demoResetLib from '../../scripts/demo-reset.mjs';

const {
  assertDemoResetAllowed,
  assertProductionOperationAllowed,
  buildSecretPlan,
  classifyWranglerError,
  collectAccounts,
  isNodeScript,
  KNOWN_BOOTSTRAP_PLACEHOLDERS,
  KNOWN_SECRET_PLACEHOLDERS,
  migrateDatabase,
  parseCliArgs,
  parseJsonc,
  resolveCloudflareAccount,
  resolveDeployProfile,
  resolveRemoteProfile,
  validateEnvironmentPreflight,
  validateWranglerResourceConfig,
  verifyDeployment,
} = deployLib as any;

const { ensureSdkBuilt, isWorkersCiBuild, resolveWorkersCiConfigArgs } = deployScript as any;
const { mergePreservedPackageName, mergePreservedWranglerConfig } = syncUpstreamScript as any;

const {
  buildDemoSeedSql,
  resolveDemoResetContext,
  validateDemoEmail,
  verifyRemoteDemoResources,
} = demoResetLib as any;

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

    it('uses d1_databases[0].database_id from wrangler.jsonc when remote listing is unavailable', () => {
      const uuid = 'cccccccc-dddd-4eee-8fff-111111111111';
      const res = validateWranglerResourceConfig(
        {
          name: 'burrowgitdeploy',
          d1_databases: [{ binding: 'DB', database_name: 'burrowgitdeploy', database_id: uuid }],
          r2_buckets: [{ binding: 'FILES', bucket_name: 'burrowgitdeploy-files' }],
        },
        { remoteDbs: [], remoteDbsLoaded: false },
      );
      expect(res.ok).toBe(true);
      expect(res.mode).toBe('existing');
      expect(res.d1Id).toBe(uuid);
    });
  });

  describe('buildSecretPlan', () => {
    it('generates required session secret and auth URL on fresh install without forcing BOOTSTRAP_TOKEN unless configured', () => {
      const plan = buildSecretPlan({
        existingSecrets: [],
        env: {},
        originForAuth: 'https://burrow.example.workers.dev',
      });

      expect(plan.toUpload.BETTER_AUTH_SECRET).toBeTruthy();
      expect(plan.toUpload.BOOTSTRAP_TOKEN).toBeUndefined();
      expect(plan.toUpload.BETTER_AUTH_URL).toBe('https://burrow.example.workers.dev');
      expect(plan.generatedBootstrapToken).toBeNull();
      expect(plan.preserved).toEqual([]);

      const explicitPlan = buildSecretPlan({
        existingSecrets: [],
        env: { BOOTSTRAP_TOKEN: 'explicit-bootstrap-token-1234' },
        originForAuth: 'https://burrow.example.workers.dev',
      });
      expect(explicitPlan.toUpload.BOOTSTRAP_TOKEN).toBe('explicit-bootstrap-token-1234');
      expect(explicitPlan.generatedBootstrapToken).toBe('explicit-bootstrap-token-1234');
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

    it('prints staging worker, D1, and R2 names across all 10 stages with --staging --dry-run', () => {
      const liveCfg = parseJsonc(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
      const expectedStaging = resolveRemoteProfile(liveCfg, {
        args: ['-r', '--staging'],
        env: {},
      });
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
      expect(res.stdout).toContain(expectedStaging.workerName);
      expect(res.stdout).toContain(expectedStaging.dbName);
      expect(res.stdout).toContain(expectedStaging.bucketName);
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

      const stagingFromProvisionedProd = resolveRemoteProfile(
        {
          ...baseConfig,
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'burrow',
              database_id: 'prod-provisioned-uuid',
              migrations_dir: 'migrations',
            },
          ],
        },
        { args: ['-r', '--staging'], env: {} },
      );
      expect(stagingFromProvisionedProd.effectiveConfig.d1_databases[0].database_id).toBeUndefined();

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

    it('blocks CI=true, --force, missing --demo, and missing target configuration in demo-reset.mjs', () => {
      const demoAccount = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const demoDbId = '11111111-1111-4111-8111-111111111111';
      const demoBaseConfig = {
        ...baseConfig,
        env: {
          demo: {
            name: 'burrow-demo',
            d1_databases: [{ binding: 'DB', database_name: 'burrow-demo', migrations_dir: 'migrations' }],
            r2_buckets: [{ binding: 'FILES', bucket_name: 'burrow-demo-files' }],
          },
        },
      };
      const validDemoEnv = {
        DEMO_CLOUDFLARE_ACCOUNT_ID: demoAccount,
        DEMO_WORKER_NAME: 'burrow-demo',
        DEMO_D1_DATABASE_NAME: 'burrow-demo',
        DEMO_D1_DATABASE_ID: demoDbId,
        DEMO_R2_BUCKET_NAME: 'burrow-demo-files',
        BURROW_ALLOW_DEMO_RESET: 'true',
      };

      const demoResCi = spawnSync(
        process.execPath,
        [path.join(root, 'scripts', 'demo-reset.mjs'), '--remote', '--demo', '--force'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, ...validDemoEnv, CI: 'true', BURROW_ALLOW_DEMO_RESET: '' },
        },
      );
      expect(demoResCi.status).not.toBe(0);
      expect(demoResCi.stderr).toContain('Refusing remote demo reset');

      // Regression guard: omitting --demo previously fell back to production database 'burrow'.
      expect(() =>
        resolveDemoResetContext({
          args: ['--remote', '--confirm-demo-reset=RESET-DEMO-BURROW'],
          env: { ...validDemoEnv, CI: 'true' },
          isInteractive: false,
          baseConfig: demoBaseConfig,
        }),
      ).toThrow(/without explicit --demo flag/i);

      // CI=true + --force alone must never authorize a reset.
      expect(() =>
        resolveDemoResetContext({
          args: ['--remote', '--demo', '--force'],
          env: { ...validDemoEnv, CI: 'true', BURROW_ALLOW_DEMO_RESET: 'true' },
          isInteractive: false,
          baseConfig: demoBaseConfig,
        }),
      ).toThrow('Refusing remote demo reset');

      // Missing exact target fields must be rejected instead of falling back to production.
      expect(() =>
        resolveDemoResetContext({
          args: ['--remote', '--demo', '--confirm-demo-reset=RESET-DEMO-BURROW'],
          env: { BURROW_ALLOW_DEMO_RESET: 'true' },
          isInteractive: false,
          baseConfig: demoBaseConfig,
        }),
      ).toThrow(/DEMO_CLOUDFLARE_ACCOUNT_ID/);

      const authorized = resolveDemoResetContext({
        args: ['--remote', '--demo', '--confirm-demo-reset=RESET-DEMO-BURROW'],
        env: validDemoEnv,
        isInteractive: false,
        baseConfig: demoBaseConfig,
      });
      expect(authorized.isRemote).toBe(true);
      expect(authorized.profile.isDemo).toBe(true);
      expect(authorized.profile.workerName).toBe('burrow-demo');
      expect(authorized.profile.dbName).toBe('burrow-demo');
      expect(authorized.profile.bucketName).toBe('burrow-demo-files');
      expect(authorized.profile.localConfigFilename).toBe('wrangler.demo.local.jsonc');

      const confirmedPrimary = resolveDemoResetContext({
        args: ['--remote', '--confirm-demo-reset=RESET-DEMO-BURROW', '--confirm=burrow'],
        env: { BURROW_ALLOW_DEMO_RESET: 'true' },
        isInteractive: false,
        baseConfig: demoBaseConfig,
      });
      expect(confirmedPrimary.isRemote).toBe(true);
      expect(confirmedPrimary.profile.workerName).toBe('burrow');
      expect(confirmedPrimary.expectedTarget).toBeNull();

      // Cloned repos renamed by Cloudflare's Deploy button match their configured Worker name.
      const renamedBaseConfig = { ...demoBaseConfig, name: 'burrowgitdeploy' };
      const confirmedRenamed = resolveDemoResetContext({
        args: ['--remote', '--confirm-demo-reset=RESET-DEMO-BURROW', '--confirm=burrowgitdeploy'],
        env: { BURROW_ALLOW_DEMO_RESET: 'true' },
        isInteractive: false,
        baseConfig: renamedBaseConfig,
      });
      expect(confirmedRenamed.profile.workerName).toBe('burrowgitdeploy');

      expect(() =>
        resolveDemoResetContext({
          args: ['--remote', '--confirm-demo-reset=RESET-DEMO-BURROW', '--confirm=wrong-worker'],
          env: { BURROW_ALLOW_DEMO_RESET: 'true' },
          isInteractive: false,
          baseConfig: demoBaseConfig,
        }),
      ).toThrow(/does not match target Worker/);
    });

    it('rejects SQL injection in DEMO_EMAIL when building demo seed SQL (#001)', () => {
      expect(() => validateDemoEmail("demo@osscafe.com', 1); DROP TABLE user; --")).toThrow(
        /Invalid DEMO_EMAIL/,
      );
      expect(() => buildDemoSeedSql('hash123', "bad'user@example.com")).toThrow(/Invalid DEMO_EMAIL/);
      expect(() => buildDemoSeedSql('hash123', 'demo@osscafe.com')).not.toThrow();
    });

    it('requires both confirmation token and matching worker name for non-interactive production reset/teardown (#001)', () => {
      const prodProfile = resolveDeployProfile(baseConfig, { args: ['-r'], env: {} });

      expect(() =>
        assertProductionOperationAllowed({
          operation: 'teardown',
          profile: prodProfile,
          args: ['-r', '--force', '--confirm-production-teardown=DELETE-PRODUCTION-BURROW'],
          env: { CI: 'true' },
          isInteractive: false,
        }),
      ).toThrow('--confirm=burrow');

      expect(
        assertProductionOperationAllowed({
          operation: 'teardown',
          profile: prodProfile,
          args: [
            '-r',
            '--confirm-production-teardown=DELETE-PRODUCTION-BURROW',
            '--confirm=burrow',
          ],
          env: { CI: 'true' },
          isInteractive: false,
        }).mode,
      ).toBe('explicit-flags');

      expect(() =>
        assertDemoResetAllowed({
          profile: prodProfile,
          args: ['-r', '--force'],
          env: { CI: 'true' },
          isInteractive: false,
        }),
      ).toThrow('Refusing remote demo reset');
    });

    it('rejects unknown, contradictory, and malformed CLI arguments instead of defaulting to production (#010)', () => {
      expect(() => parseCliArgs(['-r', '--stage'])).toThrow('Unknown CLI argument: --stage');
      expect(() => parseCliArgs(['-r', '--domain'])).toThrow('Missing value for CLI argument: --domain');
      expect(() => parseCliArgs(['-r', '--staging=maybe'])).toThrow('Invalid boolean value');
      expect(() => parseCliArgs(['-r', '--staging', '--env=production'])).toThrow(
        'Contradictory CLI arguments',
      );
      expect(() =>
        resolveRemoteProfile(baseConfig, { args: ['-r', '--env=stage'], env: {} }),
      ).toThrow('Invalid --env value');

      // --staging=false must evaluate to production rather than matching --staging substring
      const explicitProd = resolveRemoteProfile(baseConfig, {
        args: ['-r', '--staging=false'],
        env: { BURROW_DEPLOY_ENV: 'staging' },
      });
      expect(explicitProd.isStaging).toBe(false);
      expect(explicitProd.workerName).toBe('burrow');

      // --env=production must override BURROW_DEPLOY_ENV=staging
      const envOverride = resolveRemoteProfile(baseConfig, {
        args: ['-r', '--env=production'],
        env: { BURROW_DEPLOY_ENV: 'staging' },
      });
      expect(envOverride.isStaging).toBe(false);
      expect(envOverride.dbName).toBe('burrow');
    });

    it('prevents staging profiles from resolving to production resources and vice versa (#002)', () => {
      expect(() =>
        resolveRemoteProfile(baseConfig, {
          args: ['-r', '--staging', '--name', 'burrow'],
          env: {},
        }),
      ).toThrow('Staging Worker names must include "staging"');

      expect(() =>
        resolveRemoteProfile(baseConfig, {
          args: ['-r', '--staging', '--domain', 'notes.example.com'],
          env: {},
        }),
      ).toThrow('Refusing to attach production domain');

      expect(() =>
        resolveRemoteProfile(baseConfig, {
          args: ['-r', '--name', 'burrow-staging'],
          env: {},
        }),
      ).toThrow('Refusing production profile with staging Worker name');
    });

    it('treats newly identified Docker fallback secrets as insecure placeholders (#003)', () => {
      expect(KNOWN_SECRET_PLACEHOLDERS.has('burrow-selfhost-secret-key-32-bytes-minimum!!')).toBe(
        true,
      );
      expect(KNOWN_BOOTSTRAP_PLACEHOLDERS.has('burrow-bootstrap-token-initial-setup')).toBe(true);
    });

    it('isolates --demo profile from production and rejects contradictory demo flags', () => {
      expect(() => parseCliArgs(['-r', '--demo', '--staging'])).toThrow(
        'Contradictory CLI arguments',
      );
      expect(() => parseCliArgs(['-r', '--demo', '--env=production'])).toThrow(
        'Contradictory CLI arguments',
      );
      expect(() => parseCliArgs(['-r', '--demo=false', '--env=demo'])).toThrow(
        'Contradictory CLI arguments',
      );

      const demoProfile = resolveRemoteProfile(baseConfig, {
        args: ['-r', '--demo'],
        env: {
          CLOUDFLARE_DOMAIN: 'notes.example.com',
          D1_DATABASE_ID: 'prod-uuid-1',
          DEMO_D1_DATABASE_ID: 'demo-uuid-3',
        },
      });
      expect(demoProfile.isDemo).toBe(true);
      expect(demoProfile.isStaging).toBe(false);
      expect(demoProfile.envName).toBe('demo');
      expect(demoProfile.workerName).toBe('burrow-demo');
      expect(demoProfile.dbName).toBe('burrow-demo');
      expect(demoProfile.bucketName).toBe('burrow-demo-files');
      expect(demoProfile.localConfigFilename).toBe('wrangler.demo.local.jsonc');
      expect(demoProfile.d1EnvKey).toBe('DEMO_D1_DATABASE_ID');
      expect(demoProfile.envD1Id).toBe('demo-uuid-3');
      expect(demoProfile.domain).toBeUndefined();

      expect(() =>
        resolveRemoteProfile(baseConfig, {
          args: ['-r', '--demo', '--name', 'burrow'],
          env: {},
        }),
      ).toThrow('Refusing demo profile');

      expect(() =>
        resolveRemoteProfile(baseConfig, {
          args: ['-r', '--demo'],
          env: {
            D1_DATABASE_ID: 'same-uuid-1',
            DEMO_D1_DATABASE_ID: 'same-uuid-1',
          },
        }),
      ).toThrow('matches production D1_DATABASE_ID');
    });

    it('runs end-to-end demo-reset CLI with mocked Wrangler and enforces remote resource checks', () => {
      const demoAccount = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const demoDbId = '11111111-1111-4111-8111-111111111111';
      const prodDbId = '22222222-2222-4222-8222-222222222222';

      const createMockDemoWorkspace = (scenario: Record<string, unknown>) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-demo-e2e-'));
        fs.cpSync(path.join(root, 'scripts'), path.join(tmpDir, 'scripts'), { recursive: true });
        fs.writeFileSync(
          path.join(tmpDir, 'wrangler.jsonc'),
          JSON.stringify(
            {
              name: 'burrow',
              main: 'src/worker/index.ts',
              compatibility_date: '2025-01-01',
              compatibility_flags: ['nodejs_compat'],
              d1_databases: [{ binding: 'DB', database_name: 'burrow', migrations_dir: 'migrations' }],
              r2_buckets: [{ binding: 'FILES', bucket_name: 'burrow-files' }],
              env: {
                demo: {
                  name: 'burrow-demo',
                  d1_databases: [
                    { binding: 'DB', database_name: 'burrow-demo', migrations_dir: 'migrations' },
                  ],
                  r2_buckets: [{ binding: 'FILES', bucket_name: 'burrow-demo-files' }],
                },
              },
            },
            null,
            2,
          ),
        );
        fs.copyFileSync(path.join(root, 'package.json'), path.join(tmpDir, 'package.json'));
        fs.symlinkSync(path.join(root, 'src'), path.join(tmpDir, 'src'), 'junction');
        fs.symlinkSync(path.join(root, 'migrations'), path.join(tmpDir, 'migrations'), 'junction');

        const realNm = path.join(root, 'node_modules');
        const tmpNm = path.join(tmpDir, 'node_modules');
        fs.mkdirSync(tmpNm, { recursive: true });
        for (const entry of fs.readdirSync(realNm)) {
          if (entry === 'wrangler' || entry === '.bin') continue;
          const full = path.join(realNm, entry);
          if (entry.startsWith('@') && fs.statSync(full).isDirectory()) {
            const scopeDir = path.join(tmpNm, entry);
            fs.mkdirSync(scopeDir, { recursive: true });
            for (const sub of fs.readdirSync(full)) {
              const subFull = path.join(full, sub);
              if (fs.statSync(subFull).isDirectory()) {
                fs.symlinkSync(fs.realpathSync(subFull), path.join(scopeDir, sub), 'junction');
              }
            }
          } else if (fs.statSync(full).isDirectory()) {
            fs.symlinkSync(fs.realpathSync(full), path.join(tmpNm, entry), 'junction');
          }
        }

        const logFile = path.join(tmpDir, 'wrangler-calls.jsonl');
        const wranglerDir = path.join(tmpNm, 'wrangler');
        fs.mkdirSync(path.join(wranglerDir, 'bin'), { recursive: true });
        fs.writeFileSync(
          path.join(wranglerDir, 'package.json'),
          JSON.stringify({ name: 'wrangler', version: '0.0.0-mock', bin: { wrangler: 'bin/wrangler.mjs' } }),
        );
        const mockScript = `
          import fs from 'node:fs';
          const scenario = ${JSON.stringify(scenario)};
          const args = process.argv.slice(2);
          fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({
            args,
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID || null,
          }) + '\\n');
          const joined = args.join(' ');
          if (args[0] === 'whoami') {
            process.stdout.write(JSON.stringify({ loggedIn: true, accounts: scenario.accounts }));
            process.exit(0);
          }
          if (args[0] === 'd1' && args[1] === 'list') {
            process.stdout.write(JSON.stringify(scenario.d1Databases));
            process.exit(0);
          }
          if (args[0] === 'deployments' && args[1] === 'list') {
            if (!scenario.workerExists) {
              process.stderr.write('Worker not found');
              process.exit(1);
            }
            process.stdout.write(JSON.stringify([{ id: 'dep-demo-1' }]));
            process.exit(0);
          }
          if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'info') {
            const name = args[3];
            if (!scenario.r2Bucket || scenario.r2Bucket !== name) {
              process.stderr.write('R2 bucket not found');
              process.exit(1);
            }
            process.stdout.write(JSON.stringify({ name }));
            process.exit(0);
          }
          if (joined.includes('SELECT name FROM d1_migrations')) {
            process.stdout.write(JSON.stringify([{ results: [{ name: '0000_baseline.sql' }] }, { results: [] }]));
            process.exit(0);
          }
          if (joined.includes('SELECT storage_key AS key FROM project_files')) {
            process.stdout.write(JSON.stringify([{ results: [] }]));
            process.exit(0);
          }
          process.stdout.write(JSON.stringify([{ results: [] }]));
          process.exit(0);
        `;
        fs.writeFileSync(path.join(wranglerDir, 'bin', 'wrangler.mjs'), mockScript);
        return { tmpDir, logFile };
      };

      const baseEnv = {
        ...process.env,
        CI: 'true',
        CLOUDFLARE_ACCOUNT_ID: '',
        D1_DATABASE_ID: '',
        CLOUDFLARE_D1_DATABASE_ID: '',
        DEMO_CLOUDFLARE_ACCOUNT_ID: demoAccount,
        DEMO_WORKER_NAME: 'burrow-demo',
        DEMO_D1_DATABASE_NAME: 'burrow-demo',
        DEMO_D1_DATABASE_ID: demoDbId,
        DEMO_R2_BUCKET_NAME: 'burrow-demo-files',
        BURROW_ALLOW_DEMO_RESET: 'true',
      };

      // Case 1: Full verified E2E CLI execution against isolated demo target
      {
        const { tmpDir, logFile } = createMockDemoWorkspace({
          accounts: [{ id: demoAccount, name: 'Demo Account' }],
          d1Databases: [{ uuid: demoDbId, name: 'burrow-demo' }],
          workerExists: true,
          r2Bucket: 'burrow-demo-files',
        });
        try {
          const res = spawnSync(
            process.execPath,
            [
              path.join(tmpDir, 'scripts', 'demo-reset.mjs'),
              '--remote',
              '--demo',
              '--confirm-demo-reset=RESET-DEMO-BURROW',
            ],
            { cwd: tmpDir, encoding: 'utf8', env: baseEnv },
          );
          expect(res.status, res.stderr + res.stdout).toBe(0);
          const calls = fs
            .readFileSync(logFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(calls[0].args.slice(0, 2)).toEqual(['whoami', '--json']);
          expect(calls[1].args.slice(0, 3)).toEqual(['d1', 'list', '--json']);
          expect(calls[2].args).toEqual(['deployments', 'list', '--name', 'burrow-demo', '--json']);
          expect(calls[3].args).toEqual(['r2', 'bucket', 'info', 'burrow-demo-files', '--json']);
          expect(calls.every((c) => c.accountId === demoAccount)).toBe(true);
          expect(
            calls.some((c) => c.args.includes('wrangler.demo.local.jsonc') && c.args.includes('burrow-demo')),
          ).toBe(true);
          expect(calls.some((c) => c.args.includes('burrow'))).toBe(false);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }

      // Case 2: Refuses when remote D1 UUID actually points to production DB 'burrow'
      {
        const { tmpDir, logFile } = createMockDemoWorkspace({
          accounts: [{ id: demoAccount, name: 'Demo Account' }],
          d1Databases: [
            { uuid: demoDbId, name: 'burrow' },
            { uuid: prodDbId, name: 'burrow-demo' },
          ],
          workerExists: true,
          r2Bucket: 'burrow-demo-files',
        });
        try {
          const res = spawnSync(
            process.execPath,
            [
              path.join(tmpDir, 'scripts', 'demo-reset.mjs'),
              '--remote',
              '--demo',
              '--confirm-demo-reset=RESET-DEMO-BURROW',
            ],
            { cwd: tmpDir, encoding: 'utf8', env: baseEnv },
          );
          expect(res.status).not.toBe(0);
          expect(res.stderr).toContain('Remote D1 mismatch');
          const calls = fs
            .readFileSync(logFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(calls.some((c) => c.args[0] === 'd1' && c.args[1] === 'execute')).toBe(false);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }

      // Case 3: Refuses when CI=true without --demo, making ZERO Wrangler invocations
      {
        const { tmpDir, logFile } = createMockDemoWorkspace({
          accounts: [{ id: demoAccount, name: 'Demo Account' }],
          d1Databases: [{ uuid: demoDbId, name: 'burrow-demo' }],
          workerExists: true,
          r2Bucket: 'burrow-demo-files',
        });
        try {
          const res = spawnSync(
            process.execPath,
            [
              path.join(tmpDir, 'scripts', 'demo-reset.mjs'),
              '--remote',
              '--confirm-demo-reset=RESET-DEMO-BURROW',
            ],
            { cwd: tmpDir, encoding: 'utf8', env: baseEnv },
          );
          expect(res.status).not.toBe(0);
          expect(res.stderr).toContain('without explicit --demo flag');
          expect(fs.existsSync(logFile)).toBe(false);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }

      // Case 4: Rejects wrong account, missing Worker, or missing R2 bucket before destructive SQL
      {
        expect(() =>
          verifyRemoteDemoResources({
            expectedTarget: {
              accountId: demoAccount,
              workerName: 'burrow-demo',
              databaseName: 'burrow-demo',
              databaseId: demoDbId,
              bucketName: 'burrow-demo-files',
            },
            wranglerBin: 'mock-wrangler',
            runFn: (_bin: string, args: string[]) => {
              if (args[0] === 'whoami') {
                return {
                  status: 0,
                  stdout: JSON.stringify({
                    loggedIn: true,
                    accounts: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Wrong Account' }],
                  }),
                  stderr: '',
                };
              }
              throw new Error(`Unexpected destructive call after whoami mismatch: ${args.join(' ')}`);
            },
          }),
        ).toThrow(/Cloudflare account mismatch/);
      }
    });

    it('treats native ELF binaries and process.execPath as non-scripts while running shebang scripts via node', () => {
      expect(isNodeScript(process.execPath)).toBe(false);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-script-detect-'));
      try {
        const elfBin = path.join(tmpDir, 'node');
        fs.writeFileSync(elfBin, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
        expect(isNodeScript(elfBin)).toBe(false);

        const shebangScript = path.join(tmpDir, 'tsc');
        fs.writeFileSync(shebangScript, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');
        expect(isNodeScript(shebangScript)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Cloudflare Workers Builds (WORKERS_CI) one-click deploy', () => {
    it('detects WORKERS_CI build environments accurately', () => {
      expect(isWorkersCiBuild({ WORKERS_CI: '1' })).toBe(true);
      expect(isWorkersCiBuild({ WORKERS_CI: 'true' })).toBe(true);
      expect(isWorkersCiBuild({ WORKERS_CI: '0' })).toBe(false);
      expect(isWorkersCiBuild({ CI: 'true' })).toBe(false);
      expect(isWorkersCiBuild({})).toBe(false);
    });

    it('uses wrangler.jsonc directly when database_id is present and resolves D1 UUID when absent', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-workers-ci-cfg-'));
      try {
        const provisionedArgs = resolveWorkersCiConfigArgs(
          {
            name: 'burrowgitdeploy',
            d1_databases: [
              {
                binding: 'DB',
                database_name: 'burrowgitdeploy',
                database_id: '11111111-1111-4111-8111-111111111111',
              },
            ],
          },
          { env: {}, rootDir: tmpDir, wranglerBin: 'mock-wrangler' },
        );
        expect(provisionedArgs).toEqual([]);
        expect(fs.existsSync(path.join(tmpDir, 'wrangler.local.jsonc'))).toBe(false);

        const discoveredArgs = resolveWorkersCiConfigArgs(
          {
            name: 'my-team-demo',
            d1_databases: [{ binding: 'DB', database_name: 'my-team-demo-db' }],
          },
          {
            env: {},
            rootDir: tmpDir,
            wranglerBin: 'mock-wrangler',
            runFn: () => ({
              status: 0,
              stdout: JSON.stringify([
                { name: 'my-team-demo-db', uuid: '22222222-2222-4222-8222-222222222222' },
              ]),
              stderr: '',
            }),
          },
        );
        expect(discoveredArgs).toEqual(['--config', 'wrangler.local.jsonc']);
        const generated = JSON.parse(
          fs.readFileSync(path.join(tmpDir, 'wrangler.local.jsonc'), 'utf8'),
        );
        expect(generated.name).toBe('my-team-demo');
        expect(generated.d1_databases[0].database_id).toBe('22222222-2222-4222-8222-222222222222');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('deploys cloned repos with any custom Worker name and no .github/ under WORKERS_CI=1', () => {
      for (const customWorkerName of ['burrowgitdeploy', 'acme-team-demo', 'notes-staging']) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-workers-ci-e2e-'));
        try {
          fs.cpSync(path.join(root, 'scripts'), path.join(tmpDir, 'scripts'), { recursive: true });
          fs.symlinkSync(path.join(root, 'src'), path.join(tmpDir, 'src'), 'junction');
          fs.mkdirSync(path.join(tmpDir, 'dist', 'web'), { recursive: true });
          fs.writeFileSync(path.join(tmpDir, 'dist', 'web', 'index.html'), '<!doctype html>');
          fs.writeFileSync(
            path.join(tmpDir, 'package.json'),
            JSON.stringify({ name: customWorkerName, version: '0.3.0', type: 'module' }),
          );
          fs.writeFileSync(
            path.join(tmpDir, 'wrangler.jsonc'),
            JSON.stringify(
              {
                name: customWorkerName,
                main: 'src/worker/index.ts',
                d1_databases: [
                  {
                    binding: 'DB',
                    database_name: customWorkerName,
                    database_id: '33333333-3333-4333-8333-333333333333',
                  },
                ],
                r2_buckets: [{ binding: 'FILES', bucket_name: `${customWorkerName}-files` }],
              },
              null,
              2,
            ),
          );

          const logFile = path.join(tmpDir, 'wrangler-calls.jsonl');
          const wranglerDir = path.join(tmpDir, 'node_modules', 'wrangler');
          fs.mkdirSync(path.join(wranglerDir, 'bin'), { recursive: true });
          fs.writeFileSync(
            path.join(wranglerDir, 'package.json'),
            JSON.stringify({
              name: 'wrangler',
              version: '0.0.0-mock',
              bin: { wrangler: 'bin/wrangler.mjs' },
            }),
          );
          fs.writeFileSync(
            path.join(wranglerDir, 'bin', 'wrangler.mjs'),
            `
              import fs from 'node:fs';
              fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
              process.stdout.write('Published https://${customWorkerName}.example.workers.dev\\n');
            `,
          );

          const res = spawnSync(
            process.execPath,
            [path.join(tmpDir, 'scripts', 'deploy.mjs')],
            {
              cwd: tmpDir,
              encoding: 'utf8',
              env: { ...process.env, WORKERS_CI: '1', CI: 'true' },
            },
          );

          expect(res.status, res.stderr + res.stdout).toBe(0);
          expect(res.stdout).toContain('Cloudflare Workers Builds detected (WORKERS_CI=1)');
          expect(res.stdout).toContain(`worker: ${customWorkerName}`);
          expect(res.stdout).not.toContain('scripts/check.mjs');

          const calls = fs
            .readFileSync(logFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          expect(calls).toEqual([['deploy']]);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }
    });

    it('preserves custom wrangler.jsonc bindings and package.json name during sync-upstream upgrades', () => {
      const upstreamWrangler = JSON.stringify({
        name: 'burrow',
        main: 'src/worker/index.ts',
        compatibility_date: '2026-01-01',
        d1_databases: [{ binding: 'DB', database_name: 'burrow', migrations_dir: 'migrations' }],
        r2_buckets: [{ binding: 'FILES', bucket_name: 'burrow-files' }],
      });
      const userWrangler = JSON.stringify({
        name: 'burrowgitdeploy',
        main: 'src/worker/index.ts',
        compatibility_date: '2025-01-01',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'burrowgitdeploy-db',
            database_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            migrations_dir: 'migrations',
          },
        ],
        r2_buckets: [{ binding: 'FILES', bucket_name: 'burrowgitdeploy-files' }],
      });

      const mergedWrangler = JSON.parse(
        mergePreservedWranglerConfig(upstreamWrangler, userWrangler),
      );
      expect(mergedWrangler.name).toBe('burrowgitdeploy');
      expect(mergedWrangler.compatibility_date).toBe('2026-01-01');
      expect(mergedWrangler.d1_databases[0].database_id).toBe(
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      );
      expect(mergedWrangler.r2_buckets[0].bucket_name).toBe('burrowgitdeploy-files');

      const upstreamPkg = '{\n  "name": "burrow",\n  "version": "0.4.0"\n}\n';
      const mergedPkg = JSON.parse(mergePreservedPackageName(upstreamPkg, 'burrowgitdeploy'));
      expect(mergedPkg.name).toBe('burrowgitdeploy');
      expect(mergedPkg.version).toBe('0.4.0');
    });

    it('builds @burrow/sdk when packages/sdk/dist/index.js is missing on a fresh clone', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-sdk-build-'));
      try {
        fs.mkdirSync(path.join(tmpDir, 'packages', 'sdk'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'packages', 'sdk', 'tsconfig.build.json'), '{}');
        const calls: Array<{ cmd: string; args: string[] }> = [];
        const built = ensureSdkBuilt({
          rootDir: tmpDir,
          runFn: (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            return { status: 0, stdout: '', stderr: '' };
          },
        });
        expect(built).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args[0]).toBe('-p');
        expect(calls[0]?.args[1]).toContain('tsconfig.build.json');

        fs.mkdirSync(path.join(tmpDir, 'packages', 'sdk', 'dist'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'packages', 'sdk', 'dist', 'index.js'), 'export {};\n');
        expect(ensureSdkBuilt({ rootDir: tmpDir })).toBe(false);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('keeps scripts/sync-upstream.mjs zero-dependency (node:* built-ins only)', () => {
      const syncSource = fs.readFileSync(path.join(root, 'scripts', 'sync-upstream.mjs'), 'utf8');
      const imports = [...syncSource.matchAll(/^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm)].map(
        (m) => m[1],
      );
      expect(imports.length).toBeGreaterThan(0);
      for (const spec of imports) {
        expect(spec).toMatch(/^node:/);
      }
    });
  });
});
