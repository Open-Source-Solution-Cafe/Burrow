import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createD1Db } from '../../src/core/adapters/db/d1/client';
import { createProjectFileRepository } from '../../src/core/adapters/db/d1/repositories/project-file';
import { createWorkerApp } from '../../src/worker/index';
import { expectInvariantsHold } from './helpers';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);
const projectFiles = createProjectFileRepository(createD1Db(env.DB));

const request = (path: string, cookie = '', init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('Cookie', cookie);
  return app.request(`http://localhost${path}`, { ...init, headers }, env);
};
const postJson = (path: string, body: unknown, cookie = '') =>
  request(path, cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const projectPath = (workspaceId: string, projectId: string) =>
  `/api/workspaces/${workspaceId}/projects/${projectId}`;
const filePath = (workspaceId: string, projectId: string, key: string) =>
  `${projectPath(workspaceId, projectId)}/files/${encodeURIComponent(key)}`;
const upload = (
  workspaceId: string,
  projectId: string,
  cookie: string,
  name: string,
  bytes: Uint8Array | string,
  contentType: string,
) => {
  const formData = new FormData();
  formData.append('file', new File([bytes], name, { type: contentType }));
  return request(`${projectPath(workspaceId, projectId)}/uploads`, cookie, {
    method: 'POST',
    body: formData,
  });
};

describe('project-scoped storage and uploads', () => {
  const bootstrapToken = env.BOOTSTRAP_TOKEN || 'test-bootstrap-token';
  let ownerCookie = '';
  let editorCookie = '';
  let viewerCookie = '';
  let ownerUserId = '';
  let workspaceId = '';
  let projectId = '';
  let secondWorkspaceId = '';
  let secondProjectId = '';

  let uploadedPngKey = '';
  let uploadedSvgKey = '';
  let uploadedJpegKey = '';
  let secondProjectKey = '';

  it('sets up two projects and workspace-scoped editor/viewer memberships', async () => {
    const ownerRes = await postJson('/api/auth/sign-up/email', {
      email: 'storage-owner@example.com',
      password: 'password123',
      name: 'Storage Owner',
      bootstrapToken,
    });
    expect(ownerRes.status).toBe(200);
    ownerCookie = ownerRes.headers.get('set-cookie')!;

    const scope = await getAccountWorkspaceScope((path) => request(path, ownerCookie));
    ownerUserId = scope.userId;
    workspaceId = scope.workspaceId;
    projectId = scope.projectId;

    const secondWorkspaceRes = await postJson(
      '/api/workspaces',
      { name: 'Storage second workspace', requestId: crypto.randomUUID() },
      ownerCookie,
    );
    expect(secondWorkspaceRes.status).toBe(201);
    const secondWorkspace = (await secondWorkspaceRes.json()) as {
      workspace: { id: string };
      project: { id: string };
    };
    secondWorkspaceId = secondWorkspace.workspace.id;
    secondProjectId = secondWorkspace.project.id;

    const invite = async (email: string, role: 'editor' | 'viewer') => {
      const response = await postJson(
        `/api/workspaces/${workspaceId}/invites`,
        { email, role },
        ownerCookie,
      );
      expect(response.status).toBe(200);
      const { token } = (await response.json()) as { token: string };
      const signup = await postJson('/api/auth/sign-up/email', {
        email,
        password: 'password123',
        name: role === 'editor' ? 'Storage Editor' : 'Storage Viewer',
        inviteToken: token,
      });
      expect(signup.status).toBe(200);
      return signup.headers.get('set-cookie')!;
    };
    editorCookie = await invite('storage-editor@example.com', 'editor');
    viewerCookie = await invite('storage-viewer@example.com', 'viewer');
  });

  it('requires authentication and editor membership on the scoped upload route', async () => {
    const unauthenticated = await upload(
      workspaceId,
      projectId,
      '',
      'small.png',
      new Uint8Array([1, 2, 3]),
      'image/png',
    );
    expect(unauthenticated.status).toBe(401);

    const viewerUpload = await upload(
      workspaceId,
      projectId,
      viewerCookie,
      'small.png',
      new Uint8Array([1, 2, 3]),
      'image/png',
    );
    expect(viewerUpload.status).toBe(403);
  });

  it('rejects unscoped uploads for signed-in users', async () => {
    const formData = new FormData();
    formData.append('file', new File([new Uint8Array([1, 2, 3])], 'legacy.png', { type: 'image/png' }));
    const response = await request('/api/uploads', editorCookie, { method: 'POST', body: formData });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: { code: 'explicit_scope_required' } });
  });

  it('rejects unsupported MIME types and uploads over 5 MB', async () => {
    const invalidMime = await upload(
      workspaceId,
      projectId,
      editorCookie,
      'binary.bin',
      new Uint8Array([1, 2, 3]),
      'application/x-binary',
    );
    expect(invalidMime.status).toBe(400);
    expect(await invalidMime.json()).toMatchObject({ error: { code: 'invalid_mime_type' } });

    const spoofedImage = await upload(
      workspaceId,
      projectId,
      editorCookie,
      'spoofed.png',
      new Uint8Array([1, 2, 3]),
      'image/png',
    );
    expect(spoofedImage.status).toBe(400);
    expect(await spoofedImage.json()).toMatchObject({ error: { code: 'invalid_image_content' } });

    const tooLarge = await upload(
      workspaceId,
      projectId,
      editorCookie,
      'large.png',
      new Uint8Array(5 * 1024 * 1024 + 10),
      'image/png',
    );
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('uploads supported images under workspace/project keys and returns scoped URLs', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const pngRes = await upload(workspaceId, projectId, editorCookie, 'sample.png', pngBytes, 'image/png');
    expect(pngRes.status).toBe(200);
    const png = (await pngRes.json()) as { key: string; url: string };
    expect(png.key).toMatch(
      new RegExp(`^${workspaceId}/${projectId}/[a-zA-Z0-9_-]+\\.png$`),
    );
    expect(png.url).toContain(
      `/api/workspaces/${workspaceId}/projects/${projectId}/files/${encodeURIComponent(png.key)}`,
    );
    uploadedPngKey = png.key;

    const jpeg = await upload(
      workspaceId,
      projectId,
      editorCookie,
      'sample.jpg',
      new Uint8Array([255, 216, 255, 224]),
      'image/jpeg',
    );
    expect(jpeg.status).toBe(200);
    const jpegData = (await jpeg.json()) as { key: string };
    expect(jpegData.key).toMatch(
      new RegExp(`^${workspaceId}/${projectId}/[a-zA-Z0-9_-]+\\.jpg$`),
    );
    uploadedJpegKey = jpegData.key;

    const svg = await upload(
      workspaceId,
      projectId,
      editorCookie,
      'vector.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>',
      'image/svg+xml',
    );
    expect(svg.status).toBe(200);
    const svgData = (await svg.json()) as { key: string };
    expect(svgData.key).toMatch(
      new RegExp(`^${workspaceId}/${projectId}/[a-zA-Z0-9_-]+\\.svg$`),
    );
    uploadedSvgKey = svgData.key;

    const secondProjectUpload = await upload(
      secondWorkspaceId,
      secondProjectId,
      ownerCookie,
      'other-project.png',
      pngBytes,
      'image/png',
    );
    expect(secondProjectUpload.status).toBe(200);
    secondProjectKey = ((await secondProjectUpload.json()) as { key: string }).key;
    expect(secondProjectKey).toMatch(
      new RegExp(`^${secondWorkspaceId}/${secondProjectId}/[a-zA-Z0-9_-]+\\.png$`),
    );
  });

  it('serves registered files only through the scoped route or one-project legacy resolution', async () => {
    const png = await request(filePath(workspaceId, projectId, uploadedPngKey), editorCookie);
    expect(png.status).toBe(200);
    expect(png.headers.get('Content-Type')).toBe('image/png');
    expect(png.headers.get('Cache-Control')).toBe('private, no-store');
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    const jpeg = await request(filePath(workspaceId, projectId, uploadedJpegKey), editorCookie);
    expect(jpeg.status).toBe(200);
    expect(jpeg.headers.get('Content-Type')).toBe('image/jpeg');

    const svg = await request(filePath(workspaceId, projectId, uploadedSvgKey), editorCookie);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(svg.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(await svg.text()).toContain('<circle r="10"/>');

    const anonymousFile = await request(filePath(workspaceId, projectId, uploadedPngKey));
    expect(anonymousFile.status).toBe(401);

    const wrongProject = await request(
      filePath(workspaceId, projectId, secondProjectKey),
      ownerCookie,
    );
    expect(wrongProject.status).toBe(404);
    const wrongWorkspaceProject = await request(
      filePath(secondWorkspaceId, projectId, uploadedPngKey),
      ownerCookie,
    );
    expect(wrongWorkspaceProject.status).toBe(404);
    const nonMember = await request(
      filePath(secondWorkspaceId, secondProjectId, secondProjectKey),
      editorCookie,
    );
    expect(nonMember.status).toBe(404);

    const legacyMemberRead = await request(
      `/api/files/${encodeURIComponent(uploadedPngKey)}`,
      editorCookie,
    );
    expect(legacyMemberRead.status).toBe(200);
    const legacyNonMemberRead = await request(
      `/api/files/${encodeURIComponent(secondProjectKey)}`,
      editorCookie,
    );
    expect(legacyNonMemberRead.status).toBe(404);
    const legacyOwnerRead = await request(
      `/api/files/${encodeURIComponent(secondProjectKey)}`,
      ownerCookie,
    );
    expect(legacyOwnerRead.status).toBe(200);
  });

  it('rejects malformed and traversal file keys', async () => {
    const malformed = await request(
      `${projectPath(workspaceId, projectId)}/files/%E0%A4%A`,
      editorCookie,
    );
    expect(malformed.status).toBe(400);

    const traversalKey = `${workspaceId}/${projectId}/../evil.png`;
    const traversal = await request(filePath(workspaceId, projectId, traversalKey), editorCookie);
    expect(traversal.status).toBe(404);
  });

  it('retains registered bytes when an individual notepad is deleted', async () => {
    const createNote = await postJson(
      `${projectPath(workspaceId, projectId)}/notepads`,
      { title: 'Registered cover note' },
      ownerCookie,
    );
    expect(createNote.status).toBe(201);
    const { id: notepadId } = (await createNote.json()) as { id: string };
    const setCover = await request(
      `${projectPath(workspaceId, projectId)}/notepads/${notepadId}`,
      ownerCookie,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coverKey: uploadedPngKey }) },
    );
    expect(setCover.status).toBe(200);

    const softDelete = await request(
      `${projectPath(workspaceId, projectId)}/notepads/${notepadId}`,
      ownerCookie,
      { method: 'DELETE' },
    );
    expect(softDelete.status).toBe(200);
    const permanentDelete = await request(
      `${projectPath(workspaceId, projectId)}/notepads/${notepadId}/permanent`,
      ownerCookie,
      { method: 'DELETE' },
    );
    expect(permanentDelete.status).toBe(200);

    expect(await env.FILES.get(uploadedPngKey)).not.toBeNull();
    expect((await request(filePath(workspaceId, projectId, uploadedPngKey), editorCookie)).status).toBe(200);
  });

  it('cleans project files on deletion only when no other project registers the key', async () => {
    const projectName = 'Project With Registered Covers';
    const projectResponse = await postJson(
      `/api/workspaces/${workspaceId}/projects`,
      { name: projectName },
      ownerCookie,
    );
    expect(projectResponse.status).toBe(201);
    const { id: projectToDelete } = (await projectResponse.json()) as { id: string };

    const uniqueUpload = await upload(
      workspaceId,
      projectToDelete,
      ownerCookie,
      'unique-cover.png',
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      'image/png',
    );
    expect(uniqueUpload.status).toBe(200);
    const uniqueKey = ((await uniqueUpload.json()) as { key: string }).key;

    const uniqueNoteResponse = await postJson(
      `${projectPath(workspaceId, projectToDelete)}/notepads`,
      { title: 'Unique project cover' },
      ownerCookie,
    );
    expect(uniqueNoteResponse.status).toBe(201);
    const { id: uniqueNoteId } = (await uniqueNoteResponse.json()) as { id: string };
    const uniqueCoverSet = await request(
      `${projectPath(workspaceId, projectToDelete)}/notepads/${uniqueNoteId}`,
      ownerCookie,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coverKey: uniqueKey }) },
    );
    expect(uniqueCoverSet.status).toBe(200);

    const sharedKey = `${workspaceId}/${projectId}/legacy-shared-${crypto.randomUUID()}.png`;
    await env.FILES.put(sharedKey, new Uint8Array([9, 8, 7]), {
      httpMetadata: { contentType: 'image/png' },
    });
    const sharedMetadata = {
      storageKey: sharedKey,
      contentType: 'image/png',
      createdBy: ownerUserId,
      createdAt: Date.now(),
    };
    expect(await projectFiles.register({ ...sharedMetadata, projectId })).toBe(true);
    expect(await projectFiles.register({ ...sharedMetadata, projectId: projectToDelete })).toBe(true);

    const sharedNoteResponse = await postJson(
      `${projectPath(workspaceId, projectToDelete)}/notepads`,
      { title: 'Shared legacy project cover' },
      ownerCookie,
    );
    expect(sharedNoteResponse.status).toBe(201);
    const { id: sharedNoteId } = (await sharedNoteResponse.json()) as { id: string };
    const sharedCoverSet = await request(
      `${projectPath(workspaceId, projectToDelete)}/notepads/${sharedNoteId}`,
      ownerCookie,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coverKey: sharedKey }) },
    );
    expect(sharedCoverSet.status).toBe(200);

    const deleteProject = await request(
      `/api/workspaces/${workspaceId}/projects/${projectToDelete}?confirm=${encodeURIComponent(projectName)}`,
      ownerCookie,
      { method: 'DELETE' },
    );
    expect(deleteProject.status).toBe(200);

    expect(await env.FILES.get(uniqueKey)).toBeNull();
    expect(await env.FILES.get(sharedKey)).not.toBeNull();
    expect(await projectFiles.findByProjectAndKey(projectToDelete, uniqueKey)).toBeNull();
    expect(await projectFiles.findByProjectAndKey(projectToDelete, sharedKey)).toBeNull();
    expect(await projectFiles.findByProjectAndKey(projectId, sharedKey)).not.toBeNull();
    expect(await projectFiles.countByStorageKey(sharedKey)).toBe(1);
    const legacySharedRead = await request(`/api/files/${encodeURIComponent(sharedKey)}`, editorCookie);
    expect(legacySharedRead.status).toBe(200);
    await expectInvariantsHold(env.DB);
  });
});
