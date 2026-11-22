import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(import.meta.dirname),
  resolve: {
    alias: {
      '@burrow/sdk': path.resolve(import.meta.dirname, 'packages/sdk/src/index.ts'),
      '@burrow/core': path.resolve(import.meta.dirname, 'packages/core/src/index.ts'),
      '@burrow/web': path.resolve(import.meta.dirname, 'packages/web/src/index.ts'),
      '@burrow/worker': path.resolve(import.meta.dirname, 'packages/worker/src/index.ts'),
      '@burrow/plugins': path.resolve(import.meta.dirname, 'packages/plugins/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 3005,
    fs: {
      deny: [
        '.env',
        '.env.*',
        '.dev.vars',
        '.dev.vars.*',
        '*.local*',
        '.secrets*',
        'data/**',
        'src/server/**',
        'src/worker/**',
        'scripts/**',
      ],
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
});
