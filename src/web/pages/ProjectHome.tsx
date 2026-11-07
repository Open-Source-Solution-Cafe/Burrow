import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { FileText, Kanban, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useBoards, useCreateBoard, useProjects, useRecentNotepads } from '../lib/queries';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { PromptDialog } from '../components/ui/PromptDialog';
import { useTranslation } from '../lib/i18n';
import {
  boardTarget,
  notepadTarget,
  projectApiPath,
  projectLibraryTarget,
} from '../lib/workspaceRoutes';

export function ProjectHome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { workspaceId, projectId } = useParams({ strict: false }) as {
    workspaceId?: string;
    projectId?: string;
  };
  const {
    data: projects = [],
    isLoading: projectsLoading,
    isError: projectsError,
  } = useProjects(workspaceId);
  const project = projectId === undefined ? projects[0] : projects.find((p) => p.id === projectId);
  const currentProjectId = project?.id;
  const { data: boards = [] } = useBoards(workspaceId, currentProjectId);
  const { data: recentNotepads = [] } = useRecentNotepads(workspaceId, currentProjectId);
  const createBoardMutation = useCreateBoard();
  const [createBoardOpen, setCreateBoardOpen] = useState(false);
  const [createNotepadPending, setCreateNotepadPending] = useState(false);

  if (projectsLoading || projectsError || !project) {
    return (
      <div className="flex-1 p-8 text-sm text-[var(--muted)]" role="status">
        {projectsLoading
          ? t('project.loadingProject')
          : projectsError
            ? t('project.unableToLoad')
            : projectId !== undefined
              ? t('project.projectNotFound')
              : t('project.noProjectsAvailable')}
      </div>
    );
  }

  const handleCreateBoard = () => {
    if (!currentProjectId) return;
    setCreateBoardOpen(true);
  };

  const handleCreateNotepad = async () => {
    if (!currentProjectId || !workspaceId || createNotepadPending) return;
    setCreateNotepadPending(true);
    try {
      const res = await fetch(projectApiPath(workspaceId, currentProjectId, 'notepads'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Untitled' }),
      });
      if (!res.ok) {
        throw new Error(t('common.error'));
      }
      const data = (await res.json()) as { id: string };
      queryClient.invalidateQueries({ queryKey: ['notepads', workspaceId, currentProjectId] });
      queryClient.invalidateQueries({
        queryKey: ['recent-notepads', workspaceId, currentProjectId],
      });
      toast.success(t('project.notepadCreated'));
      navigate(notepadTarget(workspaceId, currentProjectId, data.id));
    } catch (err: any) {
      toast.error(err?.message || t('common.error'));
    } finally {
      setCreateNotepadPending(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto py-6 px-4 sm:py-8 sm:px-6 space-y-6 sm:space-y-8">
        {/* Project Banner / Title */}
        <div className="space-y-2 border-b border-[var(--hair)] pb-6">
          <div className="text-4xl mb-2">{project?.icon || '📁'}</div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">
            {project?.name || t('project.overview')}
          </h1>
          <p className="text-sm text-[var(--muted)]">
            {t('project.manageScopedResources')}
          </p>
          <Link
            {...projectLibraryTarget(workspaceId!, project.id)}
            className="inline-flex min-h-11 items-center text-sm text-[var(--accent)] underline"
          >
            {t('project.openLibrary')}
          </Link>
        </div>

        {/* Quick Action Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card className="p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium text-sm text-[var(--text)]">
                <FileText className="w-4 h-4 text-[var(--accent)]" />
                <span>{t('project.notepadsTitle')}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCreateNotepad}
                disabled={createNotepadPending}
                className="p-1 min-w-[32px] min-h-[32px] text-[var(--muted)] hover:text-[var(--text)]"
                title={t('project.addNotepad')}
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </div>
            <p className="text-xs text-[var(--muted)]">
              {t('project.notepadsDesc')}
            </p>
            <div className="pt-2 space-y-1">
              {recentNotepads.length === 0 ? (
                <span className="text-xs text-[var(--muted)] italic">
                  {t('project.noNotepadsYet')}
                </span>
              ) : (
                recentNotepads.slice(0, 5).map((np) => (
                  <Link
                    key={np.id}
                    {...notepadTarget(workspaceId!, currentProjectId!, np.id)}
                    className="flex items-center gap-2 text-xs font-medium text-[var(--text)] hover:text-[var(--accent)] transition py-1"
                  >
                    <span>{np.icon || '📄'}</span>
                    <span className="truncate">{np.title || t('common.untitled')}</span>
                  </Link>
                ))
              )}
            </div>
          </Card>

          <Card className="p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-medium text-sm text-[var(--text)]">
                <Kanban className="w-4 h-4 text-emerald-500" />
                <span>{t('project.kanbanBoardsTitle')}</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCreateBoard}
                className="p-1 min-w-[32px] min-h-[32px] text-[var(--muted)] hover:text-[var(--text)]"
                title={t('project.addBoard')}
              >
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </div>
            <p className="text-xs text-[var(--muted)]">
              {t('project.kanbanBoardsDesc')}
            </p>
            <div className="pt-2 space-y-1">
              {boards.length === 0 ? (
                <span className="text-xs text-[var(--muted)] italic">
                  {t('project.noBoardsYet')}
                </span>
              ) : (
                boards.map((b) => (
                  <Link
                    key={b.id}
                    {...boardTarget(workspaceId!, currentProjectId!, b.id)}
                    className="block text-xs font-medium text-[var(--text)] hover:text-[var(--accent)] transition py-1"
                  >
                    {b.icon || '📋'} {b.name}
                  </Link>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>

      <PromptDialog
        open={createBoardOpen}
        title={t('project.createBoardDialogTitle')}
        message={t('project.createBoardDialogMessage')}
        defaultValue={t('project.createBoardDialogDefault')}
        placeholder={t('project.createBoardDialogPlaceholder')}
        confirmLabel={t('common.create')}
        busy={createBoardMutation.isPending}
        onConfirm={async (name) => {
          if (!currentProjectId || !workspaceId) return;
          try {
            const res = await createBoardMutation.mutateAsync({
              workspaceId,
              projectId: currentProjectId,
              name,
            });
            setCreateBoardOpen(false);
            navigate(boardTarget(workspaceId, currentProjectId, res.id));
          } catch (err: any) {
            toast.error(err?.message || t('common.error'));
          }
        }}
        onCancel={() => setCreateBoardOpen(false)}
      />
    </div>
  );
}
