import { describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createApp } from '../../src/worker';
import { helloPlugin } from '../../packages/plugins/hello/src/index';

describe('Worker Plugin Runtime E2E (D1 + helloPlugin)', () => {
  it('auto-migrates plugin tables, records task.created & notepad.saved via waitUntil, and enforces workspace cascade', async () => {
    const worker = createApp({ plugins: [helloPlugin] });
    const workerEnv = {
      ...env,
      BETTER_AUTH_SECRET: 'test-better-auth-secret-32-bytes-minimum!!',
      BETTER_AUTH_URL: 'https://plugins.example.workers.dev',
      BOOTSTRAP_TOKEN: 'plugin-test-bootstrap-token-16',
    };

    const run = async (url: string, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(url, init), workerEnv, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    const pingRes = await run('https://plugins.example.workers.dev/api/plugins/hello/ping');
    expect(pingRes.status).toBe(200);
    expect(await pingRes.json()).toEqual({
      ok: true,
      plugin: 'hello',
      prefix: 'plugin_hello_',
    });

    // Sign up initial user (or reuse if DB persisted across tests in same file)
    const email = `plugin-owner-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const signupRes = await run('https://plugins.example.workers.dev/api/auth/sign-up/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://plugins.example.workers.dev',
      },
      body: JSON.stringify({
        email,
        password: 'Password123!',
        name: 'Plugin Owner',
        bootstrapToken: 'plugin-test-bootstrap-token-16',
      }),
    });
    expect(signupRes.status).toBe(200);
    const cookie = signupRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const accountRes = await run('https://plugins.example.workers.dev/api/account', {
      headers: { cookie },
    });
    expect(accountRes.status).toBe(200);
    const accountData = (await accountRes.json()) as {
      workspaces: Array<{ id: string }>;
    };
    const workspaceId = accountData.workspaces[0]!.id;

    const projRes = await run(
      `https://plugins.example.workers.dev/api/workspaces/${workspaceId}/projects`,
      { headers: { cookie } },
    );
    const projects = (await projRes.json()) as Array<{ id: string }>;
    const projectId = projects[0]!.id;

    const npListRes = await run(
      `https://plugins.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      { headers: { cookie } },
    );
    const notepads = (await npListRes.json()) as Array<{ id: string }>;
    const notepadId = notepads[0]!.id;

    // Save notepad content -> triggers notepad.saved via ctx.waitUntil
    const saveRes = await run(
      `https://plugins.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/content`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: 'https://plugins.example.workers.dev',
          cookie,
        },
        body: JSON.stringify({
          content: JSON.stringify([
            { type: 'paragraph', content: [{ type: 'text', text: 'Plugin event test' }] },
          ]),
          baseVersion: 1,
        }),
      },
    );
    expect(saveRes.status).toBe(200);

    // Create a board + column + card -> triggers task.created via ctx.waitUntil
    const boardRes = await run(
      `https://plugins.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/boards`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://plugins.example.workers.dev',
          cookie,
        },
        body: JSON.stringify({ name: 'Plugin Board' }),
      },
    );
    expect(boardRes.status).toBe(201);
    const createdBoard = (await boardRes.json()) as { id: string };

    const boardDetailRes = await run(
      `https://plugins.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/boards/${createdBoard.id}`,
      { headers: { cookie } },
    );
    expect(boardDetailRes.status).toBe(200);
    const boardData = (await boardDetailRes.json()) as { id: string; columns: Array<{ id: string }> };

    const cardRes = await run(
      `https://plugins.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/columns/${boardData.columns[0]!.id}/cards`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://plugins.example.workers.dev',
          cookie,
        },
        body: JSON.stringify({ title: 'First Plugin Card' }),
      },
    );
    expect(cardRes.status).toBe(201);
    const cardData = (await cardRes.json()) as { cardId: string };

    // Read plugin logs via authenticated plugin route
    const logsRes = await run(
      `https://plugins.example.workers.dev/api/plugins/hello/workspaces/${workspaceId}/logs`,
      { headers: { cookie } },
    );
    expect(logsRes.status).toBe(200);
    const logsData = (await logsRes.json()) as {
      logs: Array<{ event_name: string; target_id: string }>;
    };
    expect(logsData.logs.map((l) => [l.event_name, l.target_id])).toEqual([
      ['notepad.saved', notepadId],
      ['task.created', cardData.cardId],
    ]);

    // Verify FK ON DELETE CASCADE when workspace is deleted directly
    await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(workspaceId).run();
    const remaining = await env.DB.prepare(
      'SELECT count(*) AS cnt FROM plugin_hello_logs WHERE workspace_id = ?',
    )
      .bind(workspaceId)
      .first<{ cnt: number }>();
    expect(remaining?.cnt).toBe(0);
  });
});
