import path from 'node:path';
import { defineConfig } from 'vitest/config';

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
    name: 'redteam',
    environment: 'node',
    include: ['tests/redteam/**/*.test.ts'],
    globalSetup: ['./tests/adapters/node-setup.ts'],
    testTimeout: 25_000,
    hookTimeout: 30_000,
  },
});
