import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@burrow/sdk';
import { LocalStorageAdapter } from '../../src/core/adapters/storage/local';
import { PluginEventBus, runWithEventExecutionContext } from '../../src/core/plugins/event-bus';
import {
  PluginStorageError,
  createPluginStorage,
  sanitizePluginStorageKey,
} from '../../src/core/plugins/plugin-storage';
import {
  PluginNetworkAccessError,
  createPluginFetch,
  isBlockedIpAddress,
} from '../../src/core/plugins/safe-fetch';

const tmpDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-redteam-stor-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const baseManifest: PluginManifest = {
  id: 'net-test',
  version: '0.1.0',
  sdkVersion: '^0.4.0',
  permissions: [],
  network: ['api.allowed.example', 'cdn.allowed.example'],
};

describe('Category 5, 8, 9 — SSRF/Egress, Storage & Event Bus', () => {
  describe('Category 5 — SSRF & Egress', () => {
    it('blocks non-collapsed IPv6 loopback, zero-padded IPv4-mapped IPv6, IPv4-compatible IPv6, and NAT64 metadata forms', async () => {
      const evilIps = [
        '0:0:0:0:0:0:0:1',
        '0000:0000:0000:0000:0000:0000:0000:0001',
        '0:0:0:0:0:ffff:127.0.0.1',
        '0:0:0:0:0:ffff:7f00:1',
        '0:0:0:0:0:ffff:169.254.169.254',
        '::127.0.0.1',
        '64:ff9b::169.254.169.254',
        '64:ff9b::127.0.0.1',
      ];

      for (const ip of evilIps) {
        expect(isBlockedIpAddress(ip), `Expected ${ip} to be blocked`).toBe(true);
      }

      const fetchImpl = vi.fn().mockResolvedValue(new Response('secret'));
      const safeFetch = createPluginFetch(baseManifest, {
        fetchImpl,
        resolveHostIps: async () => ['0:0:0:0:0:ffff:169.254.169.254'],
      });

      await expect(safeFetch('https://api.allowed.example/meta')).rejects.toThrow(
        PluginNetworkAccessError,
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('fails closed when DNS resolution returns empty results (e.g. Worker runtime without node:dns)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response('ok'));
      const safeFetch = createPluginFetch(baseManifest, {
        fetchImpl,
        resolveHostIps: async () => [],
      });

      await expect(safeFetch('https://api.allowed.example/data')).rejects.toThrow(
        PluginNetworkAccessError,
      );
    });

    it('blocks DNS rebinding where first lookup returns public IP and second lookup returns loopback', async () => {
      // Simulate TOCTOU DNS rebinding where initial lookup returns public IP and second lookup returns loopback
      let lookupCount = 0;
      const fetchImpl = vi.fn().mockImplementation(async () => new Response('ok'));
      const safeFetch = createPluginFetch(baseManifest, {
        fetchImpl,
        resolveHostIps: async () => {
          lookupCount++;
          return lookupCount === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
        },
      });

      await expect(safeFetch('https://api.allowed.example/rebind')).rejects.toThrow(
        PluginNetworkAccessError,
      );
    });

    it('strips Authorization/Cookie headers across cross-origin redirects between allowlisted hosts', async () => {
      const forwardedHeaders: Array<Record<string, string>> = [];
      const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        const hdrs = new Headers(init?.headers);
        forwardedHeaders.push({
          url,
          authorization: hdrs.get('authorization') ?? '',
        });
        if (url.startsWith('https://api.allowed.example')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.allowed.example/steal' },
          });
        }
        return new Response('done');
      });

      const safeFetch = createPluginFetch(baseManifest, {
        fetchImpl,
        resolveHostIps: async () => ['93.184.216.34'],
      });

      await safeFetch('https://api.allowed.example/start', {
        headers: { Authorization: 'Bearer top-secret-token' },
      });

      expect(forwardedHeaders[1]?.authorization).toBe('');
    });

    it('blocks non-http schemes, userinfo, non-standard ports, unallowlisted hosts, decimal/octal/hex IPs, localhost/internal, redirects to internal hosts, and oversized bodies', async () => {
      const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/redir-internal')) {
          return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
        }
        if (url.includes('/huge')) {
          return new Response(new Uint8Array(1024 * 64), { status: 200 });
        }
        return new Response('ok');
      });

      const safeFetch = createPluginFetch(baseManifest, {
        fetchImpl,
        resolveHostIps: async () => ['93.184.216.34'],
        maxResponseBytes: 1024,
      });

      await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('gopher://api.allowed.example:70/1')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('https://user:pass@api.allowed.example/')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('https://api.allowed.example:8443/')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('https://not-in-allowlist.example/')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('http://2130706433/')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('http://0177.0.0.1/')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('http://0x7f000001/')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('http://localhost/')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('http://metadata.google.internal/')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('https://api.allowed.example/redir-internal')).rejects.toThrow(PluginNetworkAccessError);
      await expect(safeFetch('https://api.allowed.example/huge')).rejects.toThrow(PluginNetworkAccessError);
    });
  });

  describe('Category 8 — Storage Isolation, Traversal, MIME & Quotas', () => {
    it('prevents an .svg payload uploaded as image/png from resolving as image/svg+xml after adapter restart', async () => {
      const dir = makeTempDir();
      const adapter1 = new LocalStorageAdapter(dir);
      const storage1 = createPluginStorage('xss-plug', adapter1);
      await expect(
        storage1.put('badge.svg', '<svg onload="alert(1)"></svg>', 'image/png'),
      ).rejects.toThrow(PluginStorageError);

      // Even if a legacy .svg object already exists on disk, simulate adapter restart and verify safe Content-Type fallback
      await adapter1.put(
        'plugins/xss-plug/badge.svg',
        new TextEncoder().encode('<svg onload="alert(1)"></svg>'),
        'image/png',
      );
      const adapter2 = new LocalStorageAdapter(dir);
      const storage2 = createPluginStorage('xss-plug', adapter2);
      const obj = await storage2.get('badge.svg');
      expect(obj?.contentType).not.toBe('image/svg+xml');
    });

    it('rejects symlinks inside LocalStorageAdapter directories so host files cannot be read or overwritten', async () => {
      const dir = makeTempDir();
      const outsideSecret = path.join(dir, 'outside-secret.txt');
      fs.writeFileSync(outsideSecret, 'TOP-SECRET-HOST-FILE');

      const root = path.join(dir, 'uploads');
      const pluginDir = path.join(root, 'plugins', 'sym');
      fs.mkdirSync(pluginDir, { recursive: true });
      const linkPath = path.join(pluginDir, 'leak.txt');
      try {
        fs.symlinkSync(outsideSecret, linkPath);
      } catch {
        // On Windows without Developer Mode/admin symlink privileges, skip symlink creation gracefully
        return;
      }

      const adapter = new LocalStorageAdapter(root);
      const storage = createPluginStorage('sym', adapter);
      await expect(storage.get('leak.txt')).rejects.toThrow();
    });

    it('enforces a total per-plugin storage quota across multiple put() calls', async () => {
      const dir = makeTempDir();
      const adapter = new LocalStorageAdapter(dir);
      const storage = createPluginStorage('flood', adapter, { maxUploadBytes: 1024 });
      let quotaRejected = false;
      for (let i = 0; i < 20; i++) {
        try {
          await storage.put(`chunk-${i}.bin`, new Uint8Array(1024));
        } catch (err) {
          if (err instanceof PluginStorageError) {
            quotaRejected = true;
            break;
          }
          throw err;
        }
      }
      expect(quotaRejected).toBe(true);
      const listed = await storage.list();
      expect(listed.length).toBeLessThan(20);
    });

    it('blocks traversal, double-encoding, null bytes, absolute paths, blocked MIME types, oversized uploads, and cross-plugin reads', async () => {
      const dir = makeTempDir();
      const adapter = new LocalStorageAdapter(path.join(dir, 'uploads'));
      const storeA = createPluginStorage('plug-a', adapter, { maxUploadBytes: 64 });
      const storeB = createPluginStorage('plug-b', adapter, { maxUploadBytes: 64 });

      await storeB.put('secret.txt', 'plugin-b-only', 'text/plain');
      expect(await storeA.list()).toEqual([]);
      expect(await storeA.get('secret.txt')).toBeNull();

      for (const badKey of [
        '../plug-b/secret.txt',
        '%2e%2e/plug-b/secret.txt',
        '/etc/passwd',
        'C:\\Windows\\win.ini',
        'foo\\..\\bar',
        'a\0b.txt',
        './a.txt',
        'a//b.txt',
      ]) {
        expect(() => sanitizePluginStorageKey('plug-a', badKey)).toThrow(PluginStorageError);
      }

      await expect(storeA.put('x.html', '<b>hi</b>', 'text/html')).rejects.toThrow(PluginStorageError);
      await expect(storeA.put('x.svg', '<svg/>', 'image/svg+xml')).rejects.toThrow(PluginStorageError);
      await expect(storeA.put('x.js', 'alert(1)', 'application/javascript')).rejects.toThrow(PluginStorageError);
      await expect(storeA.put('big.bin', new Uint8Array(128))).rejects.toThrow(PluginStorageError);
    });
  });

  describe('Category 9 — Event Bus Isolation, Payload Immutability & Timeouts', () => {
    it('prevents an untrusted plugin from mutating shared event payloads to poison account.export or sibling emitAfter listeners', async () => {
      const bus = new PluginEventBus();
      let siblingSeenUserId = '';

      bus.on('workspace.created', (payload) => {
        (payload as any).userId = 'hijacked-user';
      });
      bus.on('workspace.created', (payload) => {
        siblingSeenUserId = payload.userId;
      });

      await runWithEventExecutionContext({}, async () => {
        await bus.emitAfter('workspace.created', {
          workspaceId: 'ws1',
          userId: 'real-user',
          name: 'Test',
        });
        await bus.flushPending();
      });

      expect(siblingSeenUserId).toBe('real-user');

      // Also check account.export payload tampering via onBefore
      bus.onBefore('account.export', (evt) => {
        (evt.payload as any).user = { id: 'spoofed' };
      });
      const exportPayload: Record<string, unknown> = { user: { id: 'real-user' } };
      await bus.emitBefore('account.export', {
        userId: 'real-user',
        workspaceId: null,
        payload: exportPayload,
      });
      expect((exportPayload.user as { id: string }).id).toBe('real-user');
    });

    it('rejects hanging before* handlers after timeout and isolates throwing after* handlers', async () => {
      const bus = new PluginEventBus();
      bus.onBefore(
        'task.created',
        () => new Promise<void>(() => {}),
        { pluginId: 'hang-before', timeoutMs: 30 },
      );

      await expect(
        bus.emitBefore('task.created', {
          workspaceId: 'ws1',
          projectId: 'p1',
          boardId: 'b1',
          columnId: 'c1',
          cardId: 'card1',
          notepadId: 'np1',
          title: 'Test',
          actorId: 'u1',
        }),
      ).rejects.toThrow(/timed out/i);

      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let healthyRan = false;
      try {
        bus.on('task.updated', () => {
          throw new Error('after handler crash');
        }, { pluginId: 'crash-after' });
        bus.on('task.updated', () => {
          healthyRan = true;
        }, { pluginId: 'healthy-after' });

        await bus.emitAfter('task.updated', {
          workspaceId: 'ws1',
          projectId: 'p1',
          cardId: 'card1',
          actorId: 'u1',
        });
        await bus.flushPending();
        expect(healthyRan).toBe(true);
      } finally {
        errSpy.mockRestore();
      }
    });
  });
});
