import fs from 'node:fs';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Miniflare validates the assets directory from wrangler.jsonc at startup;
// create a placeholder so `pnpm check` works before the first `pnpm build`.
const assetsDir = path.resolve('dist/web');
fs.mkdirSync(assetsDir, { recursive: true });
const indexPath = path.join(assetsDir, 'index.html');
if (!fs.existsSync(indexPath)) {
  fs.writeFileSync(indexPath, '<!doctype html><title>burrow</title>');
}

// Migrations are read here (Node has filesystem access; the Workers runtime
// does not) and handed to tests/api/setup.ts as a binding for applyD1Migrations.
const TEST_MIGRATIONS = await readD1Migrations('./migrations');
const sqliteOnly = process.env.BURROW_TEST_SQLITE_ONLY === '1';

export default defineConfig({
  resolve: {
    alias: {
      '@burrow/sdk': path.resolve(import.meta.dirname, 'packages/sdk/src/index.ts'),
      '@burrow/core': path.resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@burrow/web': path.resolve(import.meta.dirname, 'packages/web/src/index.ts'),
      '@burrow/worker': path.resolve(import.meta.dirname, 'packages/worker/src/index.ts'),
      '@burrow/plugins': path.resolve(import.meta.dirname, 'packages/plugins/src/index.ts'),
    },
  },
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Bound expensive workerd startups instead of starving active API tests.
    maxWorkers: 4,
    exclude: ['tests/e2e/**'],
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS,
                BETTER_AUTH_SECRET: 'test-better-auth-secret-32-bytes-minimum!!',
                BETTER_AUTH_URL: 'http://localhost:8787',
                RESEND_API_KEY: '',
                EMAIL_FROM: 'Burrow Tests <noreply@burrow.test>',
                BOOTSTRAP_TOKEN: 'test-bootstrap-token',
                GOOGLE_CLIENT_ID: '',
                GOOGLE_CLIENT_SECRET: '',
                GITHUB_CLIENT_ID: '',
                GITHUB_CLIENT_SECRET: '',
                SELF_UPDATE_WEBHOOK_URL: '',
                TRUST_PROXY: '',
                TRUSTED_PROXIES: '',
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          testTimeout: 25_000,
          hookTimeout: 25_000,
          include: ['tests/api/**/*.test.ts', 'tests/adapters/**/*.contract.test.ts'],
          setupFiles: ['./tests/api/setup.ts'],
        },
      },
      {
        test: {
          name: 'unit',
          testTimeout: 25_000,
          hookTimeout: 25_000,
          include: [
            'tests/unit/**/*.test.ts',
            'tests/adapters/storage-local.test.ts',
            'src/web/**/*.test.ts',
            'src/core/**/*.test.ts',
            'src/shared/**/*.test.ts',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'database',
          include: ['tests/adapters/*-node.test.ts'],
          environment: 'node',
          globalSetup: sqliteOnly ? [] : ['./tests/adapters/node-setup.ts'],
          ...(sqliteOnly ? { testNamePattern: 'sqlite' } : {}),
          testTimeout: 25_000,
          hookTimeout: 30_000,
        },
      },
    ].filter((project) => !sqliteOnly || project.test.name !== 'worker'),
  },
});
