import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount } from './queries';
import { projectApiPath } from './workspaceRoutes';

export interface ProjectMediaItem {
  key: string;
  url: string;
  filename: string | null;
  byteSize: number | null;
  contentType: string;
  createdAt: number;
}

export function projectMediaKey(
  accountId: string | undefined,
  workspaceId: string,
  projectId: string,
) {
  return ['media', accountId, workspaceId, projectId] as const;
}

export function useProjectMedia(workspaceId: string, projectId: string) {
  const { data: account } = useAccount();
  return useQuery({
    queryKey: projectMediaKey(account?.user.id, workspaceId, projectId),
    enabled: Boolean(account?.user.id),
    staleTime: 0,
    queryFn: async ({ signal }): Promise<ProjectMediaItem[]> => {
      const response = await fetch(projectApiPath(workspaceId, projectId, 'media'), { signal });
      if (!response.ok) throw new Error('Could not load project media');
      return response.json();
    },
  });
}

export function useDeleteProjectMedia(workspaceId: string, projectId: string) {
  const { data: account } = useAccount();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (key: string) => {
      const response = await fetch(
        projectApiPath(workspaceId, projectId, `files/${encodeURIComponent(key)}`),
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string }; message?: string }
          | null;
        throw new Error(body?.error?.message || body?.message || 'Could not delete file');
      }
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: projectMediaKey(account?.user.id, workspaceId, projectId),
      });
    },
  });
}
