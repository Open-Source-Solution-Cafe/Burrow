import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from './security';

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
