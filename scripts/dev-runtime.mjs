import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { resolveLocalPaths } from '../src/server/database-target.ts';
import { bin, getBootstrapToken, loadEnv, root, run } from './lib.mjs';

/** Start the shared development lifecycle with its Node or Worker backend. */
export function startDev(runtime) {
  loadEnv();
  const env = process.env;
  const auth = {
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET || 'dev-secret-change-me-32-bytes-minimum!!',
    BETTER_AUTH_URL: env.BETTER_AUTH_URL || 'http://localhost:3005',
    BOOTSTRAP_TOKEN: getBootstrapToken(env),
  };
  const { sqlitePath, storagePath } = resolveLocalPaths(root, env);

  if (runtime === 'worker') {
    console.log('==> Ensuring local D1 migrations are applied (--persist-to ./data)');
    run(
      bin('wrangler'),
      ['d1', 'migrations', 'apply', 'burrow', '--local', '--persist-to', './data'],
      {
        env: { CI: '1' },
      },
    );
  }

  const index = path.join(root, 'dist', 'web', 'index.html');
  if (!fs.existsSync(index)) {
    fs.mkdirSync(path.dirname(index), { recursive: true });
    fs.writeFileSync(
      index,
      '<!doctype html><html><body><p>Run <code>pnpm build</code> for the production bundle; use http://localhost:3005 in dev.</p></body></html>',
    );
  }

  const children = [];
  let shuttingDown = false;
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nStopping dev servers...');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    for (const child of children) {
      if (!child.pid) continue;
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          process.kill(child.pid, 'SIGTERM');
        }
      } catch {
        // A process may have exited before cleanup.
      }
    }
    process.exit(code);
  }
  function launch(label, args, childEnv = env) {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
      env: childEnv,
    });
    children.push(child);
    child.on('exit', (code) => {
      console.log(`${label} exited (${code})`);
      shutdown(code ?? 0);
    });
    child.on('error', (error) => {
      console.error(`${label} failed to start:`, error);
      shutdown(1);
    });
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (key === '\u0003' || key.toLowerCase() === 'q') shutdown(0);
    });
  }

  console.log(
    [
      '\n======================================================',
      `Burrow Local Development (${runtime === 'node' ? 'Node + SQLite/PostgreSQL' : 'Cloudflare Worker + Miniflare'})`,
      `  Web App (Vite):     ${auth.BETTER_AUTH_URL}`,
      '  Backend API:        http://127.0.0.1:8787',
      ...(runtime === 'node'
        ? [
            `  Database:           ${env.DATABASE_URL ? 'Configured by DATABASE_URL' : sqlitePath}`,
            `  Uploads:            ${storagePath}`,
          ]
        : ['  Miniflare State:    ./data']),
      `  BOOTSTRAP_TOKEN:    ${auth.BOOTSTRAP_TOKEN}`,
      `  Email Delivery:     ${env.RESEND_API_KEY ? `Resend (${env.EMAIL_FROM || 'default'})` : 'Console log fallback'}`,
      '======================================================',
      'Press Ctrl+C or "q" at any time to stop\n',
    ].join('\n'),
  );

  if (runtime === 'node') {
    console.log('==> Ensuring server bundle is compiled (dist/server.mjs)');
    run('pnpm', [
      'exec',
      'esbuild',
      'src/server/index.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--outfile=dist/server.mjs',
      '--packages=external',
    ]);
    launch('server', [path.join(root, 'dist', 'server.mjs')], {
      ...env,
      ...auth,
      PORT: '8787',
      SQLITE_PATH: sqlitePath,
      LOCAL_STORAGE_PATH: storagePath,
    });
  } else {
    const bindings = { ...auth, RESEND_API_KEY: env.RESEND_API_KEY, EMAIL_FROM: env.EMAIL_FROM };
    const variables = Object.entries(bindings)
      .filter(([, value]) => value)
      .flatMap(([key, value]) => ['--var', `${key}:${value}`]);
    launch('wrangler', [
      bin('wrangler'),
      'dev',
      '--port',
      '8787',
      '--persist-to',
      './data',
      '--show-interactive-dev-session=false',
      ...variables,
    ]);
  }
  launch('vite', [bin('vite'), '--port', '3005', '--strictPort', '--clearScreen', 'false']);
}
