import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker/index';
import { createD1Infrastructure } from '../../src/core/adapters/db/d1';
import { createDb } from '../../src/core/adapters/db/d1/client';

const app = createWorkerApp(env);
const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';

function postJson(path: string, body: unknown, cookie = '') {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (cookie) headers.set('Cookie', cookie);
  return app.request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) }, env);
}

describe('bootstrap recovery with active mistyped session edge case', () => {
  it('resets a claimed bootstrap without silently reclaiming or completing it for an existing signed-in wrong account', async () => {
    const intendedEmail = 'intended-owner@example.com';
    const wrongEmail = 'mistyped-session@example.com';

    // Simulate an interrupted bootstrap claim for intendedEmail
    const firstSignup = await postJson('/api/auth/sign-up/email', {
      email: intendedEmail,
      password: 'password123',
      name: 'Intended Owner',
      bootstrapToken,
    });
    expect(firstSignup.status).toBe(200);

    // Create a real signed Better Auth session for a second account without completing bootstrap
    const auth = createD1Infrastructure(createDb(env.DB), env).auth;
    const unrelated = await auth.handler(
      new Request('http://localhost/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Wrong Session',
          email: wrongEmail,
          password: 'password123',
        }),
      }),
    );
    expect(unrelated.status).toBe(200);
    const wrongCookie = unrelated.headers.get('set-cookie')!;
    expect(wrongCookie).toBeTruthy();

    // Put bootstrap_state into claimed status with zero workspaces (aborted bootstrap setup for intendedEmail)
    await env.DB.prepare('DELETE FROM workspaces WHERE created_by = (SELECT id FROM "user" WHERE email = ?)')
      .bind(intendedEmail)
      .run();
    await env.DB.prepare(
      "UPDATE bootstrap_state SET status = 'claimed', claim_email = ?, user_id = NULL, workspace_id = NULL WHERE id = 1",
    )
      .bind(intendedEmail)
      .run();

    // Even if the browser carries an unrelated/wrong session cookie, resetClaim: true MUST ONLY reset to empty
    // and MUST NEVER adopt or complete bootstrap for wrongEmail!
    const getBootstrapState = () =>
      env.DB.prepare(
        'SELECT status, claim_email, user_id, workspace_id FROM bootstrap_state WHERE id = 1',
      ).first<{
        status: string;
        claim_email: string | null;
        user_id: string | null;
        workspace_id: string | null;
      }>();

    // Wrong session attempting direct recovery must be rejected and leave claim intact
    const directRecoverWrong = await postJson(
      '/api/auth/bootstrap/recover',
      { bootstrapToken },
      wrongCookie,
    );
    expect(directRecoverWrong.status).toBe(409);

    // Mismatched confirmEmail on resetClaim must be rejected and leave claim intact
    const resetMismatch = await postJson(
      '/api/auth/bootstrap/recover',
      { bootstrapToken, resetClaim: true, confirmEmail: 'other@example.com' },
      wrongCookie,
    );
    expect(resetMismatch.status).toBe(409);
    expect((await getBootstrapState())?.claim_email).toBe(intendedEmail);

    const resetRes = await postJson(
      '/api/auth/bootstrap/recover',
      { bootstrapToken, resetClaim: true, confirmEmail: intendedEmail },
      wrongCookie,
    );
    expect(resetRes.status).toBe(200);
    expect(await resetRes.json()).toEqual({ ok: true, reset: true });

    const stateAfterReset = await getBootstrapState();
    expect(stateAfterReset?.status).toBe('empty');
    expect(stateAfterReset?.claim_email).toBeNull();
    expect(stateAfterReset?.user_id).toBeNull();
    expect(stateAfterReset?.workspace_id).toBeNull();

    // Even after resetting to empty, the unrelated/wrong existing session must NOT silently claim bootstrap
    const hijackAfterReset = await postJson(
      '/api/auth/bootstrap/recover',
      { bootstrapToken },
      wrongCookie,
    );
    expect(hijackAfterReset.status).toBe(409);
    expect((await getBootstrapState())?.status).toBe('empty');

    // Operator completes initial bootstrap cleanly with the intended replacement account
    const replacementEmail = 'right-owner@example.com';
    const rightSignUp = await postJson('/api/auth/sign-up/email', {
      email: replacementEmail,
      password: 'password123',
      name: 'Right Owner',
      bootstrapToken,
    });
    expect(rightSignUp.status).toBe(200);

    const finalState = await getBootstrapState();
    expect(finalState?.status).toBe('complete');
    expect(finalState?.claim_email).toBe(replacementEmail);
    expect(finalState?.workspace_id).toBeTruthy();

    // Single-owner initialization remains locked after completion
    const secondBootstrap = await postJson('/api/auth/sign-up/email', {
      email: 'late-attacker@example.com',
      password: 'password123',
      name: 'Late Attacker',
      bootstrapToken,
    });
    expect(secondBootstrap.status).toBe(403);
  });
});
