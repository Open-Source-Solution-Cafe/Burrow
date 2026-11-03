import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useAccount, useProjects, useCreateProject } from '../../lib/queries';
import { projectTarget } from '../../lib/workspaceRoutes';
import { useTheme } from '../../lib/theme';
import { ModalShell } from '../ui/ModalShell';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';

interface ProjectSwitcherProps {
  currentProjectId?: string;
}

export function ProjectSwitcher({ currentProjectId }: ProjectSwitcherProps) {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { isModern } = useTheme();
  const { data: account } = useAccount();
  const hasMembership = account?.workspaces.some((workspace) => workspace.id === workspaceId);
  const { data: projects = [], isLoading, isError } = useProjects(workspaceId);
  const createProject = useCreateProject(workspaceId);

  const [isOpen, setIsOpen] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectIcon, setNewProjectIcon] = useState('📁');
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentProject = projects.find((p) => p.id === currentProjectId);
  const unavailable = currentProjectId !== undefined && !currentProject;
  const label = isLoading
    ? 'Loading project…'
    : isError
      ? 'Projects unavailable'
      : unavailable
        ? 'Project unavailable'
        : currentProject?.name || 'Select project';

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsOpen(false);
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
    setNewProjectName('');
  }, [workspaceId, account?.user.id]);

  const handleSelect = (projectId: string) => {
    if (!workspaceId || !hasMembership) return;
    localStorage.setItem(`burrow-last-project:${workspaceId}`, projectId);
    setIsOpen(false);
    navigate(projectTarget(workspaceId, projectId));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !workspaceId ||
      !hasMembership ||
      createProject.isPending ||
      isLoading ||
      isError ||
      unavailable ||
      !newProjectName.trim()
    )
      return;
    try {
      const res = await createProject.mutateAsync({
        name: newProjectName.trim(),
        icon: newProjectIcon,
      });
      setNewProjectName('');
      setShowCreateModal(false);
      handleSelect(res.id);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create project');
    }
  };

  return (
    <div className="relative min-w-0" ref={dropdownRef}>
      {isModern ? (
        <button
          type="button"
          aria-label={`Switch project: ${label}`}
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
          className="flex w-full items-center gap-2 py-1 text-[13px] font-semibold text-side-text hover:text-text transition cursor-pointer min-w-0"
        >
          <span className="w-5 h-5 theme-radius-sm bg-accent text-accent-ink flex items-center justify-center text-[10px] font-bold shrink-0">
            {currentProject?.icon || '📁'}
          </span>
          <span className="truncate">{label}</span>
          <ChevronDown className="w-3.5 h-3.5 text-muted shrink-0 opacity-70" />
        </button>
      ) : (
        <button
          type="button"
          aria-label={`Switch project: ${label}`}
          aria-expanded={isOpen}
          onClick={() => setIsOpen(!isOpen)}
          className="flex w-full items-center gap-1.5 py-1 text-[14px] font-display text-side-text hover:text-text transition cursor-pointer min-w-0"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="w-3.5 h-3.5 text-ink-muted shrink-0" />
        </button>
      )}

      {isOpen && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-surface border border-line py-1.5 z-50">
          <div className="px-3 py-1.5 text-xs font-semibold text-muted uppercase tracking-wider">
            Projects
          </div>
          <div className="max-h-60 overflow-y-auto">
            {(hasMembership ? projects : []).map((p) => (
              <button
                key={p.id}
                onClick={() => handleSelect(p.id)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-hi text-left transition min-h-[44px] md:min-h-0"
              >
                <div className="flex items-center gap-2 truncate">
                  <span>{p.icon || '📁'}</span>
                  <span className="truncate text-text">{p.name}</span>
                </div>
                {p.id === currentProject?.id && <Check className="w-4 h-4 text-accent shrink-0" />}
              </button>
            ))}
          </div>

          <div className="border-t border-hair mt-1 pt-1">
            <button
              disabled={!hasMembership || isLoading || isError || unavailable}
              onClick={() => {
                setIsOpen(false);
                setShowCreateModal(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-text hover:bg-hi text-left transition min-h-[44px] md:min-h-0"
            >
              <Plus className="w-4 h-4" />
              <span>New project</span>
            </button>
          </div>
        </div>
      )}

      <ModalShell
        open={
          showCreateModal &&
          !!workspaceId &&
          !!hasMembership &&
          !isLoading &&
          !isError &&
          !unavailable
        }
        onClose={() => setShowCreateModal(false)}
        title="Create Project"
        className="sm:max-w-sm"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Icon & Name</label>
            <div className="flex gap-2">
              <Input
                value={newProjectIcon}
                onChange={(e) => setNewProjectIcon(e.target.value)}
                maxLength={2}
                aria-label="Project icon"
                className="w-12 shrink-0 text-center text-lg"
              />
              <Input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Project name"
                autoFocus
                aria-label="Project name"
                className="min-w-0 flex-1"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setShowCreateModal(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!newProjectName.trim() || createProject.isPending}
            >
              {createProject.isPending ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </form>
      </ModalShell>
    </div>
  );
}
