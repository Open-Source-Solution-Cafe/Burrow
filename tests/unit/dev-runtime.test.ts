import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  fs: { existsSync: vi.fn(), mkdirSync: vi.fn(), writeFileSync: vi.fn() },
  process: {
    env: {} as Record<string, string | undefined>,
    execPath: '/node',
    platform: 'linux',
    on: vi.fn(),
    kill: vi.fn(),
    exit: vi.fn(),
    stdin: {
      isTTY: false,
      setRawMode: vi.fn(),
      resume: vi.fn(),
      setEncoding: vi.fn(),
      on: vi.fn(),
    },
  },
  lib: {
    root: '/repo/burrow',
    bin: vi.fn((name: string) => `/bin/${name}`),
    getBootstrapToken: vi.fn(() => 'test-bootstrap'),
    loadEnv: vi.fn(),
    run: vi.fn(),
  },
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock('node:fs', () => ({ default: mocks.fs }));
vi.mock('node:process', () => ({ default: mocks.process }));
vi.mock('../../scripts/lib.mjs', () => mocks.lib);

// The production entrypoint is JavaScript, so keep it outside TS's declaration graph.
const modulePath = '../../scripts/dev-runtime.mjs';
const { startDev } = await import(modulePath);
const children: Array<{ pid: number; on: ReturnType<typeof vi.fn> }> = [];
const listener = (mock: ReturnType<typeof vi.fn>, event: string) =>
  mock.mock.calls.find(([name]) => name === event)?.[1] as (...args: unknown[]) => void;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.process.env = {};
  mocks.process.platform = 'linux';
  mocks.process.stdin.isTTY = false;
  mocks.fs.existsSync.mockReturnValue(false);
  mocks.lib.run.mockImplementation(() => undefined);
  children.length = 0;
  mocks.spawn.mockImplementation(() => {
    const child = { pid: 100 + children.length, on: vi.fn() };
    children.push(child);
    return child;
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('Shared development runtime', () => {
  it('launches the Node backend and Vite with default auth, ports and database paths', () => {
    startDev('node');
    expect(mocks.lib.loadEnv).toHaveBeenCalledOnce();
    expect(mocks.lib.run).toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['esbuild', 'src/server/index.ts', '--outfile=dist/server.mjs']),
    );
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      1,
      '/node',
      [path.join(mocks.lib.root, 'dist', 'server.mjs')],
      {
        cwd: mocks.lib.root,
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: false,
        env: expect.objectContaining({
          PORT: '8787',
          SQLITE_PATH: path.resolve(mocks.lib.root, 'data/burrow.db'),
          LOCAL_STORAGE_PATH: path.resolve(mocks.lib.root, 'data/uploads'),
          BETTER_AUTH_SECRET: 'dev-secret-change-me-32-bytes-minimum!!',
          BETTER_AUTH_URL: 'http://localhost:3005',
          BOOTSTRAP_TOKEN: 'test-bootstrap',
        }),
      },
    );
    expect(mocks.spawn).toHaveBeenNthCalledWith(
      2,
      '/node',
      ['/bin/vite', '--port', '3005', '--strictPort', '--clearScreen', 'false'],
      expect.objectContaining({ env: mocks.process.env }),
    );
    expect(mocks.fs.writeFileSync).toHaveBeenCalledOnce();
  });

  it('preserves configured Node paths and inherited PostgreSQL/storage settings', () => {
    mocks.process.env = {
      SQLITE_PATH: './scratch/custom.db',
      LOCAL_STORAGE_PATH: './scratch/files',
      DATABASE_URL: 'postgres://configured-server/db',
      S3_BUCKET: 'configured-bucket',
      BETTER_AUTH_SECRET: 'configured-secret',
      BETTER_AUTH_URL: 'http://localhost:3005/custom',
    };
    startDev('node');
    expect(mocks.spawn.mock.calls[0]?.[2].env).toEqual(
      expect.objectContaining({
        ...mocks.process.env,
        SQLITE_PATH: path.resolve(mocks.lib.root, 'scratch/custom.db'),
        LOCAL_STORAGE_PATH: path.resolve(mocks.lib.root, 'scratch/files'),
      }),
    );
  });

  it('migrates Worker persistence before launching Wrangler and forwards configured bindings', () => {
    mocks.process.env = {
      BETTER_AUTH_SECRET: 'configured-secret',
      BETTER_AUTH_URL: 'https://dev.example.test',
      RESEND_API_KEY: 'test-email-key',
      EMAIL_FROM: 'Test <test@example.test>',
    };
    startDev('worker');
    expect(mocks.lib.run).toHaveBeenCalledOnce();
    expect(mocks.lib.run).toHaveBeenCalledWith(
      '/bin/wrangler',
      ['d1', 'migrations', 'apply', 'burrow', '--local', '--persist-to', './data'],
      { env: { CI: '1' } },
    );
    expect(mocks.lib.run.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spawn.mock.invocationCallOrder[0]!,
    );
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual([
      '/bin/wrangler',
      'dev',
      '--port',
      '8787',
      '--persist-to',
      './data',
      '--show-interactive-dev-session=false',
      '--var',
      'BETTER_AUTH_SECRET:configured-secret',
      '--var',
      'BETTER_AUTH_URL:https://dev.example.test',
      '--var',
      'BOOTSTRAP_TOKEN:test-bootstrap',
      '--var',
      'RESEND_API_KEY:test-email-key',
      '--var',
      'EMAIL_FROM:Test <test@example.test>',
    ]);
  });

  it('does not overwrite an existing frontend bundle or pass absent optional bindings', () => {
    mocks.fs.existsSync.mockReturnValue(true);
    startDev('worker');
    expect(mocks.fs.mkdirSync).not.toHaveBeenCalled();
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled();
    expect(mocks.spawn.mock.calls[0]?.[1].join(' ')).not.toContain('undefined');
    expect(mocks.spawn.mock.calls[0]?.[1].join(' ')).not.toContain('RESEND_API_KEY');
  });

  it.each(['linux', 'win32'])('stops both children once when a child exits on %s', (platform) => {
    mocks.process.platform = platform;
    startDev('node');
    listener(children[0]!.on, 'exit')(7);
    listener(mocks.process.on, 'SIGINT')();
    expect(mocks.process.exit).toHaveBeenCalledExactlyOnceWith(7);
    if (platform === 'win32') {
      expect(mocks.spawnSync.mock.calls.map(([, args]) => args)).toEqual([
        ['/pid', '100', '/T', '/F'],
        ['/pid', '101', '/T', '/F'],
      ]);
    } else {
      expect(mocks.process.kill.mock.calls).toEqual([
        [100, 'SIGTERM'],
        [101, 'SIGTERM'],
      ]);
    }
  });

  it('surfaces a child launch error and shuts down its sibling', () => {
    startDev('worker');
    const error = new Error('backend unavailable');
    listener(children[0]!.on, 'error')(error);
    expect(console.error).toHaveBeenCalledWith('wrangler failed to start:', error);
    expect(mocks.process.kill).toHaveBeenCalledWith(101, 'SIGTERM');
    expect(mocks.process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it.each(['q', 'Q', '\u0003'])('stops cleanly from a TTY with %j', (key) => {
    mocks.process.stdin.isTTY = true;
    startDev('node');
    listener(mocks.process.stdin.on, 'data')(key);
    expect(mocks.process.stdin.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(mocks.process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('launches nothing when Worker migration preparation fails', () => {
    mocks.lib.run.mockImplementation(() => {
      throw new Error('migration failed');
    });
    expect(() => startDev('worker')).toThrow('migration failed');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.fs.writeFileSync).not.toHaveBeenCalled();
  });
});
