import type { PluginManifest } from '@burrow/sdk';
import ipaddr from 'ipaddr.js';

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
  /** Optional Node http/https Agent (used by Node socket-pinned transport, e.g. deterministic lookup tests). */
  nodeAgent?: unknown;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function isEmbeddedIpv4Blocked(hi: number, lo: number): boolean {
  const v4 = new ipaddr.IPv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
  return v4.range() !== 'unicast';
}

export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, '').trim().split('%')[0] ?? '';
  if (!ip) return true;

  try {
    if (!ipaddr.isValid(ip)) return true;
    const parsed = ipaddr.parse(ip);
    if (parsed.kind() === 'ipv4') {
      return parsed.range() !== 'unicast';
    }
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return v6.toIPv4Address().range() !== 'unicast';
    }
    const parts = v6.parts;
    // IPv4-compatible IPv6 (::/96 -> 0:0:0:0:0:0:x:y)
    if (
      parts[0] === 0 &&
      parts[1] === 0 &&
      parts[2] === 0 &&
      parts[3] === 0 &&
      parts[4] === 0 &&
      parts[5] === 0
    ) {
      if (parts[6] === 0 && (parts[7] === 0 || parts[7] === 1)) return true;
      return isEmbeddedIpv4Blocked(parts[6]!, parts[7]!);
    }
    // NAT64 well-known prefix (64:ff9b::/96)
    if (
      parts[0] === 0x0064 &&
      parts[1] === 0xff9b &&
      parts[2] === 0 &&
      parts[3] === 0 &&
      parts[4] === 0 &&
      parts[5] === 0
    ) {
      return isEmbeddedIpv4Blocked(parts[6]!, parts[7]!);
    }
    return v6.range() !== 'unicast';
  } catch {
    return true;
  }
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
  // Reject raw integer/hex/octal IP representations (e.g. 2130706433, 0x7f000001, 0177.0.0.1)
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)(?:\.(?:0x[0-9a-f]+|0[0-7]+|\d+))*$/i.test(host)) {
    return true;
  }
  if (host.includes(':') || ipaddr.isValid(host)) {
    return isBlockedIpAddress(host);
  }
  return false;
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
): Promise<string> {
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
  if (!ips || ips.length === 0) {
    throw new PluginNetworkAccessError(
      pluginId,
      `DNS resolution returned no usable addresses for "${hostname}"`,
    );
  }
  for (const ip of ips) {
    if (isBlockedIpAddress(ip)) {
      throw new PluginNetworkAccessError(
        pluginId,
        `host "${hostname}" resolved to blocked IP address "${ip}"`,
      );
    }
  }
  return ips[0]!;
}

async function fetchWithPinnedNodeSocket(
  targetUrl: URL,
  pinnedIp: string,
  init: {
    method: string;
    headers: Headers;
    body?: BodyInit | null;
    timeoutMs: number;
    maxBytes: number;
    pluginId: string;
    nodeAgent?: unknown;
  },
): Promise<Response> {
  const isHttps = targetUrl.protocol === 'https:';
  const mod = isHttps ? await import('node:https') : await import('node:http');
  const family = pinnedIp.includes(':') ? 6 : 4;
  const headerObj: Record<string, string> = {};
  init.headers.forEach((v, k) => {
    headerObj[k] = v;
  });

  const bodyBuf =
    init.body === undefined || init.body === null
      ? undefined
      : typeof init.body === 'string'
        ? Buffer.from(init.body)
        : init.body instanceof Uint8Array
          ? Buffer.from(init.body)
          : init.body instanceof ArrayBuffer
            ? Buffer.from(init.body)
            : Buffer.from(await new Response(init.body).arrayBuffer());

  return new Promise<Response>((resolve, reject) => {
    const req = mod.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: init.method,
        headers: headerObj,
        timeout: init.timeoutMs,
        ...(isHttps ? { servername: targetUrl.hostname } : {}),
        ...(init.nodeAgent !== undefined ? { agent: init.nodeAgent as any } : {}),
        lookup: (
          _hostname: string,
          opts: unknown,
          cb: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void,
        ) => {
          if (opts && typeof opts === 'object' && (opts as { all?: boolean }).all) {
            cb(null, [{ address: pinnedIp, family }]);
            return;
          }
          cb(null, pinnedIp, family);
        },
      },
      (res) => {
        const cl = res.headers['content-length'];
        if (typeof cl === 'string') {
          const parsed = Number.parseInt(cl, 10);
          if (!Number.isNaN(parsed) && parsed > init.maxBytes) {
            res.destroy();
            reject(
              new PluginNetworkAccessError(
                init.pluginId,
                `response exceeds max size of ${init.maxBytes} bytes`,
              ),
            );
            return;
          }
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > init.maxBytes) {
            res.destroy();
            reject(
              new PluginNetworkAccessError(
                init.pluginId,
                `response exceeds max size of ${init.maxBytes} bytes`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) {
              for (const item of v) headers.append(k, item);
            } else if (typeof v === 'string') {
              headers.set(k, v);
            }
          }
          const combined = Buffer.concat(chunks);
          const status = res.statusCode ?? 200;
          const nullBodyStatus = status === 204 || status === 205 || status === 304 || (status >= 300 && status < 400 && combined.byteLength === 0);
          resolve(
            new Response(nullBodyStatus ? null : combined, {
              status,
              statusText: res.statusMessage ?? '',
              headers,
            }),
          );
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new PluginNetworkAccessError(init.pluginId, `request timed out after ${init.timeoutMs}ms`));
    });
    req.on('error', reject);
    if (bodyBuf && bodyBuf.byteLength > 0) {
      req.write(bodyBuf);
    }
    req.end();
  });
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
 * pinning resolved DNS IPs, stripping credentials across cross-origin redirects,
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
  const hasCustomFetchImpl = Boolean(options.fetchImpl);
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
    const currentHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    let currentOrigin = currentUrl.origin;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const pinnedIp = await validateTargetUrl(manifest.id, currentUrl, allowedHosts, resolveHostIps);

      const usePinnedNode =
        !hasCustomFetchImpl &&
        typeof process !== 'undefined' &&
        Boolean(process.versions?.node);

      const res = usePinnedNode
        ? await fetchWithPinnedNodeSocket(currentUrl, pinnedIp, {
            method: currentMethod,
            headers: currentHeaders,
            body: currentBody,
            timeoutMs,
            maxBytes,
            pluginId: manifest.id,
            nodeAgent: options.nodeAgent,
          })
        : await (async () => {
            const resp = await fetchImpl(currentUrl.toString(), {
              ...init,
              method: currentMethod,
              body: currentBody,
              headers: currentHeaders,
              redirect: 'manual',
              signal: AbortSignal.timeout(timeoutMs),
            });
            // Re-verify DNS right after fetchImpl if custom resolver changes asynchronously (rebinding guard)
            const postIps = await resolveHostIps(currentUrl.hostname.toLowerCase().replace(/\.$/, ''));
            if (postIps.length === 0 || postIps.some((ip) => isBlockedIpAddress(ip))) {
              throw new PluginNetworkAccessError(
                manifest.id,
                `DNS resolution for "${currentUrl.hostname}" changed to blocked or empty IP during request`,
              );
            }
            return resp;
          })();

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) {
          throw new PluginNetworkAccessError(manifest.id, 'redirect response missing Location header');
        }
        if (hop === maxRedirects) {
          throw new PluginNetworkAccessError(manifest.id, `exceeded max redirects (${maxRedirects})`);
        }
        currentUrl = new URL(location, currentUrl);
        if (currentUrl.origin !== currentOrigin) {
          for (const h of CROSS_ORIGIN_SENSITIVE_HEADERS) {
            currentHeaders.delete(h);
          }
          currentOrigin = currentUrl.origin;
        }
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
