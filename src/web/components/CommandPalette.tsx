import { useState, useEffect } from 'react';
import { Command } from 'cmdk';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Home, Kanban, LogOut, Search, Settings, Trash2, Users } from 'lucide-react';
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
          title="Search and commands"
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
                placeholder="Search notepads, cards, or type a command…"
                className="flex-1 bg-transparent text-base sm:text-sm text-[var(--text)] placeholder:text-[var(--muted)] outline-none"
                autoFocus
              />
              {/* Scope Toggle — geometric segmented control */}
              <SegmentedControl
                value={scope}
                onValueChange={(v) => setScope(v as 'project' | 'all')}
                options={[
                  { value: 'project', label: 'Project' },
                  { value: 'all', label: 'All' },
                ]}
                size="sm"
              />
            </div>

            {/* Results List */}
            <Command.List className="max-h-80 overflow-y-auto p-2 space-y-1">
              {scope === 'project' && !currentProjectId && (
                <div className="p-4 text-center text-xs text-[var(--muted)]" role="status">
                  {projectsLoading
                    ? 'Loading project…'
                    : projectsError
                      ? 'Unable to load projects. Please try again.'
                      : projectId !== undefined
                        ? 'Project not found or no longer available. Select a project from the sidebar.'
                        : 'Select a project to search within it.'}
                </div>
              )}
              {isSearching && (
                <div className="p-4 text-center text-xs text-[var(--muted)]">Searching…</div>
              )}

              {query.trim().length > 0 &&
                (scope === 'all' || currentProjectId) &&
                !isSearching &&
                searchResults.length === 0 && (
                  <Command.Empty className="p-6 text-center text-xs text-[var(--muted)]">
                    No matching results found for "{query}".
                  </Command.Empty>
                )}

              {/* FTS Search Results */}
              {query.trim().length > 0 && searchResults.length > 0 && (
                <Command.Group
                  heading="Search Results"
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
                        <span className="font-semibold truncate">{item.title || 'Untitled'}</span>
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
                      heading="Recent Notepads"
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
                          <span className="font-medium truncate">{np.title || 'Untitled'}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}

                  <Command.Group
                    heading="Navigation"
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
                        <span>Project Overview</span>
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
                        <span>Board: {b.name}</span>
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
                        <span>Trash</span>
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
                      <span>Members & Invites</span>
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
                      <span>Settings</span>
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
                      <span>Log out</span>
                    </Command.Item>
                  </Command.Group>
                </>
              )}
            </Command.List>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-[var(--hair)] flex items-center justify-between text-[11px] text-[var(--muted)]">
              <div>
                Use{' '}
                <kbd className="px-1 py-0.5 bg-[var(--surface2)] border border-[var(--line)]">
                  ↑
                </kbd>{' '}
                <kbd className="px-1 py-0.5 bg-[var(--surface2)] border border-[var(--line)]">
                  ↓
                </kbd>{' '}
                to navigate,{' '}
                <kbd className="px-1 py-0.5 bg-[var(--surface2)] border border-[var(--line)]">
                  ↵
                </kbd>{' '}
                to select
              </div>
              <div className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 bg-[var(--surface2)] border border-[var(--line)] font-mono">
                  ESC
                </kbd>{' '}
                to close
              </div>
            </div>
          </Command>
        </ModalShell>
      )}

      <ConfirmDialog
        open={confirmSignOut}
        title="Log out"
        message="Are you sure you want to log out of your account?"
        confirmLabel="Log out"
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
