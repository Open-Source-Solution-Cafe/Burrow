import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  account: null as { user: { id: string }; workspaces: { id: string }[] } | null,
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  invalidate: vi.fn(),
  toastError: vi.fn(),
  queryOptions: null as any,
  queryClient: null as any,
}));

vi.mock('./api', () => ({
  api: {
    api: {
      workspaces: {
        ':wid': {
          projects: { $get: state.get, $post: state.post, ':id': { $patch: state.patch } },
        },
      },
    },
  },
}));

vi.mock('sonner', () => ({ toast: { error: state.toastError } }));

// Exercise the hooks' public mutation interface with TanStack's real observer,
// without mounting React or running browser/UI automation.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  const client = new actual.QueryClient();
  state.queryClient = client;
  client.invalidateQueries = state.invalidate;
  return {
    ...actual,
    useQuery: (options: unknown) => {
      state.queryOptions = options;
      return { data: state.account, isError: false };
    },
    useQueryClient: () => client,
    useMutation: (options: ConstructorParameters<typeof actual.MutationObserver>[1]) => {
      const observer = new actual.MutationObserver(client, options);
      observer.subscribe(() => {});
      return {
        ...observer.getCurrentResult(),
        mutate: (variables: unknown, callOptions?: unknown) =>
          void observer.mutate(variables, callOptions as never),
        mutateAsync: (variables: unknown, callOptions?: unknown) =>
          observer.mutate(variables, callOptions as never),
      };
    },
  };
});

import {
  accountProjectsQueryOptions,
  useCreateProject,
  useCreateBoard,
  useCreateWorkspace,
  useDeleteProject,
  useNotepads,
  useProjectTags,
  useMoveColumn,
  useRecentNotepads,
  useTrash,
  useRenameWorkspace,
  useUpdateProject,
  workspaceSearchQueryOptions,
} from './queries';

describe('project mutation scope capture', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    state.queryClient?.clear();
    state.account = {
      user: { id: 'account-a' },
      workspaces: [{ id: 'workspace-a' }, { id: 'workspace-b' }],
    };
  });

  it('keeps a create request and invalidation in its originating scope after a switch', async () => {
    let finish!: (value: { ok: boolean; json: () => Promise<{ id: string }> }) => void;
    state.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onSuccess = vi.fn();
    const first = useCreateProject('workspace-a');
    const pending = first.mutateAsync({ name: 'Created' }, { onSuccess });
    state.account = {
      user: { id: 'account-b' },
      workspaces: [{ id: 'workspace-b' }],
    };
    useCreateProject('workspace-b');
    await vi.waitFor(() => expect(state.post).toHaveBeenCalledTimes(1));
    finish({ ok: true, json: async () => ({ id: 'project-a' }) });
    await expect(pending).resolves.toEqual({ id: 'project-a' });
    expect(state.post).toHaveBeenCalledWith({
      param: { wid: 'workspace-a' },
      json: { name: 'Created' },
    });
    expect(state.invalidate).toHaveBeenCalledWith({
      queryKey: ['projects', 'account-a', 'workspace-a'],
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]?.[1]).toMatchObject({ name: 'Created' });
  });

  it('uses the captured workspace for updates and rejects a missing account without a write', async () => {
    state.patch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, projectId: 'project-a' }),
    });
    await useUpdateProject('workspace-a').mutateAsync({ id: 'project-a', name: 'Renamed' });
    expect(state.patch).toHaveBeenCalledWith({
      param: { wid: 'workspace-a', id: 'project-a' },
      json: { name: 'Renamed' },
    });
    expect(state.invalidate).toHaveBeenCalledWith({
      queryKey: ['projects', 'account-a', 'workspace-a'],
    });
    state.account = null;
    await expect(useCreateProject('workspace-a').mutateAsync({ name: 'No scope' })).rejects.toThrow(
      'Workspace is required',
    );
    expect(state.post).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalled();
  });

  it('preserves per-call error callbacks and does not invalidate on rejected writes', async () => {
    state.patch.mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Access revoked' } }),
    });
    const onError = vi.fn();
    await expect(
      useUpdateProject('workspace-a').mutateAsync({ id: 'project-a', name: 'Renamed' }, { onError }),
    ).rejects.toThrow('Access revoked');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ id: 'project-a', name: 'Renamed' });
    expect(state.invalidate).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalled();
  });

  it('lists projects only through the explicit workspace route and scopes its cache by account', async () => {
    state.get.mockResolvedValue({ ok: true, json: async () => [{ id: 'project-a' }] });
    const options = accountProjectsQueryOptions('account-a', 'workspace-a');
    await expect(options.queryFn({ signal: new AbortController().signal })).resolves.toEqual([
      { id: 'project-a' },
    ]);
    expect(options.queryKey).toEqual(['projects', 'account-a', 'workspace-a']);
    expect(state.get).toHaveBeenCalledWith(
      { param: { wid: 'workspace-a' } },
      expect.objectContaining({ init: expect.objectContaining({ signal: expect.any(AbortSignal) }) }),
    );
  });

  it('uses a stable caller request ID for workspace creation', async () => {
    const response = {
      ok: true,
      json: async () => ({ workspace: { id: 'workspace-c' }, project: { id: 'project-c' } }),
    } as Response;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const requestId = 'request-id-123456';
    await useCreateWorkspace().mutateAsync({ name: 'New space', requestId });
    expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New space', requestId }),
    });
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ['account'] });
    fetchMock.mockRestore();
  });

  it('renames a workspace through its explicit URL and invalidates account membership data', async () => {
    const response = {
      ok: true,
      json: async () => ({ ok: true, workspaceId: 'workspace-a' }),
    } as Response;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await useRenameWorkspace('workspace-a').mutateAsync({ name: 'Renamed' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace-a',
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringMatching(/"name":"Renamed"/),
      }),
    );
    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as {
      requestId?: string;
    };
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ['account'] });
    fetchMock.mockRestore();
  });

  it('deletes a project using the captured workspace and exact scoped cache key', async () => {
    const response = {
      ok: true,
      json: async () => ({ ok: true, deletedProjectId: 'project-a' }),
    } as Response;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const mutation = useDeleteProject('workspace-a');
    const pending = mutation.mutateAsync({ id: 'project-a', confirmName: 'Project A' });
    state.account = { user: { id: 'account-b' }, workspaces: [{ id: 'workspace-b' }] };
    useDeleteProject('workspace-b');
    await expect(pending).resolves.toMatchObject({ deletedProjectId: 'project-a' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace-a/projects/project-a?confirm=Project+A',
      { method: 'DELETE' },
    );
    expect(state.invalidate).toHaveBeenCalledWith({
      queryKey: ['projects', 'account-a', 'workspace-a'],
    });
    fetchMock.mockRestore();
  });

  it('searches through the explicit workspace endpoint with workspace-scoped cache identity', async () => {
    const response = {
      ok: true,
      json: async () => [{ id: 'result-a', projectId: 'project-a' }],
    } as Response;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const options = workspaceSearchQueryOptions(
      'account-a',
      'workspace/a',
      '  phrase here ',
      'project-a',
      'project',
    );
    await expect(options.queryFn({ signal: new AbortController().signal })).resolves.toEqual([
      { id: 'result-a', projectId: 'project-a' },
    ]);
    expect(options.queryKey).toEqual([
      'search',
      'account-a',
      'workspace/a',
      '  phrase here ',
      'project-a',
      'project',
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace%2Fa/search?q=phrase+here&scope=project&projectId=project-a',
      { signal: expect.any(AbortSignal) },
    );
    fetchMock.mockRestore();
  });

  it('separates resource caches by workspace and requests scoped project resource URLs', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'row-a' }],
    } as Response);

    useNotepads('workspace-a', 'project-a');
    const notepadsA = state.queryOptions as { queryKey: unknown[]; queryFn: () => Promise<unknown> };
    expect(notepadsA.queryKey).toEqual(['notepads', 'account-a', 'workspace-a', 'project-a']);
    await notepadsA.queryFn();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/workspaces/workspace-a/projects/project-a/notepads',
      undefined,
    );

    useNotepads('workspace-b', 'project-a');
    const notepadsB = state.queryOptions as { queryKey: unknown[]; queryFn: () => Promise<unknown> };
    expect(notepadsB.queryKey).toEqual(['notepads', 'account-a', 'workspace-b', 'project-a']);
    expect(notepadsB.queryKey).not.toEqual(notepadsA.queryKey);

    useTrash('workspace-b', 'project-a');
    const trash = state.queryOptions as { queryFn: () => Promise<unknown> };
    await trash.queryFn();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/workspaces/workspace-b/projects/project-a/trash',
      undefined,
    );

    useRecentNotepads('workspace-b', 'project-a');
    const recent = state.queryOptions as { queryFn: () => Promise<unknown> };
    await recent.queryFn();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/workspaces/workspace-b/projects/project-a/recent',
      undefined,
    );

    useProjectTags('workspace-b', 'project-a');
    const tags = state.queryOptions as { queryFn: () => Promise<unknown> };
    await tags.queryFn();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/workspaces/workspace-b/projects/project-a/tags',
      undefined,
    );
    fetchMock.mockRestore();
  });

  it('separates identical workspace/project resource identities across accounts', () => {
    useNotepads('workspace-a', 'project-a');
    const accountA = state.queryOptions as { queryKey: unknown[] };
    state.account = {
      user: { id: 'account-b' },
      workspaces: [{ id: 'workspace-a' }],
    };
    useNotepads('workspace-a', 'project-a');
    const accountB = state.queryOptions as { queryKey: unknown[] };
    expect(accountA.queryKey).toEqual(['notepads', 'account-a', 'workspace-a', 'project-a']);
    expect(accountB.queryKey).toEqual(['notepads', 'account-b', 'workspace-a', 'project-a']);
    expect(accountA.queryKey).not.toEqual(accountB.queryKey);
  });

  it('invalidates the account cache captured when a resource mutation starts', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    const pending = useCreateBoard().mutateAsync({
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      name: 'Board',
    });
    state.account = {
      user: { id: 'account-b' },
      workspaces: [{ id: 'workspace-a' }],
    };
    useCreateBoard();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    finish(new Response(JSON.stringify({ id: 'board-a' }), { status: 200 }));
    await expect(pending).resolves.toEqual({ id: 'board-a' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspaces/workspace-a/projects/project-a/boards',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(state.invalidate).toHaveBeenCalledWith({
      queryKey: ['boards', 'account-a', 'workspace-a', 'project-a'],
    });
    fetchMock.mockRestore();
  });

  it('rolls back a failed optimistic mutation only in its originating account and workspace cache', async () => {
    const accountAKey = ['board', 'account-a', 'workspace-a', 'project-a', 'board-a'];
    const accountBKey = ['board', 'account-b', 'workspace-a', 'project-a', 'board-a'];
    const originalA = {
      columns: [{ id: 'column-a' }, { id: 'column-b' }],
    };
    const originalB = {
      columns: [{ id: 'column-b-only' }, { id: 'column-a-only' }],
    };
    state.queryClient.setQueryData(accountAKey, originalA);
    state.queryClient.setQueryData(accountBKey, originalB);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Access revoked' } }), { status: 403 }),
    );

    await expect(
      useMoveColumn().mutateAsync({
        workspaceId: 'workspace-a',
        projectId: 'project-a',
        boardId: 'board-a',
        columnId: 'column-a',
        afterId: 'column-b',
      }),
    ).rejects.toThrow('Access revoked');

    expect(state.queryClient.getQueryData(accountAKey)).toEqual(originalA);
    expect(state.queryClient.getQueryData(accountBKey)).toEqual(originalB);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: accountAKey });
    expect(state.invalidate).not.toHaveBeenCalledWith({ queryKey: accountBKey });
    expect(state.toastError).toHaveBeenCalledWith('Access revoked');
    fetchMock.mockRestore();
  });
});
