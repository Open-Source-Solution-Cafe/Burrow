import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createWorkerApp } from '../../src/worker';
import { getAccountWorkspaceScope } from './account-scope';

const app = createWorkerApp(env);

it('keeps explicit project resources inside the requested workspace and project', async () => {
  const request = (path: string, cookie = '', init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    return app.request(`http://localhost${path}`, { ...init, headers }, env);
  };
  const post = (path: string, body: unknown, cookie = '') =>
    request(path, cookie, { method: 'POST', body: JSON.stringify(body) });

  const signup = await post('/api/auth/sign-up/email', {
    name: 'Project resource owner',
    email: 'project-resource-owner@example.test',
    password: 'password123',
    bootstrapToken: env.BOOTSTRAP_TOKEN || 'test-bootstrap-token',
  });
  expect(signup.status).toBe(200);
  const ownerCookie = signup.headers.get('set-cookie')!;
  const ownerScope = await getAccountWorkspaceScope((path) => request(path, ownerCookie));
  const workspaceOne = ownerScope.workspaceId;
  const projectOne = ownerScope.projectId;

  const workspaceTwoResponse = await post(
    '/api/workspaces',
    { name: 'Second resource workspace', requestId: crypto.randomUUID() },
    ownerCookie,
  );
  expect(workspaceTwoResponse.status).toBe(201);
  const workspaceTwoBody = (await workspaceTwoResponse.json()) as {
    workspace: { id: string };
    project: { id: string };
  };
  const workspaceTwo = workspaceTwoBody.workspace.id;
  const projectTwo = workspaceTwoBody.project.id;

  const inviteResponse = await post(
    `/api/workspaces/${workspaceOne}/invites`,
    { email: 'project-resource-member@example.test', role: 'viewer' },
    ownerCookie,
  );
  expect(inviteResponse.status).toBe(200);
  const invite = (await inviteResponse.json()) as { token: string };
  const memberSignup = await post('/api/auth/sign-up/email', {
    name: 'Project resource member',
    email: 'project-resource-member@example.test',
    password: 'password123',
    inviteToken: invite.token,
  });
  expect(memberSignup.status).toBe(200);
  const memberCookie = memberSignup.headers.get('set-cookie')!;

  const createNote = (workspaceId: string, projectId: string, title: string, cookie: string) =>
    post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/notepads`,
      { title },
      cookie,
    );
  const noteOneResponse = await createNote(workspaceOne, projectOne, 'Workspace one note', ownerCookie);
  const noteTwoResponse = await createNote(workspaceTwo, projectTwo, 'Workspace two note', ownerCookie);
  expect(noteOneResponse.status).toBe(201);
  expect(noteTwoResponse.status).toBe(201);
  const noteOne = (await noteOneResponse.json()) as { id: string };
  const noteTwo = (await noteTwoResponse.json()) as { id: string };

  const boardResponse = await post(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/boards`,
    { name: 'Workspace two board' },
    ownerCookie,
  );
  expect(boardResponse.status).toBe(201);
  const board = (await boardResponse.json()) as { id: string };
  const boardDetail = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/boards/${board.id}`,
    ownerCookie,
  );
  expect(boardDetail.status).toBe(200);
  const boardData = (await boardDetail.json()) as { columns: Array<{ id: string }> };
  const columnId = boardData.columns[0]!.id;

  const tagResponse = await post(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/tags`,
    { name: 'Workspace two tag' },
    ownerCookie,
  );
  expect(tagResponse.status).toBe(201);
  const tag = (await tagResponse.json()) as { id: string };
  const tagsTwo = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/tags`,
    ownerCookie,
  );
  expect(tagsTwo.status).toBe(200);
  expect(((await tagsTwo.json()) as Array<{ id: string }>).map(({ id }) => id)).toContain(tag.id);
  const tagsOne = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/tags`,
    ownerCookie,
  );
  expect(tagsOne.status).toBe(200);
  expect(await tagsOne.json()).toEqual([]);
  const setNoteTags = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/notepads/${noteTwo.id}/tags`,
    ownerCookie,
    { method: 'PUT', body: JSON.stringify({ tagIds: [tag.id] }) },
  );
  expect(setNoteTags.status).toBe(200);

  const cardResponse = await post(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/columns/${columnId}/cards`,
    { title: 'Workspace two card', tagIds: [tag.id] },
    ownerCookie,
  );
  expect(cardResponse.status).toBe(201);
  const card = (await cardResponse.json()) as { cardId: string };

  const listOne = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/notepads`,
    ownerCookie,
  );
  expect(listOne.status).toBe(200);
  const listedNotes = (await listOne.json()) as Array<{ id: string }>;
  expect(listedNotes.map(({ id }) => id)).toContain(noteOne.id);
  expect(listedNotes.map(({ id }) => id)).not.toContain(noteTwo.id);

  const detail = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/notepads/${noteOne.id}`,
    ownerCookie,
  );
  expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ id: noteOne.id, projectId: projectOne });

  const noteTwoDetail = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/notepads/${noteTwo.id}`,
    ownerCookie,
  );
  expect(noteTwoDetail.status).toBe(200);
  expect(await noteTwoDetail.json()).toMatchObject({
    id: noteTwo.id,
    tags: [{ id: tag.id }],
  });

  const projectMismatch = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectTwo}/notepads`,
    ownerCookie,
  );
  expect(projectMismatch.status).toBe(404);
  const projectMismatchBody = await projectMismatch.json();
  expect(projectMismatchBody).toMatchObject({ error: { code: 'not_found' } });
  const mixedDetail = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/notepads/${noteTwo.id}`,
    ownerCookie,
  );
  expect(mixedDetail.status).toBe(404);
  const mixedBoardDetail = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/boards/${board.id}`,
    ownerCookie,
  );
  expect(mixedBoardDetail.status).toBe(404);
  const mixedTagUpdate = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/tags/${tag.id}`,
    ownerCookie,
    { method: 'PATCH', body: JSON.stringify({ name: 'Must not move' }) },
  );
  expect(mixedTagUpdate.status).toBe(404);
  const mixedCardDetail = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/cards/${card.cardId}`,
    ownerCookie,
  );
  expect(mixedCardDetail.status).toBe(404);
  const mixedComments = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/cards/${card.cardId}/comments`,
    ownerCookie,
  );
  expect(mixedComments.status).toBe(404);

  const cardDetail = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/cards/${card.cardId}`,
    ownerCookie,
  );
  expect(cardDetail.status).toBe(200);
  expect(await cardDetail.json()).toMatchObject({ id: card.cardId, tags: [{ id: tag.id }] });
  const commentResponse = await post(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/cards/${card.cardId}/comments`,
    { content: 'Scoped comment' },
    ownerCookie,
  );
  expect(commentResponse.status).toBe(201);
  const comments = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/cards/${card.cardId}/comments`,
    ownerCookie,
  );
  expect(comments.status).toBe(200);
  expect(await comments.json()).toMatchObject([{ content: 'Scoped comment' }]);

  const rejectedCreate = await createNote(
    workspaceOne,
    projectTwo,
    'Must not be created',
    ownerCookie,
  );
  expect(rejectedCreate.status).toBe(404);
  const projectTwoNotes = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/notepads`,
    ownerCookie,
  );
  expect(projectTwoNotes.status).toBe(200);
  expect(((await projectTwoNotes.json()) as Array<{ title: string }>).map(({ title }) => title)).not.toContain(
    'Must not be created',
  );

  const deleteNote = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/notepads/${noteTwo.id}`,
    ownerCookie,
    { method: 'DELETE' },
  );
  expect(deleteNote.status).toBe(200);
  const projectTwoTrash = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/trash`,
    ownerCookie,
  );
  expect(projectTwoTrash.status).toBe(200);
  expect(await projectTwoTrash.json()).toMatchObject({
    notepads: expect.arrayContaining([expect.objectContaining({ id: noteTwo.id })]),
  });
  const mixedTrash = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectTwo}/trash`,
    ownerCookie,
  );
  expect(mixedTrash.status).toBe(404);

  const boardsOne = await request(
    `/api/workspaces/${workspaceOne}/projects/${projectOne}/boards`,
    ownerCookie,
  );
  expect(boardsOne.status).toBe(200);
  expect(await boardsOne.json()).toEqual([]);
  const boardsTwo = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/boards`,
    ownerCookie,
  );
  expect(boardsTwo.status).toBe(200);
  expect(((await boardsTwo.json()) as Array<{ id: string }>).map(({ id }) => id)).toContain(board.id);

  const memberWorkspaceMismatch = await request(
    `/api/workspaces/${workspaceTwo}/projects/${projectTwo}/notepads`,
    memberCookie,
  );
  expect(memberWorkspaceMismatch.status).toBe(404);
  expect(await memberWorkspaceMismatch.json()).toMatchObject({ error: { code: 'not_found' } });

  const legacyRequest = await request(`/api/projects/${projectOne}/notepads`, ownerCookie);
  expect(legacyRequest.status).toBe(404);
});
