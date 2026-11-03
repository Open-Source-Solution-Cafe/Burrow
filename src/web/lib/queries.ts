import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Board, BoardWithDetails, CardWithDetails } from '../../core/infrastructure/types';
import type { CreatedCard } from '../../core/services/cards';
import { api } from './api';
import { projectApiPath } from './workspaceRoutes';

async function projectRequest<T>(
  workspaceId: string,
  projectId: string,
  resourcePath: string,
  init?: RequestInit,
): Promise<T> {
  const [resource, query] = resourcePath.split('?', 2);
  const path = projectApiPath(workspaceId, projectId, resource);
  const response = await fetch(`${path}${query ? `?${query}` : ''}`, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
      message?: string;
    };
    throw new Error(body.error?.message || body.message || `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function projectJson(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  };
}

const resourceAccountId = Symbol('resourceAccountId');
type AccountBoundInput<T> = T & { [resourceAccountId]: string | null };

function mutationAccountId(value: object): string | null {
  return (value as { [resourceAccountId]?: string | null })[resourceAccountId] ?? null;
}

function bindResourceAccount<TResult, TError, TVariables extends object, TContext>(
  mutation: UseMutationResult<TResult, TError, TVariables, TContext>,
  accountId: string | undefined,
) {
  return {
    ...mutation,
    mutate: (
      input: Omit<TVariables, typeof resourceAccountId>,
      options?: Parameters<typeof mutation.mutate>[1],
    ) =>
      mutation.mutate(
        { ...input, [resourceAccountId]: accountId ?? null } as TVariables,
        options,
      ),
    mutateAsync: (
      input: Omit<TVariables, typeof resourceAccountId>,
      options?: Parameters<typeof mutation.mutateAsync>[1],
    ) =>
      mutation.mutateAsync(
        { ...input, [resourceAccountId]: accountId ?? null } as TVariables,
        options,
      ),
  };
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const res = await api.api.health.$get();
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}
export function useSignOut() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/auth/sign-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error('Failed to sign out');
      }
      return res;
    },
    onSuccess: () => {
      queryClient.clear();
      try {
        localStorage.removeItem('burrow-last-project');
        for (const workspace of account?.workspaces ?? []) {
          localStorage.removeItem(`burrow-last-project:${workspace.id}`);
        }
      } catch {
        /* ignore */
      }
      window.location.href = '/login';
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to sign out');
    },
  });
}

export interface AccountWorkspace {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  createdAt: number;
}

export interface AccountProfile {
  user: { id: string; name: string; email: string; image: string | null };
  workspaces: AccountWorkspace[];
}

export function useAccount() {
  return useQuery({
    queryKey: ['account'],
    queryFn: async () => {
      const res = await fetch('/api/account');
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`Failed to load account: ${res.status}`);
      return (await res.json()) as AccountProfile;
    },
    staleTime: 10_000,
  });
}

export interface CreatedWorkspace {
  workspace: AccountWorkspace;
  project: { id: string; workspaceId: string; name: string };
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, requestId }: { name: string; requestId: string }) => {
      const res = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, requestId }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to create workspace');
      }
      return (await res.json()) as CreatedWorkspace;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account'] }),
    onError: (err: Error) => toast.error(err.message || 'Failed to create workspace'),
  });
}

export function useRenameWorkspace(workspaceId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name }: { name: string }) => {
      if (!workspaceId) throw new Error('Workspace is required');
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, requestId: crypto.randomUUID() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to rename workspace');
      }
      return (await res.json()) as { ok: true; workspaceId: string };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account'] }),
    onError: (err: Error) => toast.error(err.message || 'Failed to rename workspace'),
  });
}

export function useLeaveWorkspace(workspaceId?: string) {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  return useMutation({
    mutationFn: async () => {
      if (!workspaceId) throw new Error('Workspace is required');
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/leave`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to leave workspace');
      }
      return (await res.json()) as { ok: true; workspaceId: string };
    },
    onSuccess: () => {
      if (account?.user.id && workspaceId)
        queryClient.removeQueries({ queryKey: ['projects', account.user.id, workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['account'] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to leave workspace'),
  });
}

export function accountProjectsQueryOptions(accountId: string, workspaceId: string) {
  return {
    queryKey: ['projects', accountId, workspaceId] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const res = await api.api.workspaces[':wid'].projects.$get(
        { param: { wid: workspaceId } },
        { init: { signal } },
      );
      if (!res.ok) throw new Error(`Failed to load projects: ${res.status}`);
      return res.json();
    },
  };
}

export function useProjects(workspaceId?: string) {
  const { data: account, isError: accountError } = useAccount();
  const accountId = account?.user.id;
  const query = useQuery({
    queryKey: ['projects', accountId, workspaceId] as const,
    queryFn: async ({ signal }) => {
      if (!accountId || !workspaceId) return [];
      return accountProjectsQueryOptions(accountId, workspaceId).queryFn({ signal });
    },
    enabled: !!accountId && !!workspaceId && !accountError,
  });
  return { ...query, data: query.isError || accountError ? undefined : query.data };
}

type ProjectMutationScope = { accountId: string; workspaceId: string };
const projectMutationScope = Symbol('projectMutationScope');
type ScopedProjectInput<T> = T & { [projectMutationScope]: ProjectMutationScope | null };

function useProjectMutationScope(workspaceId?: string): ProjectMutationScope | null {
  const { data: account, isError } = useAccount();
  return !isError && account?.user.id && workspaceId
    ? { accountId: account.user.id, workspaceId }
    : null;
}

/** Capture the originating scope when a caller dispatches, not when the request finishes. */
function bindProjectScope<T extends object, TResult>(
  mutation: UseMutationResult<TResult, Error, ScopedProjectInput<T>>,
  scope: ProjectMutationScope | null,
) {
  return {
    ...mutation,
    mutate: (input: T, options?: Parameters<typeof mutation.mutate>[1]) =>
      mutation.mutate({ ...input, [projectMutationScope]: scope }, options),
    mutateAsync: (input: T, options?: Parameters<typeof mutation.mutateAsync>[1]) =>
      mutation.mutateAsync({ ...input, [projectMutationScope]: scope }, options),
  };
}

type CreateProjectInput = { name: string; icon?: string | null; color?: string | null };
type UpdateProjectInput = {
  id: string;
  name?: string;
  icon?: string | null;
  color?: string | null;
  archived?: boolean;
};

export function useCreateProject(workspaceId?: string) {
  const queryClient = useQueryClient();
  const scope = useProjectMutationScope(workspaceId);
  const mutation = useMutation({
    mutationFn: async ({
      [projectMutationScope]: origin,
      ...data
    }: ScopedProjectInput<CreateProjectInput>) => {
      if (!origin?.accountId || !origin.workspaceId) throw new Error('Workspace is required');
      const res = await api.api.workspaces[':wid'].projects.$post({
        param: { wid: origin.workspaceId },
        json: data,
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to create project');
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      const origin = variables[projectMutationScope];
      if (origin)
        queryClient.invalidateQueries({
          queryKey: ['projects', origin.accountId, origin.workspaceId],
        });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to create project');
    },
  });
  return bindProjectScope(mutation, scope);
}

export function useUpdateProject(workspaceId?: string) {
  const queryClient = useQueryClient();
  const scope = useProjectMutationScope(workspaceId);
  const mutation = useMutation({
    mutationFn: async ({
      id,
      [projectMutationScope]: origin,
      ...data
    }: ScopedProjectInput<UpdateProjectInput>) => {
      if (!origin?.accountId || !origin.workspaceId) throw new Error('Workspace is required');
      const res = await api.api.workspaces[':wid'].projects[':id'].$patch({
        param: { wid: origin.workspaceId, id },
        json: data,
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to update project');
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      const origin = variables[projectMutationScope];
      if (origin)
        queryClient.invalidateQueries({
          queryKey: ['projects', origin.accountId, origin.workspaceId],
        });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to update project');
    },
  });
  return bindProjectScope(mutation, scope);
}

export function useDeleteProject(workspaceId?: string) {
  const queryClient = useQueryClient();
  const { data: account, isError } = useAccount();
  const scope = !isError && account?.user.id && workspaceId
    ? { accountId: account.user.id, workspaceId }
    : null;
  return useMutation({
    mutationFn: async ({ id, confirmName }: { id: string; confirmName: string }) => {
      if (!scope) throw new Error('Workspace is required');
      const query = new URLSearchParams({ confirm: confirmName });
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(scope.workspaceId)}/projects/${encodeURIComponent(id)}?${query}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to delete project');
      }
      return (await res.json()) as { ok: true; deletedProjectId: string };
    },
    onSuccess: () => {
      if (scope)
        queryClient.invalidateQueries({
          queryKey: ['projects', scope.accountId, scope.workspaceId],
        });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to delete project');
    },
  });
}

export function useMembers(workspaceId?: string) {
  const { data: account } = useAccount();
  return useQuery({
    queryKey: ['members', account?.user.id, workspaceId],
    enabled: Boolean(account?.user.id && workspaceId),
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/members`);
      if (!res.ok) throw new Error(`Failed to load members: ${res.status}`);
      return ((await res.json()) as Array<{
        userId: string;
        name?: string | null;
        email?: string | null;
        image?: string | null;
        role: string;
        joinedAt: number;
      }>).map((member) => ({
        ...member,
        name: member.name || member.email || 'Unknown member',
        email: member.email ?? '',
      }));
    },
  });
}

export function useInvites(workspaceId?: string) {
  const { data: account } = useAccount();
  return useQuery({
    queryKey: ['invites', account?.user.id, workspaceId],
    enabled: Boolean(account?.user.id && workspaceId),
    queryFn: async () => {
      if (!workspaceId) return [];
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/invites`);
      if (!res.ok) throw new Error(`Failed to load invites: ${res.status}`);
      return res.json() as Promise<
        Array<{ id: string; email: string; role: string; expiresAt: number; createdAt: number }>
      >;
    },
  });
}

export function useCreateInvite(workspaceId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { email: string; role: 'editor' | 'viewer' }) => {
      if (!workspaceId) throw new Error('Workspace is required');
      const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to create invite');
      }
      return res.json() as Promise<{
        id: string;
        email: string;
        role: string;
        token: string;
        expiresAt: number;
        url: string;
      }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to create invite');
    },
  });
}

export function useRevokeInvite(workspaceId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!workspaceId) throw new Error('Workspace is required');
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(id)}`,
        {
        method: 'DELETE',
        },
      );
      if (!res.ok) {
        const err = (await res.json()) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to revoke invite');
      }
      return res.json() as Promise<{ ok: true; id: string }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to revoke invite');
    },
  });
}

export function useInviteInfo(token: string | undefined) {
  return useQuery({
    queryKey: ['invite-info', token],
    queryFn: async () => {
      if (!token) throw new Error('Invite token is required');
      const res = await fetch(`/api/invites/info/${encodeURIComponent(token)}`);
      const data = (await res.json().catch(() => ({}))) as {
        valid?: boolean;
        token?: string;
        email?: string;
        role?: 'editor' | 'viewer';
        workspaceName?: string;
        expiresAt?: number;
        userExists?: boolean;
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new Error(data.error?.message || 'Invalid or expired invite');
      }
      return data as {
        valid: boolean;
        token: string;
        email: string;
        role: 'editor' | 'viewer';
        workspaceName: string;
        expiresAt: number;
        userExists: boolean;
      };
    },
    enabled: !!token,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Boards, Columns, Cards
// ---------------------------------------------------------------------------

export function useBoards(workspaceId: string | undefined, projectId: string | undefined) {
  const { data: account } = useAccount();
  const accountId = account?.user.id;
  return useQuery({
    queryKey: ['boards', accountId, workspaceId, projectId],
    queryFn: async () => {
      if (!workspaceId || !projectId) return [];
      return projectRequest<Board[]>(workspaceId, projectId, 'boards');
    },
    enabled: Boolean(accountId && workspaceId && projectId),
  });
}

export function useBoard(workspaceId: string | undefined, projectId: string | undefined, boardId: string | undefined) {
  const { data: account } = useAccount();
  const accountId = account?.user.id;
  return useQuery({
    queryKey: ['board', accountId, workspaceId, projectId, boardId],
    queryFn: async () => {
      if (!workspaceId || !projectId || !boardId) return null;
      return projectRequest<BoardWithDetails>(workspaceId, projectId, `boards/${boardId}`);
    },
    enabled: Boolean(accountId && workspaceId && projectId && boardId),
  });
}

export function useCreateBoard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      [resourceAccountId]: _accountId,
      workspaceId,
      projectId,
      name,
      icon,
    }: AccountBoundInput<{
      workspaceId: string;
      projectId: string;
      name: string;
      icon?: string | null;
    }>) => {
      return projectRequest<{ id: string; position: string }>(
        workspaceId,
        projectId,
        'boards',
        projectJson('POST', { name, icon }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['boards', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to create board');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useUpdateBoard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      [resourceAccountId]: _accountId,
      workspaceId,
      projectId,
      boardId,
      name,
      icon,
    }: AccountBoundInput<{
      workspaceId: string;
      projectId: string;
      boardId: string;
      name?: string;
      icon?: string | null;
    }>) => {
      return projectRequest<{ ok: true; boardId: string }>(
        workspaceId,
        projectId,
        `boards/${boardId}`,
        projectJson('PATCH', { name, icon }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
      queryClient.invalidateQueries({ queryKey: ['boards', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to update board');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useDeleteBoard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({ [resourceAccountId]: _accountId, workspaceId, projectId, boardId }: AccountBoundInput<{ workspaceId: string; projectId: string; boardId: string }>) => {
      const res = await fetch(projectApiPath(workspaceId, projectId, `boards/${boardId}`), { method: 'DELETE' });
      // 404 means already deleted — treat as success
      if (res.status === 404) return { ok: true, deletedId: boardId };
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(err.error?.message || 'Failed to delete board');
      }
      return res.json();
    },
    retry: false,
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['boards', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
      queryClient.invalidateQueries({ queryKey: ['trash', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to delete board');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useCreateColumn() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      [resourceAccountId]: _accountId,
      workspaceId,
      projectId,
      boardId,
      name,
      color,
    }: AccountBoundInput<{
      workspaceId: string;
      projectId: string;
      boardId: string;
      name: string;
      color?: string | null;
    }>) => {
      return projectRequest<{ id: string; position: string }>(
        workspaceId,
        projectId,
        `boards/${boardId}/columns`,
        projectJson('POST', { name, color: color || null }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to create column');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useUpdateColumn() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      [resourceAccountId]: _accountId,
      workspaceId,
      projectId,
      boardId: _boardId,
      columnId,
      name,
      color,
      wipLimit,
    }: AccountBoundInput<{
      workspaceId: string;
      projectId: string;
      boardId: string;
      columnId: string;
      name?: string;
      color?: string | null;
      wipLimit?: number | null;
    }>) => {
      return projectRequest(
        workspaceId,
        projectId,
        `columns/${columnId}`,
        projectJson('PATCH', { name, color, wipLimit }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to update column');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useDeleteColumn() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      [resourceAccountId]: _accountId,
      workspaceId,
      projectId,
      boardId: _boardId,
      columnId,
      moveTo,
    }: AccountBoundInput<{
      workspaceId: string;
      projectId: string;
      boardId: string;
      columnId: string;
      moveTo?: string | null;
    }>) => {
      const query = moveTo ? `?moveTo=${encodeURIComponent(moveTo)}` : '';
      return projectRequest(
        workspaceId,
        projectId,
        `columns/${columnId}${query}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to delete column');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useMoveColumn() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      [resourceAccountId]: _accountId,
      workspaceId,
      projectId,
      boardId: _boardId,
      columnId,
      afterId,
    }: AccountBoundInput<{
      workspaceId: string;
      projectId: string;
      boardId: string;
      columnId: string;
      afterId?: string | null;
    }>) => {
      return projectRequest(
        workspaceId,
        projectId,
        `columns/${columnId}/move`,
        projectJson('POST', { afterId }),
      );
    },
    onMutate: async (vars) => {
      const accountId = mutationAccountId(vars);
      const { workspaceId, projectId, boardId, columnId, afterId } = vars;
      await queryClient.cancelQueries({ queryKey: ['board', accountId, workspaceId, projectId, boardId] });
      const prevBoard = queryClient.getQueryData<any>(['board', accountId, workspaceId, projectId, boardId]);
      if (prevBoard?.columns) {
        const nextColumns = [...prevBoard.columns];
        const fromIndex = nextColumns.findIndex((col: any) => col.id === columnId);
        if (fromIndex !== -1) {
          const [moved] = nextColumns.splice(fromIndex, 1);
          let insertAt: number;
          if (!afterId) {
            insertAt = 0;
          } else {
            const targetIndex = nextColumns.findIndex((col: any) => col.id === afterId);
            insertAt = targetIndex === -1 ? nextColumns.length : targetIndex + 1;
          }
          nextColumns.splice(insertAt, 0, moved);
          queryClient.setQueryData(['board', accountId, workspaceId, projectId, boardId], {
            ...prevBoard,
            columns: nextColumns,
          });
        }
      }
      return { prevBoard };
    },
    onError: (err: any, vars, context) => {
      toast.error(err?.message || 'Failed to move column');
      if (context?.prevBoard) {
        queryClient.setQueryData(['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId], context.prevBoard);
      }
    },
    onSettled: (_, __, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useCreateCard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      projectId,
      boardId: _boardId,
      columnId,
      title,
      priority,
      dueDate,
      assigneeIds,
      tagIds,
      notepad,
    }: {
      workspaceId: string;
      projectId: string;
      boardId: string;
      columnId: string;
      title: string;
      priority?: 'low' | 'medium' | 'high' | 'urgent' | null;
      dueDate?: number | null;
      assigneeIds?: string[];
      tagIds?: string[];
      notepad?: { mode: 'new' } | { mode: 'existing'; id: string };
    }) => {
      return projectRequest<CreatedCard>(
        workspaceId,
        projectId,
        `columns/${columnId}/cards`,
        projectJson('POST', {
          title,
          priority: priority ?? undefined,
          dueDate: dueDate ?? undefined,
          assigneeIds,
          tagIds,
          notepad,
        }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
      queryClient.invalidateQueries({ queryKey: ['my-tasks', mutationAccountId(vars), vars.workspaceId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to create card');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useCard(workspaceId: string | undefined, projectId: string | undefined, cardId: string | undefined) {
  const { data: account } = useAccount();
  const accountId = account?.user.id;
  return useQuery({
    queryKey: ['card', accountId, workspaceId, projectId, cardId],
    queryFn: async () => {
      if (!workspaceId || !projectId || !cardId) return null;
      return projectRequest<CardWithDetails>(workspaceId, projectId, `cards/${cardId}`);
    },
    enabled: Boolean(accountId && workspaceId && projectId && cardId),
  });
}

export function useUpdateCard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      projectId,
      cardId,
      boardId: _boardId,
      ...data
    }: {
      workspaceId: string;
      projectId: string;
      cardId: string;
      boardId: string;
      title?: string;
      priority?: 'low' | 'medium' | 'high' | 'urgent' | null;
      dueDate?: number | null;
      assigneeIds?: string[];
      tagIds?: string[];
    }) => {
      return projectRequest(workspaceId, projectId, `cards/${cardId}`, projectJson('PATCH', data));
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['card', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.cardId] });
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
      queryClient.invalidateQueries({ queryKey: ['my-tasks', mutationAccountId(vars), vars.workspaceId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to update card');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useMoveCard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      projectId,
      cardId,
      boardId: _boardId,
      columnId,
      afterId,
    }: {
      workspaceId: string;
      projectId: string;
      cardId: string;
      boardId: string;
      columnId: string;
      afterId?: string | null;
    }) => {
      return projectRequest(
        workspaceId,
        projectId,
        `cards/${cardId}/move`,
        projectJson('POST', { columnId, afterId }),
      );
    },
    onMutate: async (vars) => {
      const accountId = mutationAccountId(vars);
      const { workspaceId, projectId, cardId, boardId, columnId, afterId } = vars;
      await queryClient.cancelQueries({ queryKey: ['board', accountId, workspaceId, projectId, boardId] });
      const prevBoard = queryClient.getQueryData<any>(['board', accountId, workspaceId, projectId, boardId]);
      if (prevBoard && prevBoard.columns) {
        let movedCard: any = null;
        const nextColumns = prevBoard.columns.map((col: any) => {
          const card = col.cards?.find((c: any) => c.id === cardId);
          if (card) {
            movedCard = { ...card, columnId };
            return {
              ...col,
              cards: col.cards.filter((c: any) => c.id !== cardId),
            };
          }
          return col;
        });

        if (movedCard) {
          const finalColumns = nextColumns.map((col: any) => {
            if (col.id === columnId) {
              const cards = [...(col.cards || [])];
              if (!afterId) {
                cards.unshift(movedCard);
              } else {
                const idx = cards.findIndex((c: any) => c.id === afterId);
                if (idx === -1) {
                  cards.push(movedCard);
                } else {
                  cards.splice(idx + 1, 0, movedCard);
                }
              }
              return { ...col, cards };
            }
            return col;
          });

          queryClient.setQueryData(['board', accountId, workspaceId, projectId, boardId], {
            ...prevBoard,
            columns: finalColumns,
          });
        }
      }
      return { prevBoard };
    },
    onError: (err: any, vars, context) => {
      toast.error(err?.message || 'Failed to move card');
      if (context?.prevBoard) {
        queryClient.setQueryData(['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId], context.prevBoard);
      }
    },
    onSettled: (_, __, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
      queryClient.invalidateQueries({ queryKey: ['my-tasks', mutationAccountId(vars), vars.workspaceId] });
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useDeleteCard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({ workspaceId, projectId, cardId }: { workspaceId: string; projectId: string; cardId: string; boardId: string }) => {
      return projectRequest(workspaceId, projectId, `cards/${cardId}`, { method: 'DELETE' });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to delete card');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useRestoreCard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({ workspaceId, projectId, cardId }: { workspaceId: string; projectId: string; cardId: string }) => {
      return projectRequest(workspaceId, projectId, `cards/${cardId}/restore`, { method: 'POST' });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
      queryClient.invalidateQueries({ queryKey: ['my-tasks', mutationAccountId(vars), vars.workspaceId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to restore card');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

// ---------------------------------------------------------------------------
// My Tasks (cross-project assignee inbox)
// ---------------------------------------------------------------------------

export interface MyTaskItem {
  id: string;
  notepadId: string;
  boardId: string;
  columnId: string;
  projectId: string;
  title: string;
  dueDate: number | null;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
  isCompleted: boolean;
  createdAt: number;
  boardName: string;
  columnName: string;
  projectName: string;
  projectIcon: string | null;
  projectColor: string | null;
  tags: Array<{ id: string; name: string; color?: string | null }>;
}

export function useMyTasks(filters?: {
  status?: 'all' | 'open' | 'completed';
  projectId?: string;
}, workspaceId?: string) {
  const { data: account } = useAccount();
  const status = filters?.status ?? 'all';
  const projectId = filters?.projectId;
  return useQuery({
    queryKey: ['my-tasks', account?.user.id, workspaceId, status, projectId],
    enabled: Boolean(account?.user.id && workspaceId),
    queryFn: async () => {
      if (!workspaceId) return [];
      const query = new URLSearchParams({
        status,
        ...(projectId ? { projectId } : {}),
      });
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/my-tasks?${query}`,
      );
      if (!res.ok) throw new Error(`Failed to load tasks: ${res.status}`);
      return (await res.json()) as MyTaskItem[];
    },
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Subtasks (checklists)
// ---------------------------------------------------------------------------

export interface SubtaskItem {
  id: string;
  cardId: string;
  title: string;
  completed: boolean;
  position: string;
  createdAt: number;
}

export function useCreateSubtask() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      projectId,
      cardId,
      boardId: _boardId,
      title,
    }: {
      workspaceId: string;
      projectId: string;
      cardId: string;
      boardId: string;
      title: string;
    }) => {
      return projectRequest(
        workspaceId,
        projectId,
        `cards/${cardId}/subtasks`,
        projectJson('POST', { title }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['card', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.cardId] });
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to add subtask');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useUpdateSubtask() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      projectId,
      cardId,
      boardId: _boardId,
      subtaskId,
      title,
      completed,
      afterId,
    }: {
      workspaceId: string;
      projectId: string;
      cardId: string;
      boardId: string;
      subtaskId: string;
      title?: string;
      completed?: boolean;
      afterId?: string | null;
    }) => {
      return projectRequest(
        workspaceId,
        projectId,
        `cards/${cardId}/subtasks/${subtaskId}`,
        projectJson('PATCH', { title, completed, afterId }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['card', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.cardId] });
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
      queryClient.invalidateQueries({ queryKey: ['my-tasks', mutationAccountId(vars), vars.workspaceId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to update subtask');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useDeleteSubtask() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      projectId,
      cardId,
      boardId: _boardId,
      subtaskId,
    }: {
      workspaceId: string;
      projectId: string;
      cardId: string;
      boardId: string;
      subtaskId: string;
    }) => {
      return projectRequest(
        workspaceId,
        projectId,
        `cards/${cardId}/subtasks/${subtaskId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['card', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.cardId] });
      queryClient.invalidateQueries({ queryKey: ['board', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.boardId] });
      queryClient.invalidateQueries({ queryKey: ['my-tasks', mutationAccountId(vars), vars.workspaceId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to delete subtask');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

// ---------------------------------------------------------------------------
// Card comments (discussion thread)
// ---------------------------------------------------------------------------

export interface CommentItem {
  id: string;
  cardId: string;
  userId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  name: string;
  image: string | null;
}

export function useComments(workspaceId: string | undefined, projectId: string | undefined, cardId: string | undefined) {
  const { data: account } = useAccount();
  const accountId = account?.user.id;
  return useQuery({
    queryKey: ['comments', accountId, workspaceId, projectId, cardId],
    queryFn: async () => {
      if (!workspaceId || !projectId || !cardId) return [];
      return projectRequest<CommentItem[]>(workspaceId, projectId, `cards/${cardId}/comments`);
    },
    enabled: Boolean(accountId && workspaceId && projectId && cardId),
  });
}

export function useCreateComment() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({ workspaceId, projectId, cardId, content }: { workspaceId: string; projectId: string; cardId: string; content: string }) => {
      return projectRequest(
        workspaceId,
        projectId,
        `cards/${cardId}/comments`,
        projectJson('POST', { content }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['comments', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.cardId] });
      queryClient.invalidateQueries({ queryKey: ['notifications', mutationAccountId(vars), vars.workspaceId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to post comment');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useDeleteComment() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({ workspaceId, projectId, cardId, commentId }: { workspaceId: string; projectId: string; cardId: string; commentId: string }) => {
      return projectRequest(
        workspaceId,
        projectId,
        `cards/${cardId}/comments/${commentId}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['comments', mutationAccountId(vars), vars.workspaceId, vars.projectId, vars.cardId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to delete comment');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function useNotifications(workspaceId?: string, unreadOnly?: boolean) {
  const { data: account } = useAccount();
  return useQuery({
    queryKey: ['notifications', account?.user.id, workspaceId, unreadOnly],
    enabled: Boolean(account?.user.id && workspaceId),
    queryFn: async () => {
      if (!workspaceId) return [];
      const query = unreadOnly ? '?unread=1' : '';
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/notifications${query}`,
      );
      if (!res.ok) throw new Error(`Failed to load notifications: ${res.status}`);
      return (await res.json()) as Array<{
        id: string;
        type: 'mention' | 'assigned';
        actor: { id: string; name: string; image?: string | null };
        notepadId?: string | null;
        cardId?: string | null;
        boardId?: string | null;
        targetTitle?: string;
        readAt?: number | null;
        createdAt: number;
      }>;
    },
    refetchInterval: 60_000,
  });
}

export function useMarkNotificationsRead(workspaceId?: string) {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  return useMutation({
    mutationFn: async (ids?: string[]) => {
      if (!workspaceId) throw new Error('Workspace is required');
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/notifications/read`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        },
      );
      if (!res.ok) throw new Error('Failed to mark notifications read');
      return (await res.json()) as { ok: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['notifications', account?.user.id, workspaceId],
      });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to mark notifications read');
    },
  });
}

// ---------------------------------------------------------------------------
// Trash & Recent
// ---------------------------------------------------------------------------

export interface TrashedNotepad {
  id: string;
  kind: 'notepad' | 'card';
  title: string;
  icon?: string | null;
  deletedAt: number;
}

export interface TrashedBoard {
  id: string;
  name: string;
  icon?: string | null;
  deletedAt: number;
}

export function useTrash(workspaceId?: string, projectId?: string) {
  const { data: account } = useAccount();
  const accountId = account?.user.id;
  return useQuery({
    queryKey: ['trash', accountId, workspaceId, projectId],
    queryFn: async () => {
      if (!workspaceId || !projectId) return { notepads: [], boards: [] };
      return projectRequest<{ notepads: TrashedNotepad[]; boards: TrashedBoard[] }>(
        workspaceId,
        projectId,
        'trash',
      );
    },
    enabled: Boolean(accountId && workspaceId && projectId),
  });
}

export function useRestoreNotepad() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      notepadId,
      projectId,
    }: {
      workspaceId: string;
      notepadId: string;
      projectId: string;
    }) => {
      return projectRequest(workspaceId, projectId, `notepads/${notepadId}/restore`, { method: 'POST' });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['trash', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
      queryClient.invalidateQueries({ queryKey: ['notepads', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to restore notepad');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function usePermanentDeleteNotepad() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      notepadId,
      projectId,
    }: {
      workspaceId: string;
      notepadId: string;
      projectId: string;
    }) => {
      return projectRequest(workspaceId, projectId, `notepads/${notepadId}/permanent`, { method: 'DELETE' });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['trash', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to permanently delete notepad');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useRestoreBoard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      boardId,
      projectId,
    }: {
      workspaceId: string;
      boardId: string;
      projectId: string;
    }) => {
      return projectRequest(workspaceId, projectId, `boards/${boardId}/restore`, { method: 'POST' });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['trash', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
      queryClient.invalidateQueries({ queryKey: ['boards', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to restore board');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function usePermanentDeleteBoard() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      boardId,
      projectId,
    }: {
      workspaceId: string;
      boardId: string;
      projectId: string;
    }) => {
      return projectRequest(workspaceId, projectId, `boards/${boardId}/permanent`, { method: 'DELETE' });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['trash', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to permanently delete board');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useRecentNotepads(workspaceId?: string, projectId?: string) {
  const { data: account } = useAccount();
  const accountId = account?.user.id;
  return useQuery({
    queryKey: ['recent-notepads', accountId, workspaceId, projectId],
    queryFn: async () => {
      if (!workspaceId || !projectId) return [];
      return projectRequest<Array<{
        id: string;
        title: string;
        icon?: string | null;
        updatedAt: number;
      }>>(workspaceId, projectId, 'recent');
    },
    enabled: Boolean(accountId && workspaceId && projectId),
  });
}

// ---------------------------------------------------------------------------
// Notepad tree (drag-to-rearrange)
// ---------------------------------------------------------------------------

export interface NotepadNode {
  id: string;
  parentId: string | null;
  title: string;
  icon?: string | null;
  position: string;
  isFavorite: boolean;
}

export function useNotepads(workspaceId?: string, projectId?: string) {
  const { data: account } = useAccount();
  const accountId = account?.user.id;
  return useQuery<NotepadNode[]>({
    queryKey: ['notepads', accountId, workspaceId, projectId],
    queryFn: async () => {
      if (!workspaceId || !projectId) return [];
      return projectRequest<NotepadNode[]>(workspaceId, projectId, 'notepads');
    },
    enabled: Boolean(accountId && workspaceId && projectId),
  });
}

export function useMoveNotepad() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      projectId,
      notepadId,
      parentId,
      afterId,
    }: {
      workspaceId: string;
      projectId: string;
      notepadId: string;
      parentId: string | null;
      afterId: string | null;
    }) => {
      return projectRequest(
        workspaceId,
        projectId,
        `notepads/${notepadId}/move`,
        projectJson('POST', { parentId, afterId }),
      );
    },
    onMutate: async (vars) => {
      const accountId = mutationAccountId(vars);
      const { workspaceId, projectId, notepadId, parentId, afterId } = vars;
      await queryClient.cancelQueries({ queryKey: ['notepads', accountId, workspaceId, projectId] });
      const prev = queryClient.getQueryData<NotepadNode[]>(['notepads', accountId, workspaceId, projectId]);
      if (prev) {
        const moved = prev.find((n) => n.id === notepadId);
        if (moved) {
          // The flat list is position-ordered per sibling group; splicing the
          // moved entry next to its new siblings keeps every group's relative
          // order correct until the authoritative refetch lands.
          const rest = prev.filter((n) => n.id !== notepadId);
          const updated: NotepadNode = { ...moved, parentId };
          let insertAt: number;
          if (afterId) {
            const idx = rest.findIndex((n) => n.id === afterId);
            insertAt = idx === -1 ? rest.length : idx + 1;
          } else {
            const idx = rest.findIndex((n) =>
              parentId ? n.parentId === parentId : n.parentId === null,
            );
            insertAt = idx === -1 ? rest.length : idx;
          }
          rest.splice(insertAt, 0, updated);
          queryClient.setQueryData<NotepadNode[]>(['notepads', accountId, workspaceId, projectId], rest);
        }
      }
      return { prev };
    },
    onError: (err: any, vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['notepads', mutationAccountId(vars), vars.workspaceId, vars.projectId], context.prev);
      }
      toast.error(err?.message || 'Failed to move notepad');
    },
    onSettled: (_, __, vars) => {
      queryClient.invalidateQueries({ queryKey: ['notepads', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagItem {
  id: string;
  projectId: string;
  name: string;
  color?: string | null;
}

export function useProjectTags(workspaceId?: string, projectId?: string) {
  const { data: account } = useAccount();
  const accountId = account?.user.id;
  return useQuery({
    queryKey: ['tags', accountId, workspaceId, projectId],
    queryFn: async () => {
      if (!workspaceId || !projectId) return [];
      return projectRequest<TagItem[]>(workspaceId, projectId, 'tags');
    },
    enabled: Boolean(accountId && workspaceId && projectId),
  });
}

export function useCreateTag() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({
      workspaceId,
      projectId,
      name,
      color,
    }: {
      workspaceId: string;
      projectId: string;
      name: string;
      color?: string | null;
    }) => {
      return projectRequest<TagItem>(
        workspaceId,
        projectId,
        'tags',
        projectJson('POST', { name, color }),
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['tags', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to create tag');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

export function useDeleteTag() {
  const queryClient = useQueryClient();
  const { data: account } = useAccount();
  const mutation = useMutation({
    mutationFn: async ({ workspaceId, projectId, tagId }: { workspaceId: string; projectId: string; tagId: string }) => {
      return projectRequest(workspaceId, projectId, `tags/${tagId}`, { method: 'DELETE' });
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['tags', mutationAccountId(vars), vars.workspaceId, vars.projectId] });
    },
    onError: (err: any) => {
      toast.error(err?.message || 'Failed to delete tag');
    },
  });
  return bindResourceAccount(mutation, account?.user.id);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchItem {
  id: string;
  title: string;
  icon?: string | null;
  kind: 'notepad' | 'card';
  projectId: string;
  projectName: string;
  snippet: string;
}

export function workspaceSearchQueryOptions(
  accountId: string,
  workspaceId: string,
  query: string,
  projectId?: string,
  scope: 'project' | 'all' = 'project',
) {
  return {
    queryKey: ['search', accountId, workspaceId, query, projectId, scope] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const clean = query.trim();
      if (!clean) return [];
      const params = new URLSearchParams({
        q: clean,
        scope,
        ...(projectId ? { projectId } : {}),
      });
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/search?${params.toString()}`,
        { signal },
      );
      if (!res.ok) throw new Error('Failed to execute search');
      return (await res.json()) as SearchItem[];
    },
    enabled: Boolean(accountId && workspaceId && query.trim().length > 0),
  };
}

export function useSearch(
  query: string,
  workspaceId?: string,
  projectId?: string,
  scope: 'project' | 'all' = 'project',
) {
  const { data: account, isError: accountError } = useAccount();
  const accountId = account?.user.id ?? '';
  return useQuery({
    ...workspaceSearchQueryOptions(accountId, workspaceId ?? '', query, projectId, scope),
    enabled:
      !accountError &&
      Boolean(accountId && workspaceId && query.trim().length > 0) &&
      (scope === 'all' || Boolean(projectId)),
  });
}
