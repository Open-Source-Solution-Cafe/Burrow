import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverPath = path.join(root, 'dist', 'server.mjs');

describe('Server CLI --migrate', () => {
  it('runs SQLite migrations and exits cleanly with code 0', () => {
    // Only run if dist/server.mjs exists (after build)
    if (!fs.existsSync(serverPath)) {
      return;
    }

    const tmpDbPath = path.join(os.tmpdir(), `burrow-migrate-test-${Date.now()}.db`);
    try {
      const res = spawnSync(process.execPath, [serverPath, '--migrate'], {
        cwd: root,
        env: {
          ...process.env,
          SQLITE_PATH: tmpDbPath,
          DATABASE_URL: '',
        },
        encoding: 'utf8',
      });

      expect(res.status).toBe(0);
      expect(fs.existsSync(tmpDbPath)).toBe(true);
      expect(res.stderr || res.stdout).toContain('Migrations applied successfully');
    } finally {
      try {
        if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
      } catch {
        // cleanup
      }
    }
  });

  it('exits with code 1 on database connection failure', () => {
    if (!fs.existsSync(serverPath)) {
      return;
    }

    const res = spawnSync(process.execPath, [serverPath, '--migrate'], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://baduser:badpass@127.0.0.1:54329/baddb',
      },
      encoding: 'utf8',
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Migration failed');
  });
});
