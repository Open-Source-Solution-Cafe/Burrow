import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { UploadPolicy } from '../../shared/uploadPolicy';
import { useAccount } from './queries';
import { projectApiPath } from './workspaceRoutes';

export const uploadPolicyKey = (accountId?: string, workspaceId?: string, projectId?: string) =>
  ['upload-policy', accountId, workspaceId, projectId] as const;

async function requestPolicy(
  workspaceId: string,
  projectId: string,
  init?: RequestInit,
): Promise<UploadPolicy> {
  const response = await fetch(projectApiPath(workspaceId, projectId, 'upload-policy'), init);
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message || 'Could not load upload settings');
  return result;
}

export function useUploadPolicy(workspaceId?: string, projectId?: string) {
  const { data: account } = useAccount();
  return useQuery({
    queryKey: uploadPolicyKey(account?.user.id, workspaceId, projectId),
    enabled: Boolean(account?.user.id && workspaceId && projectId),
    queryFn: ({ signal }) => requestPolicy(workspaceId!, projectId!, { signal }),
  });
}

export function useUpdateUploadPolicy(workspaceId: string, projectId: string) {
  const { data: account } = useAccount();
  const queryClient = useQueryClient();
  const queryKey = uploadPolicyKey(account?.user.id, workspaceId, projectId);
  return useMutation({
    mutationFn: (policy: UploadPolicy) =>
      requestPolicy(workspaceId, projectId, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      }),
    onSuccess: (policy) => {
      queryClient.setQueryData(queryKey, policy);
    },
    onError: (error: Error) => toast.error(error.message || 'Could not save upload settings'),
  });
}
