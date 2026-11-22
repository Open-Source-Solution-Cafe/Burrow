import { useState, useEffect } from 'react';
import { useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, Plus, Settings, Tag, Trash2, Users, Check } from 'lucide-react';
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
  useSystemVersion,
  useUpdateProject,
} from '../lib/queries';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { Select } from '../components/ui/Select';
import { StatusDiamond } from '../components/ui/StatusDiamond';
import { workspaceTarget } from '../lib/workspaceRoutes';
import { useUploadPolicy, useUpdateUploadPolicy } from '../lib/uploadPolicy';
import { MAX_UPLOAD_BYTES, UPLOAD_FILE_TYPES } from '../../shared/uploadPolicy';
import { useTranslation } from '../lib/i18n';
import { FeatureFlagsSection } from '../components/settings/FeatureFlagsSection';
import { SystemUpdateSection } from '../components/settings/SystemUpdateSection';
import { DataPortabilitySection } from '../components/settings/DataPortabilitySection';

type SettingsTab = 'workspace' | 'system';

const SYSTEM_SETTINGS_HASHES = new Set(['features', 'system', 'portability', 'updates']);

function resolveSettingsTabFromHash(hash?: string): SettingsTab {
  const normalized = (hash ?? '').replace(/^#/, '').toLowerCase();
  return SYSTEM_SETTINGS_HASHES.has(normalized) ? 'system' : 'workspace';
}

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
  const { t } = useTranslation();
  const policy = useUploadPolicy(workspaceId, projectId);
  const update = useUpdateUploadPolicy(workspaceId, projectId);
  const systemVersion = useSystemVersion();
  const maxSupportedUploadBytes = systemVersion.data?.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const maxSupportedMb = maxSupportedUploadBytes / (1024 * 1024);
  const [sizeMb, setSizeMb] = useState('');
  const [allowedTypes, setAllowedTypes] = useState<string[]>([]);
  useEffect(() => {
    if (!policy.data) return;
    setSizeMb(String(policy.data.maxFileSizeBytes / (1024 * 1024)));
    setAllowedTypes(policy.data.allowedMimeTypes);
  }, [policy.data]);

  return (
    <section className="pt-5 border-t border-[var(--hair)] space-y-3">
      <h3 className="text-sm font-semibold text-[var(--text)]">{t('settings.fileUploadsTitle')}</h3>
      <p className="text-xs text-[var(--muted)]">
        {t('settings.fileUploadsDesc')}
      </p>
      {policy.isPending ? (
        <p className="text-xs text-[var(--muted)]">{t('common.loading')}</p>
      ) : policy.isError ? (
        <div className="text-xs text-[var(--danger)]">
          <p>{t('common.error')}</p>
          <Button type="button" variant="ghost" onClick={() => void policy.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <>
          <label className="block space-y-1.5 text-xs font-medium text-[var(--text)]">
            <span>
              {t('settings.maxFileSizeMb')}{' '}
              <span className="font-normal text-[var(--muted)]">(max {maxSupportedMb} MB)</span>
            </span>
            <Input
              type="number"
              min="0.01"
              max={maxSupportedMb}
              step="any"
              value={sizeMb}
              onChange={(event) => setSizeMb(event.target.value)}
              disabled={!canEdit || update.isPending}
              className="w-32"
            />
          </label>
          <fieldset disabled={!canEdit || update.isPending} className="space-y-2">
            <legend className="mb-2 text-xs font-medium text-[var(--text)]">
              {t('settings.allowedFileTypes')}
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
                  maxFileSizeBytes > maxSupportedUploadBytes
                ) {
                  toast.error(
                    `Enter a file size between 0.01 and ${maxSupportedMb} MB`,
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
              {update.isPending ? t('common.loading') : t('settings.saveUploadSettings')}
            </Button>
          ) : (
            <p className="text-xs text-[var(--muted)]">
              {t('settings.ownerUploadOnly')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function SettingsView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { data: account, isError: accountError } = useAccount();
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

  const [activeTab, setActiveTab] = useState<SettingsTab>(() =>
    resolveSettingsTabFromHash(
      location.hash || (typeof window !== 'undefined' ? window.location.hash : ''),
    ),
  );
  const [confirmLeaveWorkspace, setConfirmLeaveWorkspace] = useState(false);
  const [confirmDeleteWorkspace, setConfirmDeleteWorkspace] = useState(false);
  const [deleteWorkspaceConfirmName, setDeleteWorkspaceConfirmName] = useState('');
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');
  const systemVersion = useSystemVersion();

  useEffect(() => {
    const hash = location.hash || (typeof window !== 'undefined' ? window.location.hash : '');
    if (hash) {
      setActiveTab(resolveSettingsTabFromHash(hash));
      const targetId = hash.replace(/^#/, '').toLowerCase();
      if (targetId && typeof document !== 'undefined') {
        requestAnimationFrame(() => {
          document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    }
  }, [location.hash]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => {
      setActiveTab(resolveSettingsTabFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleTabChange = (next: string) => {
    const tab: SettingsTab = next === 'system' ? 'system' : 'workspace';
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      const nextUrl =
        tab === 'system'
          ? `${window.location.pathname}${window.location.search}#system`
          : `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', nextUrl);
    }
  };

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
      toast.success(t('settings.tagCreated'));
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
      toast.success(t('settings.tagDeleted'));
      setTagToDelete(null);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete tag');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto py-5 px-3.5 sm:py-8 sm:px-6 space-y-5 sm:space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text)]">
              {t('settings.title')}
            </h1>
            <p className="text-xs sm:text-sm text-[var(--muted)]">{t('settings.subtitle')}</p>
          </div>
          <SegmentedControl
            value={activeTab}
            onValueChange={handleTabChange}
            ariaLabel="Settings sections"
            options={[
              { value: 'workspace', label: 'Workspace & Projects' },
              {
                value: 'system',
                label:
                  systemVersion.data?.updateAvailable && systemVersion.data?.allowSelfUpdate
                    ? `Features & System • v${systemVersion.data.latestVersion}`
                    : 'Features & System',
              },
            ]}
          />
        </div>

        {activeTab === 'workspace' && (
          <>
            {workspaceId && currentWorkspace && (
              <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-[var(--hair)] pb-3">
              <Users className="w-4 h-4 text-[var(--accent)]" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
                {t('settings.workspaceSection')}
              </h2>
            </div>
            <form onSubmit={handleRenameWorkspace} className="flex flex-col sm:flex-row sm:items-end gap-2.5">
              <label className="w-full sm:min-w-56 sm:flex-1 space-y-1 text-xs font-medium text-[var(--text)]">
                {t('settings.workspaceNameLabel')}
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
                size="md"
                className="w-full sm:w-auto"
                disabled={
                  role !== 'owner' ||
                  !workspaceName.trim() ||
                  workspaceName.trim() === currentWorkspace.name ||
                  renameWorkspace.isPending
                }
              >
                {renameWorkspace.isPending ? t('common.loading') : t('settings.saveWorkspaceName')}
              </Button>
              <Badge className="uppercase text-[10px] tracking-wider font-mono self-start sm:self-center">
                {t(`common.roles.${role}` as any) || role || t('common.roles.member')}
              </Badge>
            </form>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--hair)] pt-3">
              <p className="max-w-xl text-xs text-[var(--muted)]">
                {t('settings.leaveWorkspaceNotice')}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="danger" size="sm" onClick={() => setConfirmLeaveWorkspace(true)}>
                  {t('settings.leaveWorkspace')}
                </Button>
                {role === 'owner' && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDeleteWorkspaceConfirmName('');
                      setConfirmDeleteWorkspace(true);
                    }}
                    className="border border-[var(--danger)]/40 text-[var(--danger)] hover:bg-[var(--danger)]/10"
                  >
                    Delete Workspace
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Project Settings */}
        <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between gap-4 border-b border-[var(--hair)] pb-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-[var(--accent)]" />
              <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
                {t('settings.projectSettingsTitle')}
              </h2>
            </div>

            {projects.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--muted)]">{t('settings.configuringProject')}</span>
                <Select
                  value={selectedProject?.id || ''}
                  onChange={(e) => {
                    setSelectedProjectId(e.target.value);
                    setArchiveTarget(null);
                    setDeleteTarget(null);
                    setTagToDelete(null);
                    setDraftScope(null);
                  }}
                  className="w-auto text-xs font-medium"
                >
                  {!selectedProject && <option value="">{t('settings.selectProjectPlaceholder')}</option>}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.icon || '📁'} {p.name} {p.archivedAt ? `(${t('common.archived')})` : ''}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          {projectsLoading ? (
            <div className="text-xs text-[var(--muted)] py-4">{t('settings.loadingProjectSettings')}</div>
          ) : projectsError || accountError ? (
            <div className="text-xs text-[var(--muted)] py-4">{t('settings.unableToLoadProjectSettings')}</div>
          ) : !selectedProject ? (
            <div className="text-xs text-[var(--muted)] italic py-4">
              {projects.length ? t('settings.selectAvailableProject') : t('settings.noProjectsAvailableDesc')}
            </div>
          ) : (
            <form onSubmit={handleSaveProject} className="space-y-4">
              {/* Project Name */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text)]">{t('settings.projectNameLabel')}</label>
                <Input
                  type="text"
                  required
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  disabled={isViewer}
                  className="w-full"
                  placeholder="e.g. Core App"
                />
              </div>

              {/* Icon Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--text)]">{t('settings.projectIconLabel')}</label>
                <div className="flex items-center gap-2 flex-wrap">
                  <Input
                    type="text"
                    value={projectIcon}
                    onChange={(e) => setProjectIcon(e.target.value)}
                    disabled={isViewer}
                    className="w-16 text-center text-base"
                    maxLength={4}
                  />
                  <div className="flex items-center gap-1 flex-wrap">
                    {ICON_PRESETS.map((icon) => (
                      <button
                        key={icon}
                        type="button"
                        onClick={() => setProjectIcon(icon)}
                        disabled={isViewer}
                        className={`w-7 h-7 flex items-center justify-center text-sm border transition cursor-pointer ${
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
                <label className="text-xs font-medium text-[var(--text)]">{t('settings.accentColorLabel')}</label>
                <div className="flex items-center gap-2 flex-wrap">
                  {COLOR_PRESETS.map((color) => {
                    const isSelected = projectColor === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setProjectColor(isSelected ? null : color)}
                        disabled={isViewer}
                        className={`w-6 h-6 flex items-center justify-center border transition cursor-pointer ${
                          isSelected ? 'border-[var(--text)] scale-110' : 'border-transparent'
                        }`}
                        style={{ backgroundColor: color }}
                        title={color}
                      >
                        {isSelected && <Check className="w-3 h-3 text-white stroke-[3]" />}
                      </button>
                    );
                  })}
                  {projectColor && (
                    <button
                      type="button"
                      onClick={() => setProjectColor(null)}
                      disabled={isViewer}
                      className="text-xs text-[var(--muted)] hover:text-[var(--text)] underline ml-2 cursor-pointer"
                    >
                      {t('common.clear')}
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
                    size="md"
                    disabled={
                      updateProjectMutation.isPending ||
                      draftScope !== scopeKey ||
                      !projectName.trim()
                    }
                  >
                    {updateProjectMutation.isPending ? t('common.saving') : t('settings.saveProjectChanges')}
                  </Button>
                </div>
              )}

              {/* Danger Zone: Archive / Delete */}
              {!isViewer && (
                <div className="pt-5 border-t border-[var(--hair)] space-y-3">
                  <h3 className="text-xs font-semibold text-[var(--danger)] uppercase tracking-wider">
                    {t('settings.dangerZone')}
                  </h3>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        scopeKey &&
                        setArchiveTarget({
                          scope: scopeKey,
                          id: selectedProject.id,
                          name: selectedProject.name,
                          archived: isArchived,
                        })
                      }
                      className="flex items-center gap-2 border border-[var(--line)]"
                    >
                      <Archive className="w-3.5 h-3.5" />
                      <span>{isArchived ? t('settings.unarchiveProject') : t('settings.archiveProject')}</span>
                    </Button>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() =>
                        scopeKey &&
                        setDeleteTarget({
                          scope: scopeKey,
                          id: selectedProject.id,
                          name: selectedProject.name,
                        })
                      }
                      className="flex items-center gap-2"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t('settings.deleteProject')}</span>
                    </Button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>

        {/* Section 3: Tag Management */}
        <div className="chamfer-sm border border-[var(--line)] bg-[var(--surface)] p-4 sm:p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-[var(--hair)] pb-3">
            <Tag className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">
              {t('settings.tagManagementTitle')}
            </h2>
          </div>

          <p className="text-xs text-[var(--muted)]">
            {t('settings.tagManagementDesc', { projectName: selectedProject?.name || 'current project' })}
          </p>

          {/* New Tag Form */}
          {!isViewer && selectedProject && (
            <form onSubmit={handleCreateTag} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <Input
                type="text"
                required
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder={t('settings.newTagNamePlaceholder')}
                className="flex-1 min-w-[180px]"
              />
              <div className="flex items-center gap-1 self-start sm:self-center">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewTagColor(c)}
                    className={`w-6 h-6 flex items-center justify-center border transition cursor-pointer ${
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
                size="md"
                disabled={createTagMutation.isPending || !newTagName.trim()}
                className="flex items-center justify-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{createTagMutation.isPending ? t('common.saving') : t('settings.addTag')}</span>
              </Button>
            </form>
          )}

          {/* Existing Tags List */}
          <div className="space-y-2 pt-2">
            {projectTags.length === 0 ? (
              <div className="text-xs text-[var(--muted)] italic py-1">
                {t('settings.noTagsYet')}
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                {projectTags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex items-center gap-1.5 px-2 py-1 h-7 border border-[var(--line)] bg-[var(--surface2)] text-xs font-medium text-[var(--text)] select-none"
                  >
                    <StatusDiamond color={tag.color || '#6366f1'} size={7} />
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
                        className="text-[var(--muted)] hover:text-[var(--danger)] transition ml-1 p-0.5 cursor-pointer"
                        title={`${t('common.delete')} #${tag.name}`}
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
          </>
        )}

        {activeTab === 'system' && (
          <>
            {workspaceId && currentWorkspace && (
              <FeatureFlagsSection workspaceId={workspaceId} isOwner={role === 'owner'} />
            )}

            {workspaceId && currentWorkspace && (
              <DataPortabilitySection
                workspaceId={workspaceId}
                workspaceName={currentWorkspace.name}
                role={role}
              />
            )}

            <SystemUpdateSection isOwner={role === 'owner'} />
          </>
        )}
      </div>

      {confirmLeaveWorkspace && currentWorkspace && (
        <ConfirmDialog
          open
          title={t('settings.confirmLeaveTitle')}
          message={t('settings.confirmLeaveMessage', { name: currentWorkspace.name })}
          confirmLabel={t('settings.leaveWorkspace')}
          danger
          busy={leaveWorkspace.isPending}
          onConfirm={handleLeaveWorkspace}
          onCancel={() => setConfirmLeaveWorkspace(false)}
        />
      )}

      {confirmDeleteWorkspace && currentWorkspace && workspaceId && (
        <ConfirmDialog
          open
          title="Permanently Delete Workspace"
          message={`This will permanently delete "${currentWorkspace.name}", all projects, notepads, boards, cards, and uploaded files. Type "${currentWorkspace.name}" to confirm:`}
          confirmLabel="Delete Workspace"
          danger
          busy={deletingWorkspace}
          confirmDisabled={deleteWorkspaceConfirmName !== currentWorkspace.name}
          onConfirm={async () => {
            setDeletingWorkspace(true);
            try {
              const res = await fetch(
                `/api/workspaces/${encodeURIComponent(workspaceId)}?confirm=${encodeURIComponent(deleteWorkspaceConfirmName)}`,
                { method: 'DELETE' },
              );
              if (!res.ok) {
                const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
                throw new Error(err.error?.message || 'Failed to delete workspace');
              }
              toast.success('Workspace permanently deleted');
              setConfirmDeleteWorkspace(false);
              navigate({ to: '/' });
            } catch (err) {
              toast.error(err instanceof Error ? err.message : 'Failed to delete workspace');
            } finally {
              setDeletingWorkspace(false);
            }
          }}
          onCancel={() => setConfirmDeleteWorkspace(false)}
        >
          <Input
            value={deleteWorkspaceConfirmName}
            onChange={(e) => setDeleteWorkspaceConfirmName(e.target.value)}
            placeholder={currentWorkspace.name}
            className="mt-2"
          />
        </ConfirmDialog>
      )}

      {/* Confirm Archive Project */}
      {archiveTarget &&
        archiveTarget.scope === scopeKey &&
        archiveTarget.id === selectedProject?.id && (
          <ConfirmDialog
            open
            title={archiveTarget.archived ? t('settings.unarchiveProject') : t('settings.archiveProject')}
            message={t('settings.confirmArchiveMessage', {
              action: archiveTarget.archived ? t('settings.unarchiveProject').toLowerCase() : t('settings.archiveProject').toLowerCase(),
              name: archiveTarget.name,
            })}
            confirmLabel={archiveTarget.archived ? t('settings.unarchiveProject') : t('settings.archiveProject')}
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
            title={t('settings.confirmDeleteProjectTitle')}
            message={t('settings.confirmDeleteProjectMessage', { name: deleteTarget.name })}
            confirmLabel={t('settings.deleteProject')}
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
            title={t('settings.confirmDeleteTagTitle')}
            message={t('settings.confirmDeleteTagMessage', { name: tagToDelete.name })}
            confirmLabel={t('common.delete')}
            danger={true}
            busy={deleteTagMutation.isPending}
            onConfirm={handleDeleteTag}
            onCancel={() => setTagToDelete(null)}
          />
        )}
    </div>
  );
}
