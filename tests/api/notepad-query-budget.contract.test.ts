import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker/index';
import { getAccountWorkspaceScope } from './account-scope';

interface LoggedQuery {
  id: number;
  sql: string;
  params: unknown[];
  durationMs: number;
  rowsRead: number;
  rowsWritten: number;
  caller: string;
  isBatch?: boolean;
}

export function createMeasuredWorkerApp(envBindings: any) {
  let queryCounter = 0;
  const queryLog: LoggedQuery[] = [];
  let captureQueries = false;

  function getCaller(): string {
    const err = new Error();
    const lines = err.stack?.split('\n') || [];
    for (const line of lines) {
      if (
        line.includes('src/') &&
        !line.includes('notepad-query-budget') &&
        !line.includes('node_modules')
      ) {
        const match = line.match(/(src\/[^:)]+:\d+(?::\d+)?)/);
        if (match && match[1]) return match[1];
        return line.trim();
      }
    }
    return 'external/drizzle';
  }

  function wrapStmt(stmt: any, query: string, caller: string, boundParams: unknown[] = []): any {
    return new Proxy(stmt, {
      get(stmtTarget, stmtProp) {
        if (stmtProp === 'bind') {
          return (...args: unknown[]) => {
            const bound = stmtTarget.bind(...args);
            return wrapStmt(bound, query, caller, args);
          };
        }
        if (
          stmtProp === 'run' ||
          stmtProp === 'all' ||
          stmtProp === 'first' ||
          stmtProp === 'raw'
        ) {
          return async (...args: unknown[]) => {
            const start = performance.now();
            const res = await (stmtTarget as any)[stmtProp](...args);
            const durationMs = performance.now() - start;
            if (captureQueries) {
              queryCounter++;
              queryLog.push({
                id: queryCounter,
                sql: query,
                params: boundParams,
                durationMs: Math.round(durationMs * 100) / 100,
                rowsRead:
                  res?.meta?.rows_read ??
                  (Array.isArray(res) ? res.length : (res?.results?.length ?? 0)),
                rowsWritten: res?.meta?.rows_written ?? 0,
                caller,
              });
            }
            return res;
          };
        }
        return Reflect.get(stmtTarget, stmtProp);
      },
    });
  }

  function wrapD1(db: D1Database): D1Database {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (query: string) => {
            const caller = getCaller();
            const stmt = target.prepare(query);
            return wrapStmt(stmt, query, caller);
          };
        }
        if (prop === 'batch') {
          return async (statements: any[]) => {
            const caller = getCaller();
            const start = performance.now();
            const res = await target.batch(statements);
            const durationMs = performance.now() - start;
            if (captureQueries) {
              queryCounter++;
              const rowsRead =
                res?.reduce((acc: number, r: any) => acc + (r?.meta?.rows_read ?? 0), 0) ?? 0;
              const rowsWritten =
                res?.reduce((acc: number, r: any) => acc + (r?.meta?.rows_written ?? 0), 0) ?? 0;
              queryLog.push({
                id: queryCounter,
                sql: `D1 BATCH (${statements.length} stmts)`,
                params: [],
                durationMs: Math.round(durationMs * 100) / 100,
                rowsRead,
                rowsWritten,
                caller,
                isBatch: true,
              });
            }
            return res;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  const wrappedDb = wrapD1(envBindings.DB);
  const app = createWorkerApp({ ...envBindings, DB: wrappedDb });

  return {
    app,
    startCapture: () => {
      queryLog.length = 0;
      queryCounter = 0;
      captureQueries = true;
    },
    stopCapture: () => {
      captureQueries = false;
      return {
        count: queryLog.length,
        rowsRead: queryLog.reduce((s, q) => s + q.rowsRead, 0),
        rowsWritten: queryLog.reduce((s, q) => s + q.rowsWritten, 0),
        queries: [...queryLog],
      };
    },
  };
}

describe('D1 Query Budget Contract Tests', () => {
  it('enforces maximum query count budgets for notepad edit and read paths', async () => {
    const { app, startCapture, stopCapture } = createMeasuredWorkerApp(env);

    // Setup: Sign up owner, get session cookie
    const signUpRes = await app.request(
      'http://localhost/api/auth/sign-up/email',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'budget-contract-owner@example.com',
          password: 'password123',
          name: 'Owner',
          bootstrapToken: 'test-bootstrap-token',
        }),
      },
      env,
    );
    expect(signUpRes.status).toBe(200);
    const setCookieHeaders = signUpRes.headers.getSetCookie
      ? signUpRes.headers.getSetCookie()
      : [signUpRes.headers.get('set-cookie')!];
    const cookie = setCookieHeaders.map((c) => c.split(';')[0]).join('; ');

    const scope = await getAccountWorkspaceScope((path) =>
      app.request(`http://localhost${path}`, { headers: { Cookie: cookie } }, env),
    );
    const { workspaceId, projectId } = scope;
    // Only the explicit workspace middleware's exact membership lookup is
    // authorization cost. Scoped holder/member validations stay in the domain budget.
    const authorizationSql =
      'select "members"."workspace_id", "members"."user_id", "members"."role", "members"."joined_at", "user"."name", "user"."email", "user"."image" from "members" left join "user" on "user"."id" = "members"."user_id" where "members"."workspace_id" = ? and "members"."user_id" = ?';
    const authorizationReads = (capture: { queries: LoggedQuery[] }) =>
      capture.queries.filter(
        (query) =>
          query.sql.replace(/\s+/g, ' ').replace(/[()]/g, '').trim() === authorizationSql &&
          query.params.length === 2 &&
          query.params[0] === workspaceId &&
          query.params[1] === scope.userId,
      );
    const projectResolutionReads = (capture: { queries: LoggedQuery[] }) =>
      capture.queries.filter(
        (query) =>
          query.caller.includes('repositories/project.ts') &&
          query.sql.includes('from "projects" where') &&
          query.params.length === 2 &&
          query.params[0] === projectId &&
          query.params[1] === workspaceId,
      );
    const expectBudget = (
      capture: { count: number; queries: LoggedQuery[] },
      domainBudget: number,
      requests: number,
    ) => {
      const authorization = authorizationReads(capture);
      const projectResolution = projectResolutionReads(capture);
      expect(authorization, JSON.stringify(authorization.map(({ caller, params }) => ({ caller, params })))).toHaveLength(requests);
      expect(projectResolution).toHaveLength(requests);
      expect(
        capture.count - authorization.length - projectResolution.length,
        JSON.stringify(capture.queries.map(({ caller, sql, params }) => ({ caller, sql, params }))),
      ).toBeLessThanOrEqual(domainBudget);
    };

    // Create a notepad for testing
    const createRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          title: 'Budget Notepad',
          content: '[]',
        }),
      },
      env,
    );
    expect(createRes.status).toBe(201);
    const createData = (await createRes.json()) as any;
    const notepadId = createData.id;

    // -------------------------------------------------------------------------
    // Scenario F: Opening a notepad (read path)
    // Domain budget: <= 6 queries, plus one live membership and project-scope
    // resolution read per request.
    // -------------------------------------------------------------------------
    startCapture();
    const getRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(getRes.status).toBe(200);
    const capFGet = stopCapture();
    startCapture();
    const treeRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      { headers: { Cookie: cookie } },
      env,
    );
    expect(treeRes.status).toBe(200);
    const capF = stopCapture();
    expectBudget(capFGet, 6, 1);
    expectBudget(capF, 6, 1);
    expectBudget({
      count: capFGet.count + capF.count,
      queries: [...capFGet.queries, ...capF.queries],
    }, 6, 2);

    // -------------------------------------------------------------------------
    // Scenario E: Lock heartbeat
    // Budget: <= 2 queries (findById + upsert lock)
    // -------------------------------------------------------------------------
    startCapture();
    const lockRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/lock`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ clientId: 'client-1' }),
      },
      env,
    );
    expect(lockRes.status).toBe(200);
    const capE = stopCapture();
    expectBudget(capE, 2, 1);

    // -------------------------------------------------------------------------
    // Scenario A: Change title only
    // Budget: <= 2 queries (findById + UPDATE)
    // -------------------------------------------------------------------------
    startCapture();
    const patchRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'New Notepad Title' }),
      },
      env,
    );
    expect(patchRes.status).toBe(200);
    const capA = stopCapture();
    expectBudget(capA, 2, 1);

    // -------------------------------------------------------------------------
    // Scenario B: Type a few words in body (Content Save)
    // Budget: <= 4 queries (findById + lock check + listLinks + runBatch)
    // -------------------------------------------------------------------------
    const bodyContent = JSON.stringify([
      {
        id: 'b1',
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hello world from test', styles: {} }],
      },
    ]);
    startCapture();
    const saveRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ content: bodyContent, baseVersion: 1, clientId: 'client-1' }),
      },
      env,
    );
    expect(saveRes.status).toBe(200);
    const capB = stopCapture();
    expectBudget(capB, 4, 1);

    // -------------------------------------------------------------------------
    // Scenario C: Title + Body together
    // Budget: <= 6 queries (Title PATCH <= 2 + Content PUT <= 4)
    // -------------------------------------------------------------------------
    startCapture();
    const patchBothRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ title: 'Second Notepad Title' }),
      },
      env,
    );
    expect(patchBothRes.status).toBe(200);
    const saveBothRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ content: bodyContent, baseVersion: 2, clientId: 'client-1' }),
      },
      env,
    );
    expect(saveBothRes.status).toBe(200);
    const capC = stopCapture();
    expectBudget(capC, 6, 2);

    // -------------------------------------------------------------------------
    // Scenario D: One full autosave cycle (focus / claim lock + save content + blur release)
    // Budget: <= 8 queries (Lock acquire <= 2 + Content save <= 4 + Lock release <= 2)
    // -------------------------------------------------------------------------
    startCapture();
    const cycleLock = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/lock`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ clientId: 'client-1' }),
      },
      env,
    );
    expect(cycleLock.status).toBe(200);
    const cycleSave = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ content: bodyContent, baseVersion: 3, clientId: 'client-1' }),
      },
      env,
    );
    expect(cycleSave.status).toBe(200);
    const cycleRelease = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/lock`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ clientId: 'client-1' }),
      },
      env,
    );
    expect(cycleRelease.status).toBe(200);
    const capD = stopCapture();
    expectBudget(capD, 8, 3);

    // -------------------------------------------------------------------------
    // Optimistic Version Conflict Verification
    // Stale baseVersion must fail with 409 conflict
    // -------------------------------------------------------------------------
    const conflictRes = await app.request(
      `http://localhost/api/workspaces/${workspaceId}/projects/${projectId}/notepads/${notepadId}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ content: bodyContent, baseVersion: 1, clientId: 'client-1' }),
      },
      env,
    );
    expect(conflictRes.status).toBe(409);

    // -------------------------------------------------------------------------
    // Live Membership Authorization & Logout
    // -------------------------------------------------------------------------
    // Repeated authenticated requests must still resolve current permissions.
    startCapture();
    await app.request(`http://localhost/api/workspaces/${workspaceId}`, { headers: { Cookie: cookie } }, env);
    const warmCap = stopCapture();
    expect(authorizationReads(warmCap)).toHaveLength(1);

    // Logout
    const signOutRes = await app.request(
      'http://localhost/api/auth/sign-out',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
          Cookie: cookie,
        },
      },
      env,
    );
    expect(signOutRes.status).toBe(200);

    // Verify Better Auth clears session cookies on logout
    const clearedCookies = signOutRes.headers.getSetCookie
      ? signOutRes.headers.getSetCookie()
      : [signOutRes.headers.get('set-cookie')!];
    expect(clearedCookies.some((c) => c.includes('Max-Age=0') || c.includes('1970'))).toBe(true);

    // Requests without cookie are 401 unauthorized
    const accountAfterLogout = await app.request('http://localhost/api/account', {}, env);
    expect(accountAfterLogout.status).toBe(401);
  });
});
