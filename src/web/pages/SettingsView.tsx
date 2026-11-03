import { useState, useEffect } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Archive, LogOut, Plus, Settings, Tag, Trash2, User, Users, Check } from 'lucide-react';
import { toast } from 'sonner';
import {
  useCreateTag,
  useDeleteProject,
  useDeleteTag,
  useAccount,
  useLeaveWorkspace,
  useRenameWorkspace,
  useProjects,
  useProjectTags,
  useSignOut,
  useUpdateProject,
} from '../lib/queries';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { StatusDiamond } from '../components/ui/StatusDiamond';
import { workspaceTarget } from '../lib/workspaceRoutes';
import { useUploadPolicy, useUpdateUploadPolicy } from '../lib/uploadPolicy';
import { MAX_UPLOAD_BYTES, UPLOAD_FILE_TYPES } from '../../shared/uploadPolicy';

const ICON_PRESETS = ['📁', '🚀', '⚡', '🎯', '🛠️', '💡', '📊', '📝', '📦', '✨'];
const COLOR_PRESETS = ['#6366f1', '#059669', '#d97706', '#dc2626', '#9333ea', '#0284c7', '#64748b'];

function UploadSettings({
  workspaceId,
  projectId,
  canEdit,
}: {
  workspaceId: string;
  projectId: string;
  canEdit: boolean;
}) {
  const policy = useUploadPolicy(workspaceId, projectId);
  const update = useUpdateUploadPolicy(workspaceId, projectId);
  const [sizeMb, setSizeMb] = useState('');
  const [allowedTypes, setAllowedTypes] = useState<string[]>([]);
  useEffect(() => {
    if (!policy.data) return;
    setSizeMb(String(policy.data.maxFileSizeBytes / (1024 * 1024)));
    setAllowedTypes(policy.data.allowedMimeTypes);
  }, [policy.data]);

  return (
    <section className="pt-5 border-t border-[var(--hair)] space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text)]">File uploads</h3>
      <p className="text-xs text-[var(--muted)]">
        Choose the file types and maximum size allowed in this project. Existing files remain
        available.
      </p>
      {policy.isPending ? (
        <p className="text-xs text-[var(--muted)]">Loading upload settings…</p>
      ) : policy.isError ? (
        <div className="text-xs text-[var(--danger)]">
          <p>Could not load upload settings.</p>
          <Button type="button" variant="ghost" onClick={() => void policy.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <label className="block space-y-1.5 text-xs font-medium text-[var(--text)]">
            <span>Maximum file size (MB)</span>
            <Input
              type="number"
              min="0.01"
              max={MAX_UPLOAD_BYTES / (1024 * 1024)}
              step="any"
              value={sizeMb}
              onChange={(event) => setSizeMb(event.target.value)}
              disabled={!canEdit || update.isPending}
              className="w-32"
            />
          </label>
          <fieldset disabled={!canEdit || update.isPending} className="space-y-2">
            <legend className="mb-2 text-xs font-medium text-[var(--text)]">
              Allowed file types
            </legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {UPLOAD_FILE_TYPES.map((type) => (
                <label
                  key={type.mimeType}
                  className="flex items-center gap-2 text-xs text-[var(--text)]"
                >
                  <input
                    type="checkbox"
                    checked={allowedTypes.includes(type.mimeType)}
                    onChange={(event) =>
                      setAllowedTypes((types) =>
                        event.target.checked
                          ? [...types, type.mimeType]
                          : types.filter((mime) => mime !== type.mimeType),
                      )
                    }
                  />
                  {type.label}
                </label>
              ))}
            </div>
          </fieldset>
          {canEdit ? (
            <Button
              type="button"
              variant="primary"
              disabled={update.isPending}
              onClick={async () => {
                const maxFileSizeBytes = Math.round(Number(sizeMb) * 1024 * 1024);
                if (
                  !Number.isFinite(maxFileSizeBytes) ||
                  maxFileSizeBytes < 1 ||
                  maxFileSizeBytes > MAX_UPLOAD_BYTES
                ) {
                  toast.error(
                    `Enter a file size between 0.01 and ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
                  );
                  return;
                }
                if (!allowedTypes.length) {
                  toast.error('Choose at least one allowed file type');
                  return;
                }
                try {
                  await update.mutateAsync({ maxFileSizeBytes, allowedMimeTypes: allowedTypes });
                  toast.success('Upload settings saved');
                } catch {
                  /* The mutation displays the server error. */
                }
              }}
            >
              {update.isPending ? 'Saving…' : 'Save upload settings'}
            </Button>
          ) : (
            <p className="text-xs text-[var(--muted)]">
              Only workspace owners can change upload settings.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function SettingsView() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { data: account, isError: accountError } = useAccount();
  const signOut = useSignOut();
  const {
    data: projects = [],
    isLoading: projectsLoading,
    isError: projectsError,
  } = useProjects(workspaceId);
  const updateProjectMutation = useUpdateProject(workspaceId);
  const renameWorkspace = useRenameWorkspace(workspaceId);
  const leaveWorkspace = useLeaveWorkspace(workspaceId);
  const deleteProjectMutation = useDeleteProject(workspaceId);
  const createTagMutation = useCreateTag();
  const deleteTagMutation = useDeleteTag();

  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmLeaveWorkspace, setConfirmLeaveWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');

  // Selected project state
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');

  useEffect(() => {
    if (!selectedProjectId && projects.length > 0) {
      const savedProjectId = localStorage.getItem(`burrow-last-project:${workspaceId}`);
      const found = projects.find((p) => p.id === savedProjectId) || projects[0];
      if (found) {
        setSelectedProjectId(found.id);
      }
    }
  }, [projects, selectedProjectId, workspaceId]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId);
  const scopeKey =
    !accountError && !projectsError && account && workspaceId && selectedProject
      ? JSON.stringify([account.user.id, workspaceId, selectedProject.id])
      : null;

  // Project details form
  const [projectName, setProjectName] = useState('');
  const [projectIcon, setProjectIcon] = useState('📁');
  const [projectColor, setProjectColor] = useState<string | null>(null);
  const [draftScope, setDraftScope] = useState<string | null>(null);

  useEffect(() => {
    if (scopeKey && selectedProject) {
      setProjectName(selectedProject.name);
      setProjectIcon(selectedProject.icon || '📁');
      setProjectColor(selectedProject.color || null);
      setDraftScope(scopeKey);
    } else {
      setProjectName('');
      setProjectIcon('📁');
      setProjectColor(null);
      setDraftScope(null);
    }
  }, [scopeKey]);

  // Project archive / delete confirm dialogs
  const [archiveTarget, setArchiveTarget] = useState<{
    scope: string;
    id: string;
    name: string;
    archived: boolean;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    scope: string;
    id: string;
    name: string;
  } | null>(null);

  // Tag management
  const { data: projectTags = [] } = useProjectTags(workspaceId, selectedProject?.id);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState<string>('#6366f1');
  const [tagToDelete, setTagToDelete] = useState<{
    id: string;
    name: string;
    workspaceId: string;
    projectId: string;
    scope: string;
  } | null>(null);

  useEffect(() => {
    setArchiveTarget(null);
    setDeleteTarget(null);
    setTagToDelete(null);
    setNewTagName('');
    setNewTagColor('#6366f1');
  }, [scopeKey]);

  const role = account?.workspaces.find((workspace) => workspace.id === workspaceId)?.role;
  const currentWorkspace = account?.workspaces.find((workspace) => workspace.id === workspaceId);
  const isViewer = !account || accountError || projectsError || role === 'viewer' || !workspaceId;
  const isArchived = Boolean(selectedProject?.archivedAt);

  useEffect(() => {
    setWorkspaceName(currentWorkspace?.name ?? '');
  }, [workspaceId, currentWorkspace?.name]);

  const handleRenameWorkspace = async (event: React.FormEvent) => {
    event.preventDefault();
    if (
      !workspaceId ||
      role !== 'owner' ||
      !workspaceName.trim() ||
      workspaceName.trim() === currentWorkspace?.name
    )
      return;
    try {
      await renameWorkspace.mutateAsync({ name: workspaceName.trim() });
      toast.success('Workspace renamed');
    } catch {
      setWorkspaceName(currentWorkspace?.name ?? '');
    }
  };

  const handleLeaveWorkspace = async () => {
    if (!workspaceId) return;
    try {
      await leaveWorkspace.mutateAsync();
      setConfirmLeaveWorkspace(false);
      navigate({ to: '/' });
    } catch {
      setConfirmLeaveWorkspace(false);
    }
  };

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProject || !scopeKey || draftScope !== scopeKey || isViewer || !projectName.trim())
      return;

    try {
      await updateProjectMutation.mutateAsync({
        id: selectedProject.id,
        name: projectName.trim(),
        icon: projectIcon,
        color: projectColor,
      });
      toast.success('Project settings saved');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update project');
    }
  };

  const handleToggleArchive = async () => {
    if (
      !archiveTarget ||
      archiveTarget.scope !== scopeKey ||
      archiveTarget.id !== selectedProject?.id ||
      isViewer
    )
      return;
    const nextArchived = !archiveTarget.archived;
    try {
      await updateProjectMutation.mutateAsync({
        id: archiveTarget.id,
        archived: nextArchived,
      });
      toast.success(nextArchived ? 'Project archived' : 'Project unarchived');
      setArchiveTarget(null);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update archive status');
    }
  };

  const handleDeleteProject = async () => {
    if (
      !deleteTarget ||
      deleteTarget.scope !== scopeKey ||
      deleteTarget.id !== selectedProject?.id ||
      isViewer
    )
      return;
    try {
      await deleteProjectMutation.mutateAsync({
        id: deleteTarget.id,
        confirmName: deleteTarget.name,
      });
      toast.success('Project deleted');
      setDeleteTarget(null);
      if (workspaceId) localStorage.removeItem(`burrow-last-project:${workspaceId}`);
      navigate(workspaceId ? workspaceTarget(workspaceId) : { to: '/' });
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete project');
    }
  };

  const handleCreateTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProject || !scopeKey || isViewer || !newTagName.trim()) return;

    try {
      await createTagMutation.mutateAsync({
        workspaceId: workspaceId!,
        projectId: selectedProject.id,
        name: newTagName.trim(),
        color: newTagColor,
      });
      setNewTagName('');
      toast.success('Tag created');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create tag');
    }
  };

  const handleDeleteTag = async () => {
    if (
      !tagToDelete ||
      tagToDelete.scope !== scopeKey ||
      tagToDelete.projectId !== selectedProject?.id ||
      isViewer
    )
      return;
    try {
      await deleteTagMutation.mutateAsync({
        workspaceId: tagToDelete.workspaceId,
        tagId: tagToDelete.id,
        projectId: tagToDelete.projectId,
      });
      toast.success('Tag deleted');
      setTagToDelete(null);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete tag');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto py-8 px-6 space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">Settings</h1>
          <p className="text-sm text-[var(--muted)]">
            Manage your profile, project preferences, and workflow tags.
          </p>
        </div>

        {/* Section 1: Profile Details */}
        <div className="border border-[var(--line)] bg-[var(--surface)] p-6 space-y-5">
          <div className="flex items-center gap-2 border-b border-[var(--hair)] pb-3">
            <User className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
              Profile & Account
            </h2>
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Avatar name={account?.user?.name || 'User'} size="lg" />
              <div>
                <div className="text-base font-semibold text-[var(--text)]">
                  {account?.user?.name || 'User'}
                </div>
                <div className="text-xs text-[var(--muted)]">{account?.user?.email}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="text-[11px] text-[var(--muted)]">Workspace Role:</span>
                  <Badge className="uppercase text-[10px] tracking-wider font-mono">
                    {role || 'member'}
                  </Badge>
                </div>
              </div>
            </div>

            <Button
              variant="danger"
              onClick={() => setConfirmSignOut(true)}
              className="flex items-center gap-2 min-h-[44px] sm:min-h-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Log out</span>
            </Button>
          </div>
        </div>

        {workspaceId && currentWorkspace && (
          <div className="border border-[var(--line)] bg-[var(--surface)] p-6 space-y-5">
            <div className="flex items-center gap-2 border-b border-[var(--hair)] pb-3">
              <Users className="w-4 h-4 text-[var(--accent)]" />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
                Workspace
              </h2>
            </div>
            <form onSubmit={handleRenameWorkspace} className="flex flex-wrap items-end gap-3">
              <label className="min-w-56 flex-1 space-y-1 text-xs font-medium text-[var(--text)]">
                Workspace name
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  maxLength={100}
                  disabled={role !== 'owner'}
                />
              </label>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  role !== 'owner' ||
                  !workspaceName.trim() ||
                  workspaceName.trim() === currentWorkspace.name ||
                  renameWorkspace.isPending
                }
              >
                {renameWorkspace.isPending ? 'Saving…' : 'Save workspace name'}
              </Button>
              <Badge className="uppercase text-[10px] tracking-wider font-mono">
                {role || 'member'}
              </Badge>
            </form>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hair)] pt-4">
              <p className="max-w-xl text-xs text-[var(--muted)]">
                A workspace owner must promote another owner before leaving if they are the last
                owner.
              </p>
              <Button type="button" variant="danger" onClick={() => setConfirmLeaveWorkspace(true)}>
                Leave workspace
              </Button>
            </div>
          </div>
        )}

        {/* Section 2: Project Settings */}
        <div className="border border-[var(--line)] bg-[var(--surface)] p-6 space-y-5">
          <div className="flex items-center justify-between gap-4 border-b border-[var(--hair)] pb-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-[var(--accent)]" />
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
                Project Settings
              </h2>
            </div>

            {projects.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--muted)]">Configuring:</span>
                <Select
                  value={selectedProject?.id || ''}
                  onChange={(e) => {
                    setSelectedProjectId(e.target.value);
                    setArchiveTarget(null);
                    setDeleteTarget(null);
                    setTagToDelete(null);
                    setDraftScope(null);
                  }}
                  className="px-2.5 py-1 text-xs font-medium min-h-[44px] sm:min-h-0"
                >
                  {!selectedProject && <option value="">Select a project</option>}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.icon || '📁'} {p.name} {p.archivedAt ? '(Archived)' : ''}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {projectsLoading ? (
            <div className="text-xs text-[var(--muted)] py-4">Loading project settings…</div>
          ) : projectsError || accountError ? (
            <div className="text-xs text-[var(--muted)] py-4">Unable to load project settings.</div>
          ) : !selectedProject ? (
            <div className="text-xs text-[var(--muted)] italic py-4">
              {projects.length ? 'Select an available project.' : 'No projects available.'}
            </div>
          ) : (
            <form onSubmit={handleSaveProject} className="space-y-4">
              {/* Project Name */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text)]">Project Name</label>
                <Input
                  type="text"
                  required
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  disabled={isViewer}
                  className="w-full text-sm"
                  placeholder="e.g. Core App"
                />
              </div>

              {/* Icon Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text)]">Project Icon</label>
                <div className="flex items-center gap-2 flex-wrap">
                  <Input
                    type="text"
                    value={projectIcon}
                    onChange={(e) => setProjectIcon(e.target.value)}
                    disabled={isViewer}
                    className="w-20 text-center text-lg"
                    maxLength={4}
                  />
                  <div className="flex items-center gap-1 flex-wrap">
                    {ICON_PRESETS.map((icon) => (
                      <button
                        key={icon}
                        type="button"
                        onClick={() => setProjectIcon(icon)}
                        disabled={isViewer}
                        className={`w-8 h-8 flex items-center justify-center text-base border transition ${
                          projectIcon === icon
                            ? 'border-[var(--accent)] bg-[var(--hi)]'
                            : 'border-[var(--line)] bg-[var(--surface2)] hover:border-[var(--muted)]'
                        }`}
                      >
                        {icon}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Color Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text)]">Accent Color</label>
                <div className="flex items-center gap-2 flex-wrap">
                  {COLOR_PRESETS.map((color) => {
                    const isSelected = projectColor === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setProjectColor(isSelected ? null : color)}
                        disabled={isViewer}
                        className={`w-7 h-7 flex items-center justify-center border transition ${
                          isSelected ? 'border-[var(--text)] scale-110' : 'border-transparent'
                        }`}
                        style={{ backgroundColor: color }}
                        title={color}
                      >
                        {isSelected && <Check className="w-3.5 h-3.5 text-white stroke-[3]" />}
                      </button>
                    );
                  })}
                  {projectColor && (
                    <button
                      type="button"
                      onClick={() => setProjectColor(null)}
                      disabled={isViewer}
                      className="text-xs text-[var(--muted)] hover:text-[var(--text)] underline ml-2"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {scopeKey && workspaceId && (
                <UploadSettings
                  key={scopeKey}
                  workspaceId={workspaceId}
                  projectId={selectedProject.id}
                  canEdit={role === 'owner'}
                />
              )}

              {/* Save Button */}
              {!isViewer && (
                <div className="pt-2 flex items-center gap-3">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      updateProjectMutation.isPending ||
                      draftScope !== scopeKey ||
                      !projectName.trim()
                    }
                    className="min-h-[44px] sm:min-h-0"
                  >
                    {updateProjectMutation.isPending ? 'Saving…' : 'Save Changes'}
                  </Button>
                </div>
              )}

              {/* Danger Zone: Archive / Delete */}
              {!isViewer && (
                <div className="pt-6 border-t border-[var(--hair)] space-y-3">
                  <h3 className="text-xs font-semibold text-[var(--danger)] uppercase tracking-wider">
                    Danger Zone
                  </h3>
                  <div className="flex items-center gap-3 flex-wrap">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        scopeKey &&
                        setArchiveTarget({
                          scope: scopeKey,
                          id: selectedProject.id,
                          name: selectedProject.name,
                          archived: isArchived,
                        })
                      }
                      className="flex items-center gap-2 border border-[var(--line)] min-h-[44px] sm:min-h-0 text-xs"
                    >
                      <Archive className="w-3.5 h-3.5" />
                      <span>{isArchived ? 'Unarchive Project' : 'Archive Project'}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() =>
                        scopeKey &&
                        setDeleteTarget({
                          scope: scopeKey,
                          id: selectedProject.id,
                          name: selectedProject.name,
                        })
                      }
                      className="flex items-center gap-2 min-h-[44px] sm:min-h-0 text-xs"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete Project…</span>
                    </Button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>

        {/* Section 3: Tag Management */}
        <div className="border border-[var(--line)] bg-[var(--surface)] p-6 space-y-5">
          <div className="flex items-center gap-2 border-b border-[var(--hair)] pb-3">
            <Tag className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--text)]">
              Tag Management
            </h2>
          </div>

          <p className="text-xs text-[var(--muted)]">
            Tags scoped to <strong>{selectedProject?.name || 'current project'}</strong>. Use tags
            on kanban cards to group tasks and filter work.
          </p>

          {/* New Tag Form */}
          {!isViewer && selectedProject && (
            <form onSubmit={handleCreateTag} className="flex items-center gap-2 flex-wrap">
              <Input
                type="text"
                required
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="New tag name (e.g. bug, urgent)"
                className="flex-1 min-w-[200px] text-xs px-3 py-1.5 min-h-[44px] sm:min-h-0"
              />
              <div className="flex items-center gap-1">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewTagColor(c)}
                    className={`w-6 h-6 flex items-center justify-center border transition ${
                      newTagColor === c ? 'border-[var(--text)] scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: c }}
                    title={c}
                  >
                    {newTagColor === c && <Check className="w-3 h-3 text-white stroke-[3]" />}
                  </button>
                ))}
              </div>
              <Button
                type="submit"
                variant="primary"
                disabled={createTagMutation.isPending || !newTagName.trim()}
                className="flex items-center gap-1.5 min-h-[44px] sm:min-h-0 text-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{createTagMutation.isPending ? 'Adding…' : 'Add Tag'}</span>
              </Button>
            </form>
          )}

          {/* Existing Tags List */}
          <div className="space-y-2 pt-2">
            {projectTags.length === 0 ? (
              <div className="text-xs text-[var(--muted)] italic py-2">
                No tags created for this project yet.
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {projectTags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex items-center gap-2 px-2.5 py-1.5 border border-[var(--line)] bg-[var(--surface2)] text-xs font-medium text-[var(--text)] select-none"
                  >
                    <StatusDiamond color={tag.color || '#6366f1'} size={8} />
                    <span>#{tag.name}</span>
                    {!isViewer && (
                      <button
                        type="button"
                        onClick={() =>
                          selectedProject &&
                          scopeKey &&
                          setTagToDelete({
                            id: tag.id,
                            name: tag.name,
                            workspaceId: workspaceId!,
                            projectId: selectedProject.id,
                            scope: scopeKey,
                          })
                        }
                        className="text-[var(--muted)] hover:text-[var(--danger)] transition ml-1"
                        title={`Delete tag #${tag.name}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirm Sign Out */}
      <ConfirmDialog
        open={confirmSignOut}
        title="Log out"
        message="Are you sure you want to log out of your account?"
        confirmLabel="Log out"
        danger={false}
        busy={signOut.isPending}
        onConfirm={async () => {
          try {
            await signOut.mutateAsync();
          } catch (err: any) {
            toast.error(err?.message || 'Failed to sign out');
            setConfirmSignOut(false);
          }
        }}
        onCancel={() => setConfirmSignOut(false)}
      />

      {confirmLeaveWorkspace && currentWorkspace && (
        <ConfirmDialog
          open
          title="Leave workspace"
          message={`Leave "${currentWorkspace.name}"? You will lose access to its projects and content.`}
          confirmLabel="Leave workspace"
          danger
          busy={leaveWorkspace.isPending}
          onConfirm={handleLeaveWorkspace}
          onCancel={() => setConfirmLeaveWorkspace(false)}
        />
      )}

      {/* Confirm Archive Project */}
      {archiveTarget &&
        archiveTarget.scope === scopeKey &&
        archiveTarget.id === selectedProject?.id && (
          <ConfirmDialog
            open
            title={archiveTarget.archived ? 'Unarchive Project' : 'Archive Project'}
            message={
              archiveTarget.archived
                ? `Restore project "${archiveTarget.name}" to active status?`
                : `Archive project "${archiveTarget.name}"? It will be hidden from default views.`
            }
            confirmLabel={archiveTarget.archived ? 'Unarchive' : 'Archive'}
            danger={!archiveTarget.archived}
            busy={updateProjectMutation.isPending}
            onConfirm={handleToggleArchive}
            onCancel={() => setArchiveTarget(null)}
          />
        )}

      {/* Confirm Delete Project */}
      {deleteTarget &&
        deleteTarget.scope === scopeKey &&
        deleteTarget.id === selectedProject?.id && (
          <ConfirmDialog
            open
            title="Delete Project"
            message={`Are you sure you want to permanently delete "${deleteTarget.name}" and all its notepads, boards, and cards? This action cannot be undone.`}
            confirmLabel="Delete Project"
            danger={true}
            busy={deleteProjectMutation.isPending}
            onConfirm={handleDeleteProject}
            onCancel={() => setDeleteTarget(null)}
          />
        )}

      {/* Confirm Delete Tag */}
      {tagToDelete &&
        tagToDelete.scope === scopeKey &&
        tagToDelete.projectId === selectedProject?.id && (
          <ConfirmDialog
            open={!!tagToDelete}
            title="Delete Tag"
            message={`Are you sure you want to delete tag "#${tagToDelete.name}"? Cards with this tag will keep their content.`}
            confirmLabel="Delete Tag"
            danger={true}
            busy={deleteTagMutation.isPending}
            onConfirm={handleDeleteTag}
            onCancel={() => setTagToDelete(null)}
          />
        )}
    </div>
  );
}
