import { describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/worker/index';

describe('Worker First-Boot Auto-Initialization (Deploy to Cloudflare)', () => {
  it('supports zero-input first-boot D1/secret initialization, first-user Owner claim, and post-setup invite lock', async () => {
    const unconfiguredEnv = {
      ...env,
      BETTER_AUTH_SECRET: '',
      BETTER_AUTH_URL: '',
      BOOTSTRAP_TOKEN: '',
    };

    const ctx1 = createExecutionContext();
    const healthRes = await worker.fetch(
      new Request('https://one-click.example.workers.dev/api/health'),
      unconfiguredEnv,
      ctx1,
    );
    await waitOnExecutionContext(ctx1);
    expect(healthRes.status).toBe(200);

    const secretRow = await env.DB.prepare(
      "SELECT value FROM _worker_runtime_config WHERE key = 'better_auth_secret'",
    ).first<{ value: string }>();
    expect(secretRow?.value).toMatch(/^[0-9a-f]{64}$/);

    // Zero-input /api/auth/config advertises bootstrapTokenRequired: false when BOOTSTRAP_TOKEN is omitted
    const ctxConfig = createExecutionContext();
    const configRes = await worker.fetch(
      new Request('https://one-click.example.workers.dev/api/auth/config'),
      unconfiguredEnv,
      ctxConfig,
    );
    await waitOnExecutionContext(ctxConfig);
    expect(configRes.status).toBe(200);
    expect(await configRes.json()).toMatchObject({
      signupMode: 'bootstrap-or-invite',
      bootstrapTokenRequired: false,
    });

    // When BOOTSTRAP_TOKEN IS configured, /api/auth/config advertises bootstrapTokenRequired: true
    const ctxConfigToken = createExecutionContext();
    const configTokenRes = await worker.fetch(
      new Request('https://one-click.example.workers.dev/api/auth/config'),
      { ...unconfiguredEnv, BOOTSTRAP_TOKEN: 'configured-bootstrap-secret-16' },
      ctxConfigToken,
    );
    await waitOnExecutionContext(ctxConfigToken);
    expect(configTokenRes.status).toBe(200);
    expect(await configTokenRes.json()).toMatchObject({
      bootstrapTokenRequired: true,
    });

    // First user registration claims Owner without a bootstrap token when BOOTSTRAP_TOKEN is omitted
    const ctx2 = createExecutionContext();
    const ownerSignupRes = await worker.fetch(
      new Request('https://one-click.example.workers.dev/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://one-click.example.workers.dev',
        },
        body: JSON.stringify({
          email: 'deployer@example.com',
          password: 'Password123!',
          name: 'Deployer Owner',
        }),
      }),
      unconfiguredEnv,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);
    expect(ownerSignupRes.status).toBe(200);

    // Subsequent uninvited registrations immediately fail closed with invite_required
    const ctx3 = createExecutionContext();
    const secondSignupRes = await worker.fetch(
      new Request('https://one-click.example.workers.dev/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://one-click.example.workers.dev',
        },
        body: JSON.stringify({
          email: 'stranger@example.com',
          password: 'Password123!',
          name: 'Stranger',
        }),
      }),
      unconfiguredEnv,
      ctx3,
    );
    await waitOnExecutionContext(ctx3);
    expect(secondSignupRes.status).toBe(403);
    const secondData = (await secondSignupRes.json()) as { error: { code: string } };
    expect(secondData.error.code).toBe('invite_required');
  });
});
