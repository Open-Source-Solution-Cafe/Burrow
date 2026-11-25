import { useEffect, useState, type ComponentType, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowRight, Folder, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  useAccount,
  useLeaveWorkspace,
  useProjects,
  useRenameWorkspace,
  useSystemVersion,
} from '../lib/queries';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { Input } from '../components/ui/Input';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { FeatureFlagsSection } from '../components/settings/FeatureFlagsSection';
import { PluginsSection } from '../components/settings/PluginsSection';
import { SystemUpdateSection } from '../components/settings/SystemUpdateSection';
import { DataPortabilitySection } from '../components/settings/DataPortabilitySection';
import {
  SettingsCard,
  SettingsCardHeader,
  SettingsPageShell,
  useScrollToHash,
} from '../components/settings/SettingsCard';
import { useTranslation } from '../lib/i18n';
import {
  projectSettingsTarget,
  resolveLegacyProjectSettingsHash,
  workspaceMembersTarget,
} from '../lib/workspaceRoutes';
import { useWebPlugins } from '../plugins/registry';

type WorkspaceSettingsTab = 'workspace' | 'system';

const SYSTEM_SETTINGS_HASHES = new Set(['features', 'plugins', 'system', 'portability', 'updates']);

function normalizeHash(hash?: string): string {
  return (hash ?? '').replace(/^#/, '').toLowerCase();
}

function resolveSettingsTabFromHash(hash?: string): WorkspaceSettingsTab {
  return SYSTEM_SETTINGS_HASHES.has(normalizeHash(hash)) ? 'system' : 'workspace';
}

export function WorkspaceSettings() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { settingsSections } = useWebPlugins();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { data: account, isError: accountError } = useAccount();
  const {
    data: projects = [],
    isLoading: projectsLoading,
    isError: projectsError,
  } = useProjects(workspaceId);
  const renameWorkspace = useRenameWorkspace(workspaceId);
  const leaveWorkspace = useLeaveWorkspace(workspaceId);
  const systemVersion = useSystemVersion();

  const currentHash = location.hash || (typeof window !== 'undefined' ? window.location.hash : '');
  const { isProjectHash: isProjectRedirectHash, targetHash: mappedRedirectHash } =
    resolveLegacyProjectSettingsHash(currentHash);

  const [activeTab, setActiveTab] = useState<WorkspaceSettingsTab>(() =>
    resolveSettingsTabFromHash(currentHash),
  );
  const [confirmLeaveWorkspace, setConfirmLeaveWorkspace] = useState(false);
  const [confirmDeleteWorkspace, setConfirmDeleteWorkspace] = useState(false);
  const [deleteWorkspaceConfirmName, setDeleteWorkspaceConfirmName] = useState('');
  const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('');

  // Redirect legacy project-scoped hashes (e.g. /settings#project) to /p/$projectId/settings
  const savedProjectId =
    workspaceId && typeof localStorage !== 'undefined'
      ? localStorage.getItem(`burrow-last-project:${workspaceId}`)
      : null;
  const redirectTargetProject = projects.find((p) => p.id === savedProjectId) ?? projects[0];

  useEffect(() => {
    if (!isProjectRedirectHash || !workspaceId || projectsLoading || projectsError) return;
    if (!redirectTargetProject) return;
    void navigate({
      ...projectSettingsTarget(workspaceId, redirectTargetProject.id),
      ...(mappedRedirectHash ? { hash: mappedRedirectHash } : {}),
      replace: true,
    });
  }, [
    isProjectRedirectHash,
    mappedRedirectHash,
    workspaceId,
    projectsLoading,
    projectsError,
    redirectTargetProject,
    navigate,
  ]);

  useEffect(() => {
    if (currentHash) {
      setActiveTab(resolveSettingsTabFromHash(currentHash));
    }
  }, [currentHash]);

  useScrollToHash(currentHash, !isProjectRedirectHash);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => {
      setActiveTab(resolveSettingsTabFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleTabChange = (next: string) => {
    const tab: WorkspaceSettingsTab = next === 'system' ? 'system' : 'workspace';
    setActiveTab(tab);
    if (typeof window !== 'undefined') {
      const nextUrl =
        tab === 'system'
          ? `${window.location.pathname}${window.location.search}#system`
          : `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, '', nextUrl);
    }
  };

  const role = account?.workspaces.find((workspace) => workspace.id === workspaceId)?.role;
  const currentWorkspace = account?.workspaces.find((workspace) => workspace.id === workspaceId);

  useEffect(() => {
    setWorkspaceName(currentWorkspace?.name ?? '');
  }, [workspaceId, currentWorkspace?.name]);

  const handleRenameWorkspace = async (event: FormEvent) => {
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

  if (isProjectRedirectHash && (projectsLoading || (!projectsError && redirectTargetProject))) {
    return (
      <SettingsPageShell>
        <p className="text-xs text-[var(--muted)]">{t('settings.redirectingToProjectSettings')}</p>
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[var(--text)]">
            {t('settings.workspaceSettingsTitle')}
          </h1>
          <p className="text-xs sm:text-sm text-[var(--muted)]">
            {t('settings.workspaceSettingsSubtitle')}
          </p>
        </div>
        <SegmentedControl
          value={activeTab}
          onValueChange={handleTabChange}
          ariaLabel="Settings sections"
          options={[
            { value: 'workspace', label: 'Workspace' },
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
            <SettingsCard>
              <SettingsCardHeader
                icon={<Users className="w-4 h-4 text-[var(--accent)]" />}
                title={t('settings.workspaceSection')}
                actions={
                  <Link
                    {...workspaceMembersTarget(workspaceId)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
                  >
                    <span>{t('settings.openWorkspaceMembers')}</span>
                  </Link>
                }
              />

              <form
                onSubmit={handleRenameWorkspace}
                className="flex flex-col sm:flex-row sm:items-end gap-2.5"
              >
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
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmLeaveWorkspace(true)}
                  >
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
            </SettingsCard>
          )}

          {workspaceId && (
            <SettingsCard>
              <SettingsCardHeader
                icon={<Folder className="w-4 h-4 text-[var(--accent)]" />}
                title={t('settings.projectsInWorkspaceTitle')}
              />
              <p className="text-xs text-[var(--muted)]">{t('settings.projectsInWorkspaceDesc')}</p>

              {projectsLoading ? (
                <div className="text-xs text-[var(--muted)] py-2">
                  {t('settings.loadingProjectSettings')}
                </div>
              ) : projectsError || accountError ? (
                <div className="text-xs text-[var(--muted)] py-2">
                  {t('settings.unableToLoadProjectSettings')}
                </div>
              ) : projects.length === 0 ? (
                <div className="text-xs text-[var(--muted)] italic py-2">
                  {t('settings.noProjectsAvailableDesc')}
                </div>
              ) : (
                <div className="divide-y divide-[var(--hair)] border border-[var(--hair)]">
                  {projects.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 bg-[var(--surface2)]/40"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="text-base shrink-0">{p.icon || '📁'}</span>
                        {p.color && (
                          <span
                            className="w-2.5 h-2.5 shrink-0 border border-black/15"
                            style={{ backgroundColor: p.color }}
                            aria-hidden="true"
                          />
                        )}
                        <span className="text-sm font-medium text-[var(--text)] truncate">
                          {p.name}
                        </span>
                        {p.archivedAt && (
                          <Badge className="text-[10px] font-mono uppercase shrink-0">
                            {t('common.archived')}
                          </Badge>
                        )}
                      </div>
                      <Link
                        {...projectSettingsTarget(workspaceId, p.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-[var(--line)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--hi)] transition shrink-0"
                      >
                        <span>{t('settings.openProjectSettings')}</span>
                        <ArrowRight className="w-3 h-3" aria-hidden="true" />
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </SettingsCard>
          )}

          {workspaceId &&
            settingsSections.map((section) => {
              const SectionComponent = section.render as ComponentType<{ workspaceId: string }>;
              return (
                <div key={section.id} id={section.id}>
                  <SectionComponent workspaceId={workspaceId} />
                </div>
              );
            })}
        </>
      )}

      {activeTab === 'system' && (
        <>
          {workspaceId && currentWorkspace && (
            <FeatureFlagsSection workspaceId={workspaceId} isOwner={role === 'owner'} />
          )}

          {workspaceId && currentWorkspace && (
            <PluginsSection isOwner={role === 'owner'} />
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
    </SettingsPageShell>
  );
}
