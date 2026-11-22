import type { PluginManifest } from '@burrow/sdk';

export class PluginNetworkAccessError extends Error {
  constructor(
    public readonly pluginId: string,
    message: string,
  ) {
    super(`Plugin "${pluginId}" network access denied: ${message}`);
    this.name = 'PluginNetworkAccessError';
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  /** Optional DNS lookup resolver (injected in Node environments to block DNS rebinding). */
  resolveHostIps?: (hostname: string) => Promise<string[]>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0] ?? '';
  if (!ip) return true;

  // IPv4 checks
  const ipv4 = parseIpv4Octets(ip);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 192 && b === 0 && ipv4[2] === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 0 && ipv4[2] === 2) return true; // TEST-NET-1
    if (a >= 224) return true; // multicast & reserved 240/4
    return false;
  }

  // IPv6 checks
  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
    if (ip.startsWith('::ffff:')) {
      const tail = ip.slice('::ffff:'.length);
      if (parseIpv4Octets(tail)) {
        return isBlockedIpAddress(tail);
      }
      const hexParts = tail.split(':');
      if (hexParts.length === 2) {
        const hi = Number.parseInt(hexParts[0]!, 16);
        const lo = Number.parseInt(hexParts[1]!, 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
          const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          return isBlockedIpAddress(mapped);
        }
      }
      return true;
    }
    const firstWord = ip.split(':')[0] || '0';
    const val = Number.parseInt(firstWord, 16);
    if (!Number.isNaN(val)) {
      if ((val & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
      if ((val & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
      if ((val & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    }
  }

  return false;
}

export function isBlockedHostname(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.nip.io') ||
    host.endsWith('.sslip.io') ||
    host.endsWith('.xip.io')
  ) {
    return true;
  }
  // Reject raw integer/hex/octal IP representations (e.g. 2130706433, 0x7f000001)
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(host)) {
    return true;
  }
  return isBlockedIpAddress(host);
}

async function defaultResolveHostIps(hostname: string): Promise<string[]> {
  try {
    // Dynamic import keeps Worker runtime clean when node:dns is unavailable
    const dns = await import('node:dns/promises');
    const records = await dns.lookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

async function validateTargetUrl(
  pluginId: string,
  url: URL,
  allowedHosts: ReadonlySet<string>,
  resolveHostIps: (hostname: string) => Promise<string[]>,
): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PluginNetworkAccessError(pluginId, `unsupported protocol "${url.protocol}"`);
  }
  if (url.username || url.password) {
    throw new PluginNetworkAccessError(pluginId, 'URL credentials are disallowed');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isBlockedHostname(hostname)) {
    throw new PluginNetworkAccessError(pluginId, `target host "${hostname}" is blocked (private/loopback/metadata)`);
  }
  if (!allowedHosts.has(hostname)) {
    throw new PluginNetworkAccessError(
      pluginId,
      `host "${hostname}" is not declared in manifest.network allowlist`,
    );
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new PluginNetworkAccessError(pluginId, `port "${url.port}" is not permitted`);
  }

  const ips = await resolveHostIps(hostname);
  for (const ip of ips) {
    if (isBlockedIpAddress(ip)) {
      throw new PluginNetworkAccessError(
        pluginId,
        `host "${hostname}" resolved to blocked IP address "${ip}"`,
      );
    }
  }
}

async function readBodyCapped(
  pluginId: string,
  res: Response,
  maxBytes: number,
): Promise<Response> {
  const cl = res.headers.get('content-length');
  if (cl) {
    const parsed = Number.parseInt(cl, 10);
    if (!Number.isNaN(parsed) && parsed > maxBytes) {
      throw new PluginNetworkAccessError(
        pluginId,
        `response exceeds max size of ${maxBytes} bytes`,
      );
    }
  }
  if (!res.body) return res;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new PluginNetworkAccessError(
          pluginId,
          `response exceeds max size of ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Response(combined, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * Builds an SSRF-hardened `fetch` wrapper restricted to `manifest.network`,
 * validating initial and redirect targets against private/metadata ranges,
 * enforcing timeouts, and capping response body sizes.
 */
export function createPluginFetch(
  manifest: PluginManifest,
  options: SafeFetchOptions = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const allowedHosts = new Set((manifest.network ?? []).map((h) => h.trim().toLowerCase()));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const resolveHostIps = options.resolveHostIps ?? defaultResolveHostIps;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const initialUrlStr = input instanceof Request ? input.url : String(input);
    let currentUrl: URL;
    try {
      currentUrl = new URL(initialUrlStr);
    } catch {
      throw new PluginNetworkAccessError(manifest.id, `invalid URL "${initialUrlStr}"`);
    }

    let currentMethod = init?.method ?? (input instanceof Request ? input.method : 'GET');
    let currentBody = init?.body;
    const baseHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);

    for (let hop = 0; hop <= maxRedirects; hop++) {
      await validateTargetUrl(manifest.id, currentUrl, allowedHosts, resolveHostIps);

      const res = await fetchImpl(currentUrl.toString(), {
        ...init,
        method: currentMethod,
        body: currentBody,
        headers: baseHeaders,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) {
          throw new PluginNetworkAccessError(manifest.id, 'redirect response missing Location header');
        }
        if (hop === maxRedirects) {
          throw new PluginNetworkAccessError(manifest.id, `exceeded max redirects (${maxRedirects})`);
        }
        currentUrl = new URL(location, currentUrl);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = undefined;
        }
        continue;
      }

      return readBodyCapped(manifest.id, res, maxBytes);
    }

    throw new PluginNetworkAccessError(manifest.id, 'redirect loop aborted');
  };
}
