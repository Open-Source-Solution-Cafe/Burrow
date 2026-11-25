import { describe, expect, it } from 'vitest';
import {
  boardTarget,
  isProjectSettingsPath,
  isWorkspaceSettingsPath,
  notepadTarget,
  projectApiPath,
  projectPath,
  projectSettingsTarget,
  projectTarget,
  projectLibraryTarget,
  resolveLegacyProjectSettingsHash,
  resolveProjectSwitchTarget,
  trashTarget,
  uniqueWorkspaceForProject,
  workspaceMembersTarget,
  workspaceProfileTarget,
  workspaceSettingsTarget,
  workspaceTarget,
  workspaceTasksTarget,
} from './workspaceRoutes';

describe('workspace route helpers', () => {
  it('carries workspace and project IDs in every project target', () => {
    expect(projectLibraryTarget('workspace-a', 'project-a')).toEqual({
      to: '/w/$workspaceId/p/$projectId/library',
      params: { workspaceId: 'workspace-a', projectId: 'project-a' },
    });
    expect(projectTarget('workspace-a', 'project-a')).toEqual({
      to: '/w/$workspaceId/p/$projectId',
      params: { workspaceId: 'workspace-a', projectId: 'project-a' },
    });
    expect(notepadTarget('workspace-a', 'project-a', 'note-a').params).toEqual({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      notepadId: 'note-a',
    });
    expect(boardTarget('workspace-a', 'project-a', 'board-a').params).toEqual({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      boardId: 'board-a',
    });
    expect(trashTarget('workspace-a', 'project-a').params).toEqual({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    });
    expect(projectSettingsTarget('workspace-a', 'project-a')).toEqual({
      to: '/w/$workspaceId/p/$projectId/settings',
      params: { workspaceId: 'workspace-a', projectId: 'project-a' },
    });
  });

  it('keeps project switching on project settings only when already on project settings', () => {
    expect(isProjectSettingsPath('/w/ws-1/p/p-1/settings')).toBe(true);
    expect(isProjectSettingsPath('/w/ws-1/p/p-1/settings/')).toBe(true);
    expect(isProjectSettingsPath('/w/ws-1/settings')).toBe(false);
    expect(isProjectSettingsPath('/w/ws-1/p/p-1/boards/b-1')).toBe(false);

    expect(isWorkspaceSettingsPath('/w/ws-1/settings')).toBe(true);
    expect(isWorkspaceSettingsPath('/w/ws-1/settings/members')).toBe(true);
    expect(isWorkspaceSettingsPath('/w/ws-1/p/p-1/settings')).toBe(false);

    expect(resolveProjectSwitchTarget('/w/ws-1/p/p-1/settings', 'ws-1', 'p-2')).toEqual({
      to: '/w/$workspaceId/p/$projectId/settings',
      params: { workspaceId: 'ws-1', projectId: 'p-2' },
    });
    expect(resolveProjectSwitchTarget('/w/ws-1/p/p-1', 'ws-1', 'p-2')).toEqual({
      to: '/w/$workspaceId/p/$projectId',
      params: { workspaceId: 'ws-1', projectId: 'p-2' },
    });
    expect(resolveProjectSwitchTarget('/w/ws-1/settings', 'ws-1', 'p-2')).toEqual({
      to: '/w/$workspaceId/p/$projectId',
      params: { workspaceId: 'ws-1', projectId: 'p-2' },
    });
  });

  it('classifies legacy project-scoped hashes for redirection', () => {
    expect(resolveLegacyProjectSettingsHash('#project')).toEqual({
      isProjectHash: true,
      targetHash: undefined,
    });
    expect(resolveLegacyProjectSettingsHash('#tags')).toEqual({
      isProjectHash: true,
      targetHash: 'tags',
    });
    expect(resolveLegacyProjectSettingsHash('#file-uploads')).toEqual({
      isProjectHash: true,
      targetHash: 'uploads',
    });
    expect(resolveLegacyProjectSettingsHash('#features')).toEqual({
      isProjectHash: false,
    });
    expect(resolveLegacyProjectSettingsHash('')).toEqual({
      isProjectHash: false,
    });
  });

  it('builds scoped workspace paths and route targets', () => {
    expect(projectPath('workspace / A', 'project #1')).toBe(
      '/w/workspace%20%2F%20A/p/project%20%231',
    );
    expect(workspaceTarget('workspace-a')).toEqual({
      to: '/w/$workspaceId',
      params: { workspaceId: 'workspace-a' },
    });
    expect(workspaceTasksTarget('workspace-a').params.workspaceId).toBe('workspace-a');
    expect(workspaceProfileTarget('workspace-a')).toEqual({
      to: '/w/$workspaceId/profile',
      params: { workspaceId: 'workspace-a' },
    });
    expect(workspaceSettingsTarget('workspace-a').params.workspaceId).toBe('workspace-a');
    expect(workspaceMembersTarget('workspace-a').params.workspaceId).toBe('workspace-a');
  });

  it('builds project resource APIs with each path segment encoded', () => {
    expect(projectApiPath('workspace one', 'project/one', 'notepads/note one/lock')).toBe(
      '/api/workspaces/workspace%20one/projects/project%2Fone/notepads/note%20one/lock',
    );
  });

  it('resolves legacy project URLs only when exactly one membership contains the project', () => {
    const workspaces = [
      { id: 'workspace-a', name: 'A' },
      { id: 'workspace-b', name: 'B' },
    ];
    expect(
      uniqueWorkspaceForProject(
        'project-a',
        workspaces,
        new Map([
          ['workspace-a', [{ id: 'project-a' }]],
          ['workspace-b', [{ id: 'project-b' }]],
        ]),
      ),
    ).toBe('workspace-a');
    expect(
      uniqueWorkspaceForProject(
        'shared-project',
        workspaces,
        new Map([
          ['workspace-a', [{ id: 'shared-project' }]],
          ['workspace-b', [{ id: 'shared-project' }]],
        ]),
      ),
    ).toBeNull();
    expect(uniqueWorkspaceForProject('missing', workspaces, new Map())).toBeNull();
  });
});
