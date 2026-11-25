import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, ArrowLeft, Check, Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  useAccount,
  useDeleteProject,
  useProjects,
  useUpdateProject,
} from '../lib/queries';

type ProjectItem = NonNullable<ReturnType<typeof useProjects>['data']>[number];
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { ProjectTagManagementCard } from '../components/settings/ProjectTagManagementCard';
import { ProjectUploadSettingsSection } from '../components/settings/ProjectUploadSettingsSection';
import {
  COLOR_PRESETS,
  ICON_PRESETS,
  SettingsCard,
  SettingsCardHeader,
  SettingsPageShell,
  useScrollToHash,
} from '../components/settings/SettingsCard';
import { useTranslation } from '../lib/i18n';
import {
  projectSettingsTarget,
  projectTarget,
  workspaceSettingsTarget,
  workspaceTarget,
} from '../lib/workspaceRoutes';

function ProjectSettingsContent({
  workspaceId,
  workspaceName,
  project,
  remainingProjects,
  isViewer,
  canEditUploads,
}: {
  workspaceId: string;
  workspaceName?: string;
  project: ProjectItem;
  remainingProjects: readonly ProjectItem[];
  isViewer: boolean;
  canEditUploads: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const updateProjectMutation = useUpdateProject(workspaceId);
  const deleteProjectMutation = useDeleteProject(workspaceId);

  const [projectName, setProjectName] = useState(project.name);
  const [projectIcon, setProjectIcon] = useState(project.icon || '📁');
  const [projectColor, setProjectColor] = useState<string | null>(project.color || null);

  const [archiveTarget, setArchiveTarget] = useState<{
    id: string;
    name: string;
    archived: boolean;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  useEffect(() => {
    setProjectName(project.name);
    setProjectIcon(project.icon || '📁');
    setProjectColor(project.color || null);
  }, [project.id, project.name, project.icon, project.color]);

  useScrollToHash(location.hash, true);

  const isArchived = Boolean(project.archivedAt);

  const handleSaveProject = async (e: FormEvent) => {
    e.preventDefault();
    if (isViewer || !projectName.trim()) return;
    try {
      await updateProjectMutation.mutateAsync({
        id: project.id,
        name: projectName.trim(),
        icon: projectIcon,
        color: projectColor,
      });
      toast.success('Project settings saved');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update project');
    }
  };

  const handleToggleArchive = async () => {
    if (!archiveTarget || archiveTarget.id !== project.id || isViewer) return;
    const nextArchived = !archiveTarget.archived;
    try {
      await updateProjectMutation.mutateAsync({
        id: archiveTarget.id,
        archived: nextArchived,
      });
      toast.success(nextArchived ? 'Project archived' : 'Project unarchived');
      setArchiveTarget(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update archive status');
    }
  };

  const handleDeleteProject = async () => {
    if (
      !deleteTarget ||
      deleteTarget.id !== project.id ||
      isViewer ||
      deleteConfirmName !== deleteTarget.name
    )
      return;
    try {
      await deleteProjectMutation.mutateAsync({
        id: deleteTarget.id,
        confirmName: deleteConfirmName,
      });
      toast.success('Project deleted');
      setDeleteTarget(null);
      setDeleteConfirmName('');
      const nextProject = remainingProjects.find((p) => p.id !== deleteTarget.id);
      if (nextProject) {
        localStorage.setItem(`burrow-last-project:${workspaceId}`, nextProject.id);
        navigate(projectSettingsTarget(workspaceId, nextProject.id));
      } else {
        localStorage.removeItem(`burrow-last-project:${workspaceId}`);
        navigate(workspaceTarget(workspaceId));
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete project');
    }
  };

  return (
    <SettingsPageShell>
      {/* Clear Project Identity Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--hair)] pb-4">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="w-11 h-11 flex items-center justify-center text-2xl border border-[var(--line)] bg-[var(--surface)] shrink-0"
            style={project.color ? { borderColor: project.color } : undefined}
          >
            {project.icon || '📁'}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text)] truncate">
                {project.name}
              </h1>
              {isArchived && (
                <Badge className="uppercase text-[10px] tracking-wider font-mono">
                  {t('common.archived')}
                </Badge>
              )}
            </div>
            <p className="text-xs sm:text-sm text-[var(--muted)]">
              {t('settings.projectSettingsTitle')}
              {workspaceName ? ` • ${workspaceName}` : ''} — {t('settings.projectSettingsSubtitle')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <Link
            {...projectTarget(workspaceId, project.id)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-[var(--line)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hi)] transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('settings.openProjectOverview')}</span>
          </Link>
          <Link
            {...workspaceSettingsTarget(workspaceId)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hi)] transition"
          >
            <span>{t('settings.openWorkspaceSettings')}</span>
          </Link>
        </div>
      </div>

      {/* Project Details & File Uploads */}
      <SettingsCard>
        <SettingsCardHeader
          icon={<Settings className="w-4 h-4 text-[var(--accent)]" />}
          title={t('settings.projectSettingsTitle')}
        />

        <form onSubmit={handleSaveProject} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--text)]">
              {t('settings.projectNameLabel')}
            </label>
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

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--text)]">
              {t('settings.projectIconLabel')}
            </label>
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

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-[var(--text)]">
              {t('settings.accentColorLabel')}
            </label>
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

          <ProjectUploadSettingsSection
            id="uploads"
            workspaceId={workspaceId}
            projectId={project.id}
            canEdit={canEditUploads}
          />

          {!isViewer && (
            <div className="pt-2 flex items-center gap-3">
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={updateProjectMutation.isPending || !projectName.trim()}
              >
                {updateProjectMutation.isPending
                  ? t('common.saving')
                  : t('settings.saveProjectChanges')}
              </Button>
            </div>
          )}
        </form>
      </SettingsCard>

      {/* Tag Management */}
      <ProjectTagManagementCard
        workspaceId={workspaceId}
        projectId={project.id}
        projectName={project.name}
        isViewer={isViewer}
      />

      {/* Danger Zone */}
      {!isViewer && (
        <SettingsCard id="danger-zone">
          <SettingsCardHeader
            icon={<Trash2 className="w-4 h-4 text-[var(--danger)]" />}
            title={t('settings.dangerZone')}
          />
          <div className="flex items-center gap-2.5 flex-wrap">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setArchiveTarget({
                  id: project.id,
                  name: project.name,
                  archived: isArchived,
                })
              }
              className="flex items-center gap-2 border border-[var(--line)]"
            >
              <Archive className="w-3.5 h-3.5" />
              <span>
                {isArchived
                  ? t('settings.unarchiveProjectNamed', { name: project.name })
                  : t('settings.archiveProjectNamed', { name: project.name })}
              </span>
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => {
                setDeleteConfirmName('');
                setDeleteTarget({
                  id: project.id,
                  name: project.name,
                });
              }}
              className="flex items-center gap-2"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('settings.deleteProjectNamed', { name: project.name })}</span>
            </Button>
          </div>
        </SettingsCard>
      )}

      {archiveTarget && archiveTarget.id === project.id && (
        <ConfirmDialog
          open
          title={
            archiveTarget.archived
              ? t('settings.unarchiveProjectNamed', { name: archiveTarget.name })
              : t('settings.archiveProjectNamed', { name: archiveTarget.name })
          }
          message={t('settings.confirmArchiveMessage', {
            action: archiveTarget.archived
              ? t('settings.unarchiveProject').toLowerCase()
              : t('settings.archiveProject').toLowerCase(),
            name: archiveTarget.name,
          })}
          confirmLabel={
            archiveTarget.archived
              ? t('settings.unarchiveProjectNamed', { name: archiveTarget.name })
              : t('settings.archiveProjectNamed', { name: archiveTarget.name })
          }
          danger={!archiveTarget.archived}
          busy={updateProjectMutation.isPending}
          onConfirm={handleToggleArchive}
          onCancel={() => setArchiveTarget(null)}
        />
      )}

      {deleteTarget && deleteTarget.id === project.id && (
        <ConfirmDialog
          open
          title={t('settings.confirmDeleteProjectTitle')}
          message={t('settings.confirmDeleteProjectMessage', { name: deleteTarget.name })}
          confirmLabel={t('settings.deleteProjectConfirmAction', { name: deleteTarget.name })}
          danger={true}
          busy={deleteProjectMutation.isPending}
          confirmDisabled={deleteConfirmName !== deleteTarget.name}
          onConfirm={handleDeleteProject}
          onCancel={() => {
            setDeleteTarget(null);
            setDeleteConfirmName('');
          }}
        >
          <Input
            value={deleteConfirmName}
            onChange={(e) => setDeleteConfirmName(e.target.value)}
            placeholder={deleteTarget.name}
            aria-label={deleteTarget.name}
            autoFocus
            className="mt-2"
          />
        </ConfirmDialog>
      )}
    </SettingsPageShell>
  );
}

export function ProjectSettings() {
  const { t } = useTranslation();
  const { workspaceId, projectId } = useParams({ strict: false }) as {
    workspaceId?: string;
    projectId?: string;
  };
  const { data: account, isError: accountError } = useAccount();
  const {
    data: projects = [],
    isLoading: projectsLoading,
    isError: projectsError,
  } = useProjects(workspaceId);

  const project = projects.find((p) => p.id === projectId);
  const currentWorkspace = account?.workspaces.find((workspace) => workspace.id === workspaceId);
  const role = currentWorkspace?.role;
  const isViewer = !account || accountError || projectsError || role === 'viewer' || !workspaceId;

  useEffect(() => {
    if (workspaceId && project?.id && typeof localStorage !== 'undefined') {
      localStorage.setItem(`burrow-last-project:${workspaceId}`, project.id);
    }
  }, [workspaceId, project?.id]);

  if (projectsLoading) {
    return (
      <SettingsPageShell>
        <div className="text-xs text-[var(--muted)] py-4">{t('settings.loadingProjectSettings')}</div>
      </SettingsPageShell>
    );
  }

  if (projectsError || accountError || !workspaceId || !project) {
    return (
      <SettingsPageShell>
        <div className="text-xs text-[var(--muted)] py-4">
          {t('settings.unableToLoadProjectSettings')}
        </div>
      </SettingsPageShell>
    );
  }

  return (
    <ProjectSettingsContent
      key={`${workspaceId}:${project.id}`}
      workspaceId={workspaceId}
      workspaceName={currentWorkspace?.name}
      project={project}
      remainingProjects={projects}
      isViewer={isViewer}
      canEditUploads={role === 'owner'}
    />
  );
}
