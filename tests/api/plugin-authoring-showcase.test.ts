import { describe, expect, it } from 'vitest';
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createApp } from '../../src/worker';
import { estimationServerPlugin } from '../../packages/plugins/estimation/src/index';

describe('Plugin Authoring Showcase (D1 + estimationServerPlugin)', () => {
  it('migrates plugin_estimation_points, seeds estimate cards via task.created, enforces workspace scoping, handles sprint mentions, and cascades on card deletion', async () => {
    const worker = createApp({ plugins: [estimationServerPlugin] });
    const workerEnv = {
      ...env,
      BETTER_AUTH_SECRET: 'showcase-secret-at-least-32-bytes-long!!',
      BETTER_AUTH_URL: 'https://estimation.example.workers.dev',
      BOOTSTRAP_TOKEN: 'showcase-bootstrap-token-16',
    };

    const run = async (url: string, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(url, init), workerEnv, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    // Trigger cold-start worker bootstrap + migrations
    expect((await run('https://estimation.example.workers.dev/api/health')).status).toBe(200);

    const signupEmail = `est-owner-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const signupRes = await run('https://estimation.example.workers.dev/api/auth/sign-up/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://estimation.example.workers.dev',
      },
      body: JSON.stringify({
        email: signupEmail,
        password: 'ValidPassword123!',
        name: 'Estimation Owner',
        bootstrapToken: 'showcase-bootstrap-token-16',
      }),
    });
    expect(signupRes.status).toBe(200);
    const cookie = signupRes.headers.get('set-cookie')?.split(';')[0] ?? '';

    const accountRes = await run('https://estimation.example.workers.dev/api/account', {
      headers: { cookie },
    });
    const accountData = (await accountRes.json()) as { workspaces: Array<{ id: string }> };
    const workspaceId = accountData.workspaces[0]!.id;

    const projRes = await run(
      `https://estimation.example.workers.dev/api/workspaces/${workspaceId}/projects`,
      { headers: { cookie } },
    );
    const projects = (await projRes.json()) as Array<{ id: string }>;
    const projectId = projects[0]!.id;

    // Create board & column
    const boardRes = await run(
      `https://estimation.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/boards`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://estimation.example.workers.dev',
          cookie,
        },
        body: JSON.stringify({ name: 'Planning Board' }),
      },
    );
    expect(boardRes.status).toBe(201);
    const createdBoard = (await boardRes.json()) as { id: string };
    const boardDetailRes = await run(
      `https://estimation.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/boards/${createdBoard.id}`,
      { headers: { cookie } },
    );
    expect(boardDetailRes.status).toBe(200);
    const board = (await boardDetailRes.json()) as {
      id: string;
      columns: Array<{ id: string }>;
    };
    const columnId = board.columns[0]!.id;

    // Create an 'estimate' card -> task.created seeds 1 pt via waitUntil
    const cardRes = await run(
      `https://estimation.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/columns/${columnId}/cards`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://estimation.example.workers.dev',
          cookie,
        },
        body: JSON.stringify({ title: 'Implement estimation plugin', cardType: 'estimate' }),
      },
    );
    expect(cardRes.status).toBe(201);
    const createdCard = (await cardRes.json()) as { cardId: string };

    // Verify GET card estimate reflects seeded 1 pt
    const unauthRes = await run(
      `https://estimation.example.workers.dev/api/plugins/estimation/workspaces/${workspaceId}/cards/${createdCard.cardId}`,
    );
    expect(unauthRes.status).toBe(401);

    const estGet = await run(
      `https://estimation.example.workers.dev/api/plugins/estimation/workspaces/${workspaceId}/cards/${createdCard.cardId}`,
      { headers: { cookie } },
    );
    expect(estGet.status).toBe(200);
    expect(await estGet.json()).toMatchObject({
      cardId: createdCard.cardId,
      points: 1,
      sprint: 'sprint-current',
    });

    // Update estimate via plugin route
    const estPut = await run(
      `https://estimation.example.workers.dev/api/plugins/estimation/workspaces/${workspaceId}/cards/${createdCard.cardId}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: 'https://estimation.example.workers.dev',
          cookie,
        },
        body: JSON.stringify({ points: 8, sprint: 'sprint-42' }),
      },
    );
    expect(estPut.status).toBe(200);
    expect(await estPut.json()).toMatchObject({
      points: 8,
      sprint: 'sprint-42',
    });

    // Check summary endpoint & mention suggest/resolve
    const summaryRes = await run(
      `https://estimation.example.workers.dev/api/plugins/estimation/workspaces/${workspaceId}/summary?projectId=${projectId}`,
      { headers: { cookie } },
    );
    expect(summaryRes.status).toBe(200);
    expect(await summaryRes.json()).toMatchObject({
      totalPoints: 8,
      estimatedCards: 1,
    });

    const suggestRes = await run(
      `https://estimation.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/suggest?type=plugin:estimation:sprint&q=sprint-42`,
      { headers: { cookie } },
    );
    expect(suggestRes.status).toBe(200);
    const suggestions = (await suggestRes.json()) as Array<{ id: string; kind: string }>;
    expect(suggestions.some((s) => s.id === 'sprint-42' && s.kind === 'plugin:estimation:sprint')).toBe(true);

    const refRes = await run(
      `https://estimation.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/references/plugin:estimation:sprint/sprint-42`,
      { headers: { cookie } },
    );
    expect(refRes.status).toBe(200);
    expect(await refRes.json()).toMatchObject({
      kind: 'plugin:estimation:sprint',
      id: 'sprint-42',
      badge: 'SPRINT',
    });

    // Soft-delete then permanent-delete card -> ON DELETE CASCADE cleans plugin_estimation_points
    const softDel = await run(
      `https://estimation.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/cards/${createdCard.cardId}`,
      {
        method: 'DELETE',
        headers: { origin: 'https://estimation.example.workers.dev', cookie },
      },
    );
    expect(softDel.status).toBe(200);

    const permDel = await run(
      `https://estimation.example.workers.dev/api/workspaces/${workspaceId}/projects/${projectId}/cards/${createdCard.cardId}/permanent`,
      {
        method: 'DELETE',
        headers: { origin: 'https://estimation.example.workers.dev', cookie },
      },
    );
    expect(permDel.status).toBe(200);

    const postCascadeSummary = await run(
      `https://estimation.example.workers.dev/api/plugins/estimation/workspaces/${workspaceId}/summary?projectId=${projectId}`,
      { headers: { cookie } },
    );
    expect(postCascadeSummary.status).toBe(200);
    expect(await postCascadeSummary.json()).toMatchObject({
      totalPoints: 0,
      estimatedCards: 0,
    });
  });
});
