import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { AppShell } from './components/layout/AppShell';
import { BoardView } from './components/boards/BoardView';
import { NotepadEditor } from './editor/NotepadEditor';
import { TrashView } from './pages/TrashView';
import { Login } from './pages/Login';
import { InviteAccept } from './pages/InviteAccept';
import { ProjectHome } from './pages/ProjectHome';
import { ProjectMediaLibrary } from './components/media/ProjectMediaLibrary';
import { MembersSettings } from './pages/MembersSettings';
import { MyTasksView } from './pages/MyTasksView';
import { SettingsView } from './pages/SettingsView';
import { StatusDiamond } from './components/ui/StatusDiamond';
import { useTranslation, t } from './lib/i18n';
import {
  accountProjectsQueryOptions,
  useAccount,
  useCreateWorkspace,
  useProjects,
} from './lib/queries';
import {
  boardTarget,
  notepadTarget,
  projectTarget,
  trashTarget,
  uniqueWorkspaceForProject,
  workspaceTarget,
} from './lib/workspaceRoutes';

const rootRoute = createRootRoute({
  component: () => <Outlet />,
  errorComponent: ({ error, reset }) => (
    <div className="flex h-screen flex-col items-center justify-center p-8 text-center bg-[var(--bg)] text-[var(--text)]">
      <div className="text-4xl mb-4">⚠️</div>
      <h2 className="text-lg font-bold mb-2">{t('router.somethingWentWrong')}</h2>
      <p className="text-xs text-[var(--muted)] max-w-md mb-6">
        {error instanceof Error ? error.message : t('router.unexpectedError')}
      </p>
      <button
        onClick={() => {
          reset();
          window.location.reload();
        }}
        className="px-4 py-2 bg-[var(--accent)] text-[var(--accent-ink)] text-xs font-semibold hover:opacity-90 transition cursor-pointer"
      >
        {t('router.reloadPage')}
      </button>
    </div>
  ),
});

function AccountHome() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: account, isLoading, isError, refetch } = useAccount();
  const createWorkspace = useCreateWorkspace();
  const [workspaceName, setWorkspaceName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading || isError) return;
    if (!account) {
      void navigate({ to: '/login' });
    } else if (account.workspaces.length === 1) {
      void navigate(workspaceTarget(account.workspaces[0]!.id));
    }
  }, [account, isLoading, isError, navigate]);

  if (isLoading || (account?.workspaces.length === 1 && !isError)) {
    return <Status>{t('router.loadingWorkspaces')}</Status>;
  }
  if (isError) {
    return (
      <Status>
        {t('router.couldNotLoadWorkspaces')}{' '}
        <button className="underline cursor-pointer" onClick={() => void refetch()}>
          {t('router.tryAgain')}
        </button>
      </Status>
    );
  }
  if (!account) return <Status>{t('router.redirectingToSignIn')}</Status>;
  if (account.workspaces.length === 0) {
    const create = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCreateError(null);
      try {
        const result = await createWorkspace.mutateAsync({
          name: workspaceName.trim(),
          requestId: crypto.randomUUID(),
        });
        void navigate(workspaceTarget(result.workspace.id));
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : t('common.error'));
      }
    };
    return (
      <form
        onSubmit={create}
        className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col justify-center gap-4 px-4 py-6 sm:p-8"
      >
        <h1 className="text-2xl font-bold text-[var(--text)]">{t('router.createWorkspace')}</h1>
        <p className="text-sm text-muted">
          {t('router.createWorkspaceDesc')}
        </p>
        <label className="grid gap-1 text-xs font-medium text-text" htmlFor="first-workspace-name">
          {t('router.workspaceName')}
          <input
            id="first-workspace-name"
            className="min-h-11 border border-line bg-surface px-3 text-base sm:text-sm"
            value={workspaceName}
            onChange={(event) => setWorkspaceName(event.target.value)}
            maxLength={100}
            required
          />
        </label>
        {createError && (
          <p className="text-xs text-danger" role="alert">
            {createError}
          </p>
        )}
        <button
          type="submit"
          disabled={!workspaceName.trim() || createWorkspace.isPending}
          className="min-h-11 bg-accent px-4 text-sm font-semibold text-accent-ink disabled:opacity-50 cursor-pointer"
        >
          {createWorkspace.isPending ? t('router.creatingWorkspace') : t('router.createWorkspaceButton')}
        </button>
      </form>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto px-4 py-6 sm:p-8">
      <h1 className="text-2xl font-bold text-[var(--text)]">{t('router.chooseWorkspace')}</h1>
      <div className="grid gap-2">
        {account.workspaces.map((workspace) => (
          <Link
            key={workspace.id}
            {...workspaceTarget(workspace.id)}
            className="flex min-h-12 items-center justify-between border border-line bg-surface px-4 py-3 text-sm text-text hover:bg-hi"
          >
            <span>{workspace.name}</span>
            <span className="text-xs text-muted capitalize">
              {t(`common.roles.${workspace.role}` as any) || workspace.role}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex h-full items-center justify-center p-8 text-center text-sm text-[var(--muted)]"
      role="status"
    >
      {children}
    </div>
  );
}

function WorkspaceGate() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { data: account, isLoading, isError } = useAccount();
  const workspace = account?.workspaces.find((item) => item.id === workspaceId);

  useEffect(() => {
    if (isLoading || isError) return;
    if (!account) void navigate({ to: '/login' });
    else if (!workspace) void navigate({ to: '/' });
  }, [account, isLoading, isError, workspace, navigate]);

  if (isLoading || (account && !workspace)) return <Status>{t('router.loadingWorkspace')}</Status>;
  if (isError) return <Status>{t('router.couldNotLoadWorkspace')}</Status>;
  if (!workspace) return <Status>{t('router.workspaceUnavailable')}</Status>;
  return <Outlet />;
}

function WorkspaceIndex() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { data: projects = [], isLoading, isError } = useProjects(workspaceId);

  useEffect(() => {
    if (!isLoading && !isError && projects.length > 0 && workspaceId) {
      const lastProject = localStorage.getItem(`burrow-last-project:${workspaceId}`);
      const project = projects.find((item) => item.id === lastProject) ?? projects[0]!;
      void navigate(projectTarget(workspaceId, project.id));
    }
  }, [projects, workspaceId, isLoading, isError, navigate]);

  if (isLoading) return <Status>{t('router.loadingProjects')}</Status>;
  if (isError) return <Status>{t('router.couldNotLoadProjects')}</Status>;
  if (projects.length > 0) return <Status>{t('router.openingProject')}</Status>;
  return <Status>{t('router.noActiveProjects')}</Status>;
}

function ProjectGate() {
  const { t } = useTranslation();
  const { workspaceId, projectId } = useParams({ strict: false }) as {
    workspaceId?: string;
    projectId?: string;
  };
  const { data: projects = [], isLoading, isError } = useProjects(workspaceId);
  if (isLoading) return <Status>{t('router.loadingProject')}</Status>;
  if (isError) return <Status>{t('router.couldNotVerifyProjectLink')}</Status>;
  if (!projectId || !projects.some((project) => project.id === projectId)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-[var(--muted)]">
        <p>{t('router.projectUnavailableInWorkspace')}</p>
        {workspaceId && (
          <Link {...workspaceTarget(workspaceId)} className="underline text-[var(--text)]">
            {t('router.chooseAnotherProject')}
          </Link>
        )}
      </div>
    );
  }
  return <Outlet />;
}

type LegacyTarget = 'home' | 'notepad' | 'board' | 'trash';

function LegacyProjectRedirect({ target }: { target: LegacyTarget }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { projectId, notepadId, boardId } = useParams({ strict: false }) as {
    projectId?: string;
    notepadId?: string;
    boardId?: string;
  };
  const { data: account, isLoading: accountLoading, isError: accountError } = useAccount();
  const workspaces = account?.workspaces ?? [];
  const projectQueries = useQueries({
    queries: workspaces.map((workspace) =>
      accountProjectsQueryOptions(account!.user.id, workspace.id),
    ),
  });
  const pending = projectQueries.some((query) => query.isLoading);
  const failed = projectQueries.some((query) => query.isError);
  const projectsByWorkspace = new Map(
    workspaces.map((workspace, index) => [workspace.id, projectQueries[index]?.data ?? []]),
  );
  const resolvedWorkspace = projectId
    ? uniqueWorkspaceForProject(projectId, workspaces, projectsByWorkspace)
    : null;

  useEffect(() => {
    if (accountLoading || accountError || pending || failed) return;
    if (!account) {
      void navigate({ to: '/login' });
      return;
    }
    if (!resolvedWorkspace || !projectId) return;
    const routeTarget =
      target === 'notepad' && notepadId
        ? notepadTarget(resolvedWorkspace, projectId, notepadId)
        : target === 'board' && boardId
          ? boardTarget(resolvedWorkspace, projectId, boardId)
          : target === 'trash'
            ? trashTarget(resolvedWorkspace, projectId)
            : projectTarget(resolvedWorkspace, projectId);
    void navigate(routeTarget);
  }, [
    accountLoading,
    accountError,
    pending,
    failed,
    account,
    resolvedWorkspace,
    projectId,
    notepadId,
    boardId,
    target,
    navigate,
  ]);

  if (accountLoading || pending) return <Status>{t('router.resolvingProjectLink')}</Status>;
  if (accountError) return <Status>{t('router.couldNotVerifyProjectLink')}</Status>;
  if (!account) return <Status>{t('router.redirectingToSignIn')}</Status>;
  if (failed) return <Status>{t('router.couldNotVerifyProjectLink')}</Status>;
  if (!resolvedWorkspace) {
    return <Status>{t('router.projectLinkUnavailable')}</Status>;
  }
  return <Status>{t('router.openingProject')}</Status>;
}

function NotepadView() {
  const { t } = useTranslation();
  const { workspaceId, notepadId, projectId } = useParams({ strict: false }) as {
    workspaceId?: string;
    notepadId?: string;
    projectId?: string;
  };
  if (!workspaceId || !notepadId || !projectId)
    return <div className="p-8 text-sm text-[var(--muted)]">{t('router.selectNotepad')}</div>;
  return (
    <div className="flex-1 overflow-y-auto w-full">
      <NotepadEditor workspaceId={workspaceId} notepadId={notepadId} projectId={projectId} />
    </div>
  );
}

function BoardWrapper() {
  const { t } = useTranslation();
  const { workspaceId, projectId, boardId } = useParams({ strict: false }) as {
    workspaceId?: string;
    projectId?: string;
    boardId?: string;
  };
  if (!workspaceId || !projectId || !boardId) {
    return <div className="p-8 text-sm text-[var(--muted)]">{t('router.boardNotFound')}</div>;
  }
  return <BoardView workspaceId={workspaceId} boardId={boardId} projectId={projectId} />;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: Login,
});
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InviteAccept,
});

function AuthenticatedShell() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: account, isLoading, isError } = useAccount();

  useEffect(() => {
    if (isLoading || isError) return;
    if (!account) {
      void navigate({ to: '/login' });
    }
  }, [account, isLoading, isError, navigate]);

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg)] text-[var(--muted)]">
        <div className="flex flex-col items-center gap-2">
          <StatusDiamond color="var(--accent)" size={11} className="animate-pulse" />
          <span className="text-xs">{t('router.loadingBurrow')}</span>
        </div>
      </div>
    );
  }

  if (!account || isError) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--bg)] text-[var(--muted)]">
        <span className="text-xs">{t('router.redirectingToSignIn')}</span>
      </div>
    );
  }

  return <AppShell />;
}

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: AuthenticatedShell,
});

const homeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: AccountHome,
});

const workspaceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/w/$workspaceId',
  component: WorkspaceGate,
});
const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
  component: WorkspaceIndex,
});
const projectRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'p/$projectId',
  component: ProjectGate,
});
const projectHomeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/',
  component: ProjectHome,
});
const notepadRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'notepads/$notepadId',
  component: NotepadView,
});
const boardRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'boards/$boardId',
  component: BoardWrapper,
});
const trashRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'trash',
  component: TrashView,
});
const libraryRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: 'library',
  component: () => {
    const { workspaceId, projectId } = libraryRoute.useParams();
    return (
      <ProjectMediaLibrary
        key={`${workspaceId}/${projectId}`}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    );
  },
});
const tasksRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'tasks',
  component: MyTasksView,
});
const settingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings',
  component: SettingsView,
});
const membersRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: 'settings/members',
  component: MembersSettings,
});

const legacyProjectRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/p/$projectId',
  component: () => <LegacyProjectRedirect target="home" />,
});
const legacyNotepadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/p/$projectId/notepads/$notepadId',
  component: () => <LegacyProjectRedirect target="notepad" />,
});
const legacyBoardRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/p/$projectId/boards/$boardId',
  component: () => <LegacyProjectRedirect target="board" />,
});
const legacyTrashRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/p/$projectId/trash',
  component: () => <LegacyProjectRedirect target="trash" />,
});
const legacyTasksRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/my-tasks',
  component: () => <LegacyWorkspaceRedirect target="tasks" />,
});
const legacySettingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  component: () => <LegacyWorkspaceRedirect target="settings" />,
});
const legacyMembersRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings/members',
  component: () => <LegacyWorkspaceRedirect target="members" />,
});

type LegacyWorkspaceTarget = 'tasks' | 'settings' | 'members';
function LegacyWorkspaceRedirect({ target }: { target: LegacyWorkspaceTarget }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: account, isLoading, isError } = useAccount();
  const workspaceId = account?.workspaces.length === 1 ? account.workspaces[0]!.id : null;
  useEffect(() => {
    if (isLoading || isError) return;
    if (!account) {
      void navigate({ to: '/login' });
      return;
    }
    if (!workspaceId) return;
    if (target === 'tasks') void navigate({ to: '/w/$workspaceId/tasks', params: { workspaceId } });
    else if (target === 'members')
      void navigate({ to: '/w/$workspaceId/settings/members', params: { workspaceId } });
    else void navigate({ to: '/w/$workspaceId/settings', params: { workspaceId } });
  }, [account, isLoading, isError, workspaceId, target, navigate]);
  if (isLoading) return <Status>{t('router.resolvingWorkspaceLink')}</Status>;
  if (isError) return <Status>{t('router.couldNotVerifyWorkspaceLink')}</Status>;
  if (!account) return <Status>{t('router.redirectingToSignIn')}</Status>;
  if (!workspaceId) return <Status>{t('router.uniqueWorkspaceRequired')}</Status>;
  return <Status>{t('router.openingWorkspace')}</Status>;
}

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  shellRoute.addChildren([
    homeRoute,
    workspaceRoute.addChildren([
      workspaceIndexRoute,
      projectRoute.addChildren([
        projectHomeRoute,
        notepadRoute,
        boardRoute,
        trashRoute,
        libraryRoute,
      ]),
      tasksRoute,
      settingsRoute,
      membersRoute,
    ]),
    legacyProjectRoute,
    legacyNotepadRoute,
    legacyBoardRoute,
    legacyTrashRoute,
    legacyTasksRoute,
    legacySettingsRoute,
    legacyMembersRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
