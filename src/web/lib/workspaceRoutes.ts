export type WorkspaceId = string;
export type ProjectId = string;

export type WorkspaceRoute = { id: WorkspaceId; name: string };
export type ProjectRoute = { id: ProjectId };

export type ProjectTarget = {
  to: '/w/$workspaceId/p/$projectId';
  params: { workspaceId: WorkspaceId; projectId: ProjectId };
};

export function projectTarget(workspaceId: WorkspaceId, projectId: ProjectId): ProjectTarget {
  return {
    to: '/w/$workspaceId/p/$projectId',
    params: { workspaceId, projectId },
  };
}

export function notepadTarget(workspaceId: WorkspaceId, projectId: ProjectId, notepadId: string) {
  return {
    to: '/w/$workspaceId/p/$projectId/notepads/$notepadId' as const,
    params: { workspaceId, projectId, notepadId },
  };
}

export function boardTarget(workspaceId: WorkspaceId, projectId: ProjectId, boardId: string) {
  return {
    to: '/w/$workspaceId/p/$projectId/boards/$boardId' as const,
    params: { workspaceId, projectId, boardId },
  };
}

export function trashTarget(workspaceId: WorkspaceId, projectId: ProjectId) {
  return {
    to: '/w/$workspaceId/p/$projectId/trash' as const,
    params: { workspaceId, projectId },
  };
}

export function projectLibraryTarget(workspaceId: WorkspaceId, projectId: ProjectId) {
  return {
    to: '/w/$workspaceId/p/$projectId/library' as const,
    params: { workspaceId, projectId },
  };
}

export function workspaceTarget(workspaceId: WorkspaceId) {
  return {
    to: '/w/$workspaceId' as const,
    params: { workspaceId },
  };
}

export function workspaceTasksTarget(workspaceId: WorkspaceId) {
  return {
    to: '/w/$workspaceId/tasks' as const,
    params: { workspaceId },
  };
}

export function workspaceSettingsTarget(workspaceId: WorkspaceId) {
  return {
    to: '/w/$workspaceId/settings' as const,
    params: { workspaceId },
  };
}

export function workspaceMembersTarget(workspaceId: WorkspaceId) {
  return {
    to: '/w/$workspaceId/settings/members' as const,
    params: { workspaceId },
  };
}

export function uniqueWorkspaceForProject(
  projectId: ProjectId,
  workspaces: readonly WorkspaceRoute[],
  projectsByWorkspace: ReadonlyMap<WorkspaceId, readonly ProjectRoute[]>,
): WorkspaceId | null {
  const matches = workspaces.filter((workspace) =>
    projectsByWorkspace.get(workspace.id)?.some((project) => project.id === projectId),
  );
  return matches.length === 1 ? matches[0]!.id : null;
}

export function projectPath(workspaceId: WorkspaceId, projectId: ProjectId): string {
  return `/w/${encodeURIComponent(workspaceId)}/p/${encodeURIComponent(projectId)}`;
}

/** Builds an API URL whose project resource is authorized inside the URL workspace. */
export function projectApiPath(
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  resourcePath = '',
): string {
  const suffix = resourcePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(projectId)}`;
  return suffix ? `${base}/${suffix}` : base;
}
