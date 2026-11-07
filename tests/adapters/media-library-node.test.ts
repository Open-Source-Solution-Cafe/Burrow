import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/core/app';
import { createProjectFileRoutes } from '../../src/core/routes/project-files';
import { openPersistence } from './node-fixture';

describe('sqlite media library endpoint contract', () => {
  it('persists upload metadata, includes legacy rows, and isolates project lists and reads', async () => {
    const fixture = await openPersistence('sqlite', '');
    try {
      await fixture.query(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u', 'User', 'u@test.com', 0, 1, 1)",
      );
      await fixture.query(
        "INSERT INTO workspaces (id,name,created_by,created_at) VALUES ('w','Workspace','u',1), ('foreign','Foreign','u',1)",
      );
      await fixture.query(
        "INSERT INTO projects (id,workspace_id,name,position,created_at,updated_at) VALUES ('p','w','One','a0',1,1), ('other','w','Two','a1',1,1), ('foreign-p','foreign','Foreign','a0',1,1)",
      );
      await fixture.query(
        "INSERT INTO members (workspace_id,user_id,role,joined_at) VALUES ('w','u','viewer',1)",
      );
      await fixture.projectFiles.register({
        projectId: 'p',
        storageKey: 'legacy.png',
        contentType: 'image/png',
        createdBy: 'u',
        createdAt: 1,
      });
      await fixture.projectFiles.register({
        projectId: 'other',
        storageKey: 'private.png',
        contentType: 'image/png',
        createdBy: 'u',
        createdAt: 1,
      });
      const objects = new Map<string, { body: Uint8Array; contentType: string }>();
      const app = new Hono<Env>();
      app.use('*', async (c, next) => {
        if (c.req.header('Authorization') === 'test') c.set('identity', { userId: 'u' });
        await next();
      });
      app.onError((error, c) =>
        c.json({ error: error.message }, ((error as { status?: number }).status as never) || 500),
      );
      app.route(
        '/api',
        createProjectFileRoutes({
          projects: fixture.projects,
          members: fixture.createMembers(),
          files: fixture.projectFiles,
          storage: {
            put: async (key, data, contentType) => {
              objects.set(key, {
                body: new Uint8Array(data as ArrayBuffer),
                contentType: contentType!,
              });
            },
            get: async (key) => objects.get(key) ?? null,
            delete: async (key) => {
              objects.delete(key);
            },
            deletePrefix: async () => {},
            listObjects: async () => [...objects.keys()],
          },
        }),
      );
      const request = (path: string, init: RequestInit = {}) =>
        app.request(`http://localhost/api${path}`, { ...init, headers: { Authorization: 'test' } });
      const path = '/workspaces/w/projects/p';
      expect((await app.request(`http://localhost/api${path}/media`)).status).toBe(401);
      const legacyList = await request(`${path}/media`);
      expect(legacyList.status).toBe(200);
      expect(legacyList.headers.get('cache-control')).toBe('private, no-store');
      expect(await legacyList.json()).toEqual([
        {
          key: 'legacy.png',
          filename: null,
          byteSize: null,
          contentType: 'image/png',
          createdAt: 1,
          url: 'http://localhost/api/workspaces/w/projects/p/files/legacy.png',
        },
      ]);
      expect((await request('/workspaces/foreign/projects/foreign-p/media')).status).toBe(404);
      expect((await request('/workspaces/w/projects/foreign-p/media')).status).toBe(404);
      expect((await request(`${path}/files/private.png`)).status).toBe(404);
      const upload = () => {
        const form = new FormData();
        form.append(
          'file',
          new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], 'diagram.png', {
            type: 'image/png',
          }),
        );
        return request(`${path}/uploads`, { method: 'POST', body: form });
      };
      expect((await upload()).status).toBe(403);
      await fixture.query(
        "UPDATE members SET role='editor' WHERE workspace_id='w' AND user_id='u'",
      );
      const uploaded = await upload();
      expect(uploaded.status).toBe(200);
      const { key } = (await uploaded.json()) as { key: string };
      expect(await fixture.projectFiles.findByProjectAndKey('p', key)).toMatchObject({
        filename: 'diagram.png',
        byteSize: 9,
      });
      expect(await fixture.projectFiles.findByProjectAndKey('other', key)).toBeNull();
      const listed = (await (await request(`${path}/media`)).json()) as Array<{
        key: string;
        filename: string | null;
        byteSize: number | null;
      }>;
      expect(listed.map((file) => file.key)).toEqual([key, 'legacy.png']);
      expect(listed[0]).toMatchObject({ filename: 'diagram.png', byteSize: 9 });
      expect((await request(`${path}/files/${encodeURIComponent(key)}`)).status).toBe(200);
    } finally {
      await fixture.close();
    }
  });
});
