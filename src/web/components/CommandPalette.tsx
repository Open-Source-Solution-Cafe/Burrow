import { useState, useEffect } from 'react';
import { Command } from 'cmdk';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Home, Kanban, LogOut, Search, Settings, Trash2, Users, Globe } from 'lucide-react';
import { useBoards, useProjects, useRecentNotepads, useSearch, useSignOut } from '../lib/queries';
import {
  boardTarget,
  notepadTarget,
  projectTarget,
  trashTarget,
  workspaceMembersTarget,
  workspaceSettingsTarget,
} from '../lib/workspaceRoutes';
import { ModalShell } from './ui/ModalShell';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { toast } from 'sonner';
import { SegmentedControl } from './ui/SegmentedControl';
import { useTranslation } from '../lib/i18n';

const ITEM_CLASSES =
  'flex flex-col gap-1 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]';

function renderHighlightedSnippet(snippet: string) {
  const parts = snippet.split(/(<mark>[\s\S]*?<\/mark>)/g);
  return parts.map((part, index) => {
    const match = /^<mark>([\s\S]*?)<\/mark>$/i.exec(part);
    if (match) {
      return (
        <mark
          key={index}
          className="bg-[var(--accent)] text-[var(--accent-ink)] font-semibold px-0.5"
        >
          {match[1]}
        </mark>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

export function CommandPalette() {
  const { t, setLocale } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const signOutMutation = useSignOut();

  const navigate = useNavigate();
  const { workspaceId, projectId } = useParams({ strict: false }) as {
    workspaceId?: string;
    projectId?: string;
  };
  const { data: projects = [], isLoading: projectsLoading, isError: projectsError } =
    useProjects(workspaceId);
  const activeProject =
    projectId === undefined ? projects[0] : projects.find((p) => p.id === projectId);
  const currentProjectId = activeProject?.id;

  const { data: recentNotepads = [] } = useRecentNotepads(workspaceId, currentProjectId);
  const { data: boards = [] } = useBoards(workspaceId, currentProjectId);
  const { data: searchResults = [], isLoading: isSearching } = useSearch(
    scope === 'project' && !currentProjectId ? '' : query,
    workspaceId,
    scope === 'project' ? currentProjectId : undefined,
    scope,
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };

    const handleCustomOpen = (e: Event) => {
      const customQuery = (e as CustomEvent)?.detail?.query;
      if (typeof customQuery === 'string') {
        setQuery(customQuery);
      }
      setOpen(true);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('burrow:open-palette', handleCustomOpen);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('burrow:open-palette', handleCustomOpen);
    };
  }, []);

  const handleSelect = (run: () => void) => {
    run();
    setOpen(false);
    setQuery('');
  };

  if (!open && !confirmSignOut) return null;

  return (
    <>
      {open && (
        <ModalShell
          open={open}
          onClose={() => setOpen(false)}
          title={t('commandPalette.title')}
          className="w-full self-start mt-[8dvh] sm:max-w-xl"
        >
          <Command
            className="w-full flex flex-col"
            shouldFilter={false} // We handle search via FTS API
          >
            {/* Header & Search Input */}
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--hair)]">
              <Search className="w-4 h-4 text-[var(--muted)] shrink-0" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder={t('commandPalette.searchPlaceholder')}
                className="flex-1 bg-transparent text-base sm:text-sm text-[var(--text)] placeholder:text-[var(--muted)] outline-none"
                autoFocus
              />
              {/* Scope Toggle — geometric segmented control */}
              <SegmentedControl
                value={scope}
                onValueChange={(v) => setScope(v as 'project' | 'all')}
                options={[
                  { value: 'project', label: t('commandPalette.scopeProject') },
                  { value: 'all', label: t('commandPalette.scopeAll') },
                ]}
                size="sm"
              />
            </div>

            {/* Results List */}
            <Command.List className="max-h-80 overflow-y-auto p-2 space-y-1">
              {scope === 'project' && !currentProjectId && (
                <div className="p-4 text-center text-xs text-[var(--muted)]" role="status">
                  {projectsLoading
                    ? t('commandPalette.loadingProject')
                    : projectsError
                      ? t('commandPalette.unableToLoadProjects')
                      : projectId !== undefined
                        ? t('commandPalette.projectNotFound')
                        : t('commandPalette.selectProjectToSearch')}
                </div>
              )}
              {isSearching && (
                <div className="p-4 text-center text-xs text-[var(--muted)]">{t('commandPalette.searching')}</div>
              )}

              {query.trim().length > 0 &&
                (scope === 'all' || currentProjectId) &&
                !isSearching &&
                searchResults.length === 0 && (
                  <Command.Empty className="p-6 text-center text-xs text-[var(--muted)]">
                    {t('commandPalette.noResultsFound', { query })}
                  </Command.Empty>
                )}

              {/* FTS Search Results */}
              {query.trim().length > 0 && searchResults.length > 0 && (
                <Command.Group
                  heading={t('commandPalette.searchResults')}
                  className="text-[11px] font-semibold text-[var(--muted)] px-2 py-1 uppercase tracking-wider"
                >
                  {searchResults.map((item) => (
                    <Command.Item
                      key={item.id}
                      onSelect={() =>
                        handleSelect(() => {
                          if (item.kind === 'notepad') {
                            if (!workspaceId) return;
                            navigate(notepadTarget(workspaceId, item.projectId, item.id));
                          } else {
                            // card: navigate to its board if available, else its project
                            const cardItem = item as typeof item & {
                              boardId?: string;
                              cardId?: string;
                            };
                            if (cardItem.boardId) {
                              if (!workspaceId) return;
                              navigate({
                                ...boardTarget(workspaceId, item.projectId, cardItem.boardId),
                                search: { cardId: cardItem.cardId ?? item.id } as any,
                              });
                            } else {
                              if (!workspaceId) return;
                              navigate(projectTarget(workspaceId, item.projectId));
                            }
                          }
                        })
                      }
                      className={ITEM_CLASSES}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm shrink-0">
                          {item.icon || (item.kind === 'notepad' ? '📄' : '📋')}
                        </span>
                        <span className="font-semibold truncate">{item.title || t('common.untitled')}</span>
                        <span className="text-[10px] px-1.5 py-0.5 bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] ml-auto shrink-0">
                          {item.projectName}
                        </span>
                      </div>
                      {item.snippet && (
                        <div className="text-[11px] text-[var(--muted)] pl-6 line-clamp-1">
                          {renderHighlightedSnippet(item.snippet)}
                        </div>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}

              {/* Quick Navigation and Recent (shown when search query is empty) */}
              {query.trim().length === 0 && (
                <>
                  {recentNotepads.length > 0 && (
                    <Command.Group
                      heading={t('commandPalette.recentNotepads')}
                      className="text-[11px] font-semibold text-[var(--muted)] px-2 py-1 uppercase tracking-wider"
                    >
                      {recentNotepads.slice(0, 4).map((np) => (
                        <Command.Item
                          key={np.id}
                          onSelect={() =>
                            handleSelect(() => {
                              if (!workspaceId || !currentProjectId) return;
                              navigate(notepadTarget(workspaceId, currentProjectId, np.id));
                            })
                          }
                          className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                        >
                          <span className="text-sm shrink-0">{np.icon || '📄'}</span>
                          <span className="font-medium truncate">{np.title || t('common.untitled')}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  <Command.Group
                    heading={t('commandPalette.navigation')}
                    className="text-[11px] font-semibold text-[var(--muted)] px-2 py-1 uppercase tracking-wider mt-2"
                  >
                    {currentProjectId && (
                      <Command.Item
                        onSelect={() =>
                          handleSelect(() => {
                            if (workspaceId) navigate(projectTarget(workspaceId, currentProjectId));
                          })
                        }
                        className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                      >
                        <Home className="w-4 h-4 text-purple-500 shrink-0" />
                        <span>{t('commandPalette.projectOverview')}</span>
                      </Command.Item>
                    )}

                    {boards.map((b) => (
                      <Command.Item
                        key={b.id}
                        onSelect={() =>
                          handleSelect(() => {
                            if (!workspaceId || !currentProjectId) return;
                            navigate(boardTarget(workspaceId, currentProjectId, b.id));
                          })
                        }
                        className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                      >
                        <Kanban className="w-4 h-4 text-emerald-500 shrink-0" />
                        <span>{t('commandPalette.boardPrefix', { name: b.name })}</span>
                      </Command.Item>
                    ))}

                    {currentProjectId && (
                      <Command.Item
                        onSelect={() =>
                          handleSelect(() => {
                            if (workspaceId) navigate(trashTarget(workspaceId, currentProjectId));
                          })
                        }
                        className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                      >
                        <Trash2 className="w-4 h-4 text-rose-500 shrink-0" />
                        <span>{t('commandPalette.trash')}</span>
                      </Command.Item>
                    )}

                    <Command.Item
                      onSelect={() =>
                        handleSelect(() => {
                          if (workspaceId) navigate(workspaceMembersTarget(workspaceId));
                        })
                      }
                      className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                    >
                      <Users className="w-4 h-4 text-blue-500 shrink-0" />
                      <span>{t('commandPalette.membersAndInvites')}</span>
                    </Command.Item>

                    <Command.Item
                      onSelect={() =>
                        handleSelect(() => {
                          if (workspaceId) navigate(workspaceSettingsTarget(workspaceId));
                        })
                      }
                      className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                    >
                      <Settings className="w-4 h-4 text-[var(--muted)] shrink-0" />
                      <span>{t('commandPalette.settings')}</span>
                    </Command.Item>

                    <Command.Item
                      onSelect={() =>
                        handleSelect(() => {
                          setConfirmSignOut(true);
                        })
                      }
                      className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-red-500 cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                    >
                      <LogOut className="w-4 h-4 text-red-500 shrink-0" />
                      <span>{t('commandPalette.logOut')}</span>
                    </Command.Item>
                  </Command.Group>

                  <Command.Group
                    heading={t('common.language')}
                    className="text-[11px] font-semibold text-[var(--muted)] px-2 py-1 uppercase tracking-wider mt-2"
                  >
                    <Command.Item
                      onSelect={() =>
                        handleSelect(() => {
                          setLocale('en');
                          toast.success('Language: English');
                        })
                      }
                      className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                    >
                      <Globe className="w-4 h-4 text-cyan-500 shrink-0" />
                      <span>English (EN)</span>
                    </Command.Item>
                    <Command.Item
                      onSelect={() =>
                        handleSelect(() => {
                          setLocale('es');
                          toast.success('Idioma: Español');
                        })
                      }
                      className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                    >
                      <Globe className="w-4 h-4 text-cyan-500 shrink-0" />
                      <span>Español (ES)</span>
                    </Command.Item>
                    <Command.Item
                      onSelect={() =>
                        handleSelect(() => {
                          setLocale('fr');
                          toast.success('Langue : Français');
                        })
                      }
                      className="flex items-center gap-2.5 px-3 py-2 min-h-0 text-xs text-[var(--text)] cursor-pointer select-none border border-transparent data-[selected=true]:bg-[var(--surface2)] data-[selected=true]:border-[var(--accent)]"
                    >
                      <Globe className="w-4 h-4 text-cyan-500 shrink-0" />
                      <span>Français (FR)</span>
                    </Command.Item>
                  </Command.Group>
                </>
              )}
            </Command.List>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-[var(--hair)] flex items-center justify-between text-[11px] text-[var(--muted)]">
              <div>
                {t('commandPalette.footerUse')}{' '}
                <kbd className="px-1 py-0.5 bg-[var(--surface2)] border border-[var(--line)]">
                  ↑
                </kbd>{' '}
                <kbd className="px-1 py-0.5 bg-[var(--surface2)] border border-[var(--line)]">
                  ↓
                </kbd>{' '}
                {t('commandPalette.footerNavigate')},{' '}
                <kbd className="px-1 py-0.5 bg-[var(--surface2)] border border-[var(--line)]">
                  ↵
                </kbd>{' '}
                {t('commandPalette.footerSelect')}
              </div>
              <div className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-[var(--surface2)] border border-[var(--line)] font-mono">
                  ESC
                </kbd>{' '}
                {t('commandPalette.footerClose')}
              </div>
            </div>
          </Command>
        </ModalShell>
      )}

      <ConfirmDialog
        open={confirmSignOut}
        title={t('sidebar.confirmSignOutTitle')}
        message={t('sidebar.confirmSignOutMessage')}
        confirmLabel={t('common.signOut')}
        danger={false}
        busy={signOutMutation.isPending}
        onConfirm={async () => {
          try {
            await signOutMutation.mutateAsync();
          } catch (err: any) {
            toast.error(err?.message || 'Failed to sign out');
            setConfirmSignOut(false);
          }
        }}
        onCancel={() => setConfirmSignOut(false)}
      />
    </>
  );
}
