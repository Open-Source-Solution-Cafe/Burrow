import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Check, ChevronDown, Plus, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { useAccount, useCreateWorkspace } from '../../lib/queries';
import { workspaceSettingsTarget, workspaceTarget } from '../../lib/workspaceRoutes';
import { useTheme } from '../../lib/theme';
import { ModalShell } from '../ui/ModalShell';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';

export function WorkspaceSwitcher() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { isModern } = useTheme();
  const { data: account, isLoading, isError } = useAccount();
  const createWorkspace = useCreateWorkspace();
  const currentWorkspace = account?.workspaces.find((workspace) => workspace.id === workspaceId);
  const label = isLoading
    ? 'Loading workspace…'
    : isError || (workspaceId && !currentWorkspace)
      ? 'Workspace unavailable'
      : currentWorkspace?.name || 'Select workspace';
  const [isOpen, setIsOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [name, setName] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  useEffect(() => {
    setIsOpen(false);
    setShowCreateModal(false);
    setName('');
  }, [workspaceId, account?.user.id]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!account || !name.trim() || createWorkspace.isPending) return;
    try {
      const result = await createWorkspace.mutateAsync({
        name: name.trim(),
        requestId: crypto.randomUUID(),
      });
      setName('');
      setShowCreateModal(false);
      setIsOpen(false);
      navigate(workspaceTarget(result.workspace.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create workspace');
    }
  };

  return (
    <div className="relative min-w-0 flex-1" ref={dropdownRef}>
      <button
        type="button"
        aria-label={`Switch workspace: ${label}`}
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex w-full min-w-0 items-center gap-1.5 py-1 text-side-text hover:text-text transition cursor-pointer ${isModern ? 'text-[13px] font-semibold' : 'text-[14px] font-display'}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0" />
      </button>
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-64 max-w-[calc(100vw-6rem)] bg-surface border border-line py-1.5 z-50">
          <div className="px-3 py-1.5 text-xs font-semibold text-muted uppercase tracking-wider">
            Workspaces
          </div>
          <div className="max-h-60 overflow-y-auto">
            {(account?.workspaces ?? []).map((workspace) => (
              <Link
                key={workspace.id}
                {...workspaceTarget(workspace.id)}
                onClick={() => setIsOpen(false)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm text-text hover:bg-hi text-left transition min-h-[44px] md:min-h-0"
              >
                <span className="truncate">{workspace.name}</span>
                {workspace.id === workspaceId && <Check className="w-4 h-4 text-accent shrink-0" />}
              </Link>
            ))}
          </div>
          <div className="border-t border-hair mt-1 pt-1">
            {currentWorkspace && (
              <Link
                {...workspaceSettingsTarget(currentWorkspace.id)}
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-text hover:bg-hi transition min-h-[44px] md:min-h-0"
              >
                <Settings className="w-4 h-4" />
                <span>Workspace settings</span>
              </Link>
            )}
            <button
              type="button"
              disabled={!account || isLoading || isError}
              onClick={() => {
                setIsOpen(false);
                setShowCreateModal(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-text hover:bg-hi text-left transition min-h-[44px] md:min-h-0 disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              <span>Create workspace</span>
            </button>
          </div>
        </div>
      )}
      <ModalShell
        open={showCreateModal && !!account}
        onClose={() => setShowCreateModal(false)}
        title="Create Workspace"
        className="sm:max-w-sm"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1" htmlFor="workspace-name">
              Workspace Name
            </label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Workspace name"
              autoFocus
              maxLength={100}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setShowCreateModal(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!name.trim() || createWorkspace.isPending}
            >
              {createWorkspace.isPending ? 'Creating…' : 'Create Workspace'}
            </Button>
          </div>
        </form>
      </ModalShell>
    </div>
  );
}
