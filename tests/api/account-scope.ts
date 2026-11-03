export interface AccountWorkspaceScope {
  userId: string;
  workspaceId: string;
  projectId: string;
}

/** Resolve fixture identity and its starter project through the explicit account/workspace APIs. */
export async function getAccountWorkspaceScope(
  request: (path: string) => Response | Promise<Response>,
): Promise<AccountWorkspaceScope> {
  const accountResponse = await request('/api/account');
  if (!accountResponse.ok) throw new Error(`Account lookup failed: ${accountResponse.status}`);
  const account = (await accountResponse.json()) as {
    user: { id: string };
    workspaces: Array<{ id: string }>;
  };
  const workspaceId = account.workspaces[0]?.id;
  if (!workspaceId) throw new Error('Test account has no workspace');

  const projectsResponse = await request(`/api/workspaces/${workspaceId}/projects`);
  if (!projectsResponse.ok) throw new Error(`Project lookup failed: ${projectsResponse.status}`);
  const projects = (await projectsResponse.json()) as Array<{ id: string }>;
  const projectId = projects[0]?.id;
  if (!projectId) throw new Error('Test workspace has no project');

  return { userId: account.user.id, workspaceId, projectId };
}
