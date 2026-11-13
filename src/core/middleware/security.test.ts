import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { csrfProtection, rateLimiter, resolveClientIp, securityHeaders } from './security';

describe('security headers', () => {
  it('allows only the supported YouTube iframe origin', async () => {
    const app = new Hono();
    app.use('*', securityHeaders);
    app.get('/', (c) => c.text('media editor'));

    const response = await app.request('/');
    const directives = response.headers.get('Content-Security-Policy')?.split(';').map((part) => part.trim());
    expect(directives?.filter((part) => part.startsWith('frame-src '))).toEqual([
      'frame-src https://www.youtube-nocookie.com',
    ]);
    expect(directives).toContain("default-src 'self'");
    expect(directives).toContain("frame-ancestors 'none'");
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('preserves an explicit resource content policy', async () => {
    const app = new Hono();
    app.use('*', securityHeaders);
    app.get('/image.svg', (c) => {
      c.header('Content-Security-Policy', 'sandbox');
      return c.text('<svg/>');
    });

    const response = await app.request('/image.svg');
    expect(response.headers.get('Content-Security-Policy')).toBe('sandbox');
  });
});

describe('client IP & proxy trust safeguards (#009)', () => {
  it('ignores client-spoofed X-Forwarded-For and CF-Connecting-IP when TRUST_PROXY is unset on Node', async () => {
    const app = new Hono();
    app.use('/limited', rateLimiter({ maxRequests: 2, windowMs: 60_000, prefix: 'test-rl' }));
    app.get('/limited', (c) => c.json({ ip: resolveClientIp(c, { trustProxy: false }) }));

    const r1 = await app.request('http://burrow.example.com/limited', {
      headers: { 'X-Forwarded-For': '203.0.113.1', 'CF-Connecting-IP': '203.0.113.10' },
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ip: '127.0.0.1' });

    const r2 = await app.request('http://burrow.example.com/limited', {
      headers: { 'X-Forwarded-For': '203.0.113.2', 'CF-Connecting-IP': '203.0.113.20' },
    });
    expect(r2.status).toBe(200);

    // Changing spoofed headers does not evade the rate limit bucket
    const r3 = await app.request('http://burrow.example.com/limited', {
      headers: { 'X-Forwarded-For': '203.0.113.3', 'CF-Connecting-IP': '203.0.113.30' },
    });
    expect(r3.status).toBe(429);
  });

  it('rejects CSRF Origin mismatch even if X-Forwarded-Host matches attacker Origin when TRUST_PROXY is false', async () => {
    const prev = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    try {
      const app = new Hono();
      app.use('*', csrfProtection);
      app.post('/api/mutate', (c) => c.json({ ok: true }));

      const res = await app.request('https://burrow.example.com/api/mutate', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example.net',
          'X-Forwarded-Host': 'evil.example.net',
        },
      });
      expect(res.status).toBe(403);
    } finally {
      if (prev !== undefined) process.env.TRUST_PROXY = prev;
    }
  });
});
