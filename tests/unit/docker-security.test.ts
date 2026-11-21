import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error untyped local .mjs script
import { buildDockerEnvContent } from '../../scripts/docker-init.mjs';

const root = path.resolve('.');

describe('Docker deployment security defaults and env generator', () => {
  it('keeps local evaluation disabled and loopback-bound in docker-compose.yml and .env.example', () => {
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain("BIND_HOST:-127.0.0.1");
    expect(compose).toContain('ALLOW_LOCAL_DOCKER_EVAL=${ALLOW_LOCAL_DOCKER_EVAL:-false}');
    expect(compose).not.toContain('0.0.0.0');

    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(envExample).not.toMatch(/^ALLOW_LOCAL_DOCKER_EVAL=true/m);
    expect(envExample).not.toMatch(/^BIND_HOST=0\.0\.0\.0/m);
    expect(envExample).not.toMatch(/^[A-Z0-9_]+=/m);
  });

  it('rejects missing or localhost URLs in production mode and requires explicit --local-eval opt-in', () => {
    expect(() => buildDockerEnvContent({ localEval: false })).toThrow(/requires --url/i);
    expect(() =>
      buildDockerEnvContent({ localEval: false, url: 'http://localhost:3005' }),
    ).toThrow(/cannot use localhost/i);
    expect(() =>
      buildDockerEnvContent({ localEval: false, url: 'http://127.0.0.1:3005' }),
    ).toThrow(/cannot use localhost/i);
  });

  it('rejects non-loopback origins or bind hosts when --local-eval is active', () => {
    expect(() =>
      buildDockerEnvContent({ localEval: true, url: 'https://burrow.example.com' }),
    ).toThrow(/requires a localhost or 127\.0\.0\.1/i);
    expect(() =>
      buildDockerEnvContent({
        localEval: true,
        url: 'http://localhost:3005',
        bindHost: '0.0.0.0',
      }),
    ).toThrow(/loopback bind host/i);
  });

  it('generates distinct high-entropy secrets and safe flags for production and local-eval modes', () => {
    const prod = buildDockerEnvContent({
      localEval: false,
      url: 'https://notes.example.com',
    });
    expect(prod.localEval).toBe(false);
    expect(prod.bindHost).toBe('127.0.0.1');
    expect(prod.content).toContain('NODE_ENV=production');
    expect(prod.content).toContain('ALLOW_LOCAL_DOCKER_EVAL=false');
    expect(prod.content).toContain('BIND_HOST=127.0.0.1');
    expect(prod.content).toContain('BETTER_AUTH_URL=https://notes.example.com');
    expect(prod.bootstrapToken).toBe('');
    expect(prod.content).toContain('# BOOTSTRAP_TOKEN=');

    const evalEnv = buildDockerEnvContent({ localEval: true });
    expect(evalEnv.localEval).toBe(true);
    expect(evalEnv.bindHost).toBe('127.0.0.1');
    expect(evalEnv.content).toContain('ALLOW_LOCAL_DOCKER_EVAL=true');
    expect(evalEnv.content).toContain('BIND_HOST=127.0.0.1');
    expect(evalEnv.content).toContain('BETTER_AUTH_URL=http://localhost:3005');
    expect(evalEnv.bootstrapToken).toBe('');

    const gatedProd = buildDockerEnvContent({
      localEval: false,
      url: 'https://notes.example.com',
      withBootstrapToken: true,
    });
    const gatedEval = buildDockerEnvContent({
      localEval: true,
      withBootstrapToken: true,
    });
    expect(gatedProd.bootstrapToken.length).toBeGreaterThanOrEqual(32);
    expect(gatedProd.content).toContain(`BOOTSTRAP_TOKEN=${gatedProd.bootstrapToken}`);
    expect(gatedEval.bootstrapToken).not.toBe(gatedProd.bootstrapToken);
  });
});
