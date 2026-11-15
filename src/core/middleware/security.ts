import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { InMemoryRateLimitStore, type RateLimitStore } from '../adapters/rate-limit';
import {
  formatNormalizedIp,
  isIpInTrustedProxies,
  parseTrustedProxies,
  type TrustedProxyRule,
} from '../shared/ip';

export const DEFAULT_MAX_BODY_BYTES = 2_000_000; // 2 MB

const unitTestFallbackStore = new InMemoryRateLimitStore();

function readRuntimeEnv(c: Context, overrideEnv?: Record<string, unknown>, key?: string): string | undefined {
  if (!key) return undefined;
  const fromOverride = overrideEnv?.[key];
  if (typeof fromOverride === 'string') return fromOverride;
  const fromContext = (c.env as Record<string, unknown> | undefined)?.[key];
  if (typeof fromContext === 'string') return fromContext;
  if (typeof process !== 'undefined' && typeof process.env?.[key] === 'string') {
    return process.env[key];
  }
  return undefined;
}

/**
 * Returns true only when the request entered through genuine Cloudflare Workers edge
 * metadata (`request.cf.colo`). Client headers alone never grant Cloudflare trust.
 */
export function hasVerifiedCloudflareEdge(c: Context): boolean {
  const cf = (c.req.raw as { cf?: unknown } | undefined)?.cf;
  if (!cf || typeof cf !== 'object') return false;
  const colo = (cf as { colo?: unknown }).colo;
  return typeof colo === 'string' && colo.trim().length > 0;
}

function getTrustedProxyRules(
  c: Context,
  options?: { trustedProxies?: string; env?: Record<string, unknown> },
): TrustedProxyRule[] {
  const raw = options?.trustedProxies ?? readRuntimeEnv(c, options?.env, 'TRUSTED_PROXIES');
  if (!raw || !raw.trim()) return [];
  try {
    return parseTrustedProxies(raw);
  } catch {
    return [];
  }
}

export function isTrustedForwardingRequest(
  c: Context,
  options?: { trustProxy?: boolean; trustedProxies?: string; env?: Record<string, unknown> },
): boolean {
  if (hasVerifiedCloudflareEdge(c)) return true;

  const trustProxy =
    options?.trustProxy ?? readRuntimeEnv(c, options?.env, 'TRUST_PROXY') === 'true';
  if (!trustProxy) return false;

  const socketIp = formatNormalizedIp((c.env as any)?.incoming?.socket?.remoteAddress);
  if (!socketIp) return false;

  const rules = getTrustedProxyRules(c, options);
  if (rules.length === 0) return false;
  return isIpInTrustedProxies(socketIp, rules);
}

/**
 * Resolve verified client IP from authenticated edge metadata (`request.cf.colo`) or a
 * verified reverse proxy matching `TRUST_PROXY=true` and `TRUSTED_PROXIES`.
 * Returns `null` rather than trusting spoofed headers or fabricating `127.0.0.1` when no
 * verified peer identity exists.
 */
export function resolveVerifiedClientIp(
  c: Context,
  options?: { trustProxy?: boolean; trustedProxies?: string; env?: Record<string, unknown> },
): string | null {
  if (hasVerifiedCloudflareEdge(c)) {
    const cfIp = formatNormalizedIp(c.req.header('cf-connecting-ip'));
    if (cfIp) return cfIp;
  }

  const socketIp = formatNormalizedIp((c.env as any)?.incoming?.socket?.remoteAddress);
  const trustProxy =
    options?.trustProxy ?? readRuntimeEnv(c, options?.env, 'TRUST_PROXY') === 'true';

  if (trustProxy && socketIp) {
    const rules = getTrustedProxyRules(c, options);
    if (rules.length > 0 && isIpInTrustedProxies(socketIp, rules)) {
      const forwardedFor = c.req.header('x-forwarded-for');
      if (forwardedFor) {
        const hops = forwardedFor.split(',').map((part) => formatNormalizedIp(part));
        if (hops.every((hop): hop is string => hop !== null) && hops.length > 0) {
          for (let i = hops.length - 1; i >= 0; i -= 1) {
            const hop = hops[i]!;
            if (!isIpInTrustedProxies(hop, rules)) {
              return hop;
            }
          }
          return hops[0]!;
        }
      }
      const realIp = formatNormalizedIp(c.req.header('x-real-ip'));
      if (realIp) return realIp;
    }
  }

  return socketIp;
}

export function resolveClientIp(
  c: Context,
  options?: { trustProxy?: boolean; trustedProxies?: string; env?: Record<string, unknown> },
): string | null {
  return resolveVerifiedClientIp(c, options);
}

export interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  prefix: string;
  env?: Record<string, unknown>;
  store?: RateLimitStore;
  requireStore?: boolean;
  keyResolver?: (c: Context) => string | null | Promise<string | null>;
}

/**
 * Persistent rate limiter middleware backed by the shared `RateLimitStore`.
 * Fails closed (HTTP 503) on backing storage errors when a store is required.
 */
export function rateLimiter(options: RateLimiterOptions) {
  const { maxRequests, windowMs, prefix } = options;

  return createMiddleware(async (c, next) => {
    const isProd = readRuntimeEnv(c, options.env, 'NODE_ENV') === 'production';
    const mustRequireStore = options.requireStore ?? isProd;
    const store = options.store ?? (mustRequireStore ? undefined : unitTestFallbackStore);

    if (!store) {
      return c.json(
        {
          error: {
            code: 'service_unavailable',
            message: 'Rate limiting service is temporarily unavailable.',
          },
        },
        503,
      );
    }

    const customScope = options.keyResolver ? await options.keyResolver(c) : null;
    const verifiedIp = customScope ? null : resolveVerifiedClientIp(c, { env: options.env });
    const scopedIdentity = customScope ?? (verifiedIp ? `ip:${verifiedIp}` : 'unverified');
    const key = `${prefix}:${scopedIdentity}`;

    try {
      const result = await store.consume(key, windowMs, maxRequests);
      if (!result.allowed) {
        c.header('Retry-After', String(result.retryAfterSeconds));
        return c.json(
          {
            error: {
              code: 'rate_limit_exceeded',
              message: 'Too many requests. Please try again later.',
            },
          },
          429,
        );
      }
      return next();
    } catch {
      return c.json(
        {
          error: {
            code: 'service_unavailable',
            message: 'Rate limiting service is temporarily unavailable. Please try again later.',
          },
        },
        503,
      );
    }
  });
}

/**
 * Standard security headers for all responses.
 */
export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  if (!c.res.headers.has('Content-Security-Policy')) {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; script-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'",
    );
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

const BODY_LIMIT_EXCEEDED = Symbol('burrow.bodyLimitExceeded');

/** Returns the exceeded maxBytes when streaming bodyLimit aborted the current request body. */
export function getBodyLimitExceeded(c: object): number | null {
  const value = (c as Record<symbol, unknown>)[BODY_LIMIT_EXCEEDED];
  return typeof value === 'number' ? value : null;
}

/**
 * Request body size limiter middleware.
 * Inspects Content-Length and wraps streaming bodies to return 413 even when Content-Length is missing or spoofed.
 */
export function bodyLimit(maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return createMiddleware(async (c, next) => {
    const payloadTooLarge = () =>
      c.json(
        {
          error: {
            code: 'payload_too_large',
            message: `Request body exceeds limit of ${maxBytes} bytes`,
          },
        },
        413,
      );

    const contentLength = c.req.header('content-length');
    if (contentLength) {
      const len = Number.parseInt(contentLength, 10);
      if (!Number.isNaN(len) && len > maxBytes) {
        return payloadTooLarge();
      }
    }

    let exceeded = false;
    const method = c.req.method.toUpperCase();
    if (
      (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') &&
      c.req.raw.body
    ) {
      const sourceBody = c.req.raw.body;
      const reader = sourceBody.getReader();
      let bytesRead = 0;
      const limitedBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            bytesRead += value.byteLength;
            if (bytesRead > maxBytes) {
              exceeded = true;
              (c as unknown as Record<symbol, unknown>)[BODY_LIMIT_EXCEEDED] = maxBytes;
              await reader.cancel().catch(() => {});
              controller.close();
              return;
            }
            controller.enqueue(value);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel(reason) {
          return reader.cancel(reason).catch(() => {});
        },
      });
      c.req.raw = new Request(c.req.raw, {
        body: limitedBody,
        duplex: 'half',
      } as RequestInit);
    }

    try {
      await next();
    } catch (error) {
      if (exceeded) {
        c.error = undefined;
        c.res = payloadTooLarge();
        return c.res;
      }
      throw error;
    }

    if (exceeded) {
      c.error = undefined;
      c.res = payloadTooLarge();
      return c.res;
    }
  });
}

/**
 * CSRF protection middleware against cross-site request forgery.
 * Blocks cross-site requests using Sec-Fetch-Site and Origin verification.
 */
export const csrfProtection = createMiddleware(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
    return next();
  }

  const path = c.req.path;
  if (path.startsWith('/api/auth/') || path === '/api/auth') {
    return next();
  }

  const secFetchSite = c.req.header('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    return c.json({ error: { code: 'forbidden', message: 'Cross-site request blocked' } }, 403);
  }

  const origin = c.req.header('origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.host;
      const forwardedHost = isTrustedForwardingRequest(c)
        ? c.req.header('x-forwarded-host')
        : undefined;
      const requestHost = forwardedHost || new URL(c.req.url).host;

      if (originHost !== requestHost) {
        // Allow loopback / localhost cross-port requests in local development (e.g. Vite on 3005 proxying to API on 8787)
        const isLoopbackOrigin =
          originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1';
        const requestHostname = requestHost.split(':')[0];
        const isLoopbackRequest =
          requestHostname === 'localhost' || requestHostname === '127.0.0.1';

        if (!isLoopbackOrigin || !isLoopbackRequest) {
          return c.json({ error: { code: 'forbidden', message: 'Cross-site request blocked' } }, 403);
        }
      }
    } catch {
      return c.json({ error: { code: 'forbidden', message: 'Cross-site request blocked' } }, 403);
    }
  }

  await next();
});
