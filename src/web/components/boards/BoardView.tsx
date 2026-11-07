import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CalendarDays, Filter, Kanban, List, Plus, Search, Trash2, X } from 'lucide-react';
import {
  useBoard,
  useDeleteBoard,
  useMembers,
  useProjectTags,
  useUpdateBoard,
} from '../../lib/queries';
import { CardPanel } from './CardPanel';
import { KanbanView } from './views/KanbanView';
import { ListView } from './views/ListView';
import { CalendarView } from './views/CalendarView';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Input } from '../ui/Input';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Select } from '../ui/Select';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import type { ColumnItem } from './views/types';
import { projectTarget } from '../../lib/workspaceRoutes';
import { useTranslation } from '../../lib/i18n';

interface BoardViewProps {
  workspaceId: string;
  boardId: string;
  projectId: string;
}

type BoardViewMode = 'kanban' | 'list' | 'calendar';

const VIEW_STORAGE_PREFIX = 'burrow:board-view:';

function readStoredMode(boardId: string): BoardViewMode {
  try {
    const v = localStorage.getItem(VIEW_STORAGE_PREFIX + boardId);
    if (v === 'list' || v === 'calendar' || v === 'kanban') return v;
  } catch {
    // localStorage unavailable (private mode) — fall back to kanban
  }
  return 'kanban';
}

export function BoardView({ workspaceId, boardId, projectId }: BoardViewProps) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: board, isLoading } = useBoard(workspaceId, projectId, boardId);
  const updateBoardMutation = useUpdateBoard();
  const deleteBoardMutation = useDeleteBoard();

  const viewTabs = [
    { mode: 'kanban' as const, label: t('boards.views.kanban'), icon: Kanban },
    { mode: 'list' as const, label: t('boards.views.list'), icon: List },
    { mode: 'calendar' as const, label: t('boards.views.calendar'), icon: CalendarDays },
  ];

  const [selectedCardId, setSelectedCardId] = useState<string | null>(() =>
    new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('cardId'),
  );

  const openCard = (id: string | null) => {
    setSelectedCardId(id);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (id) {
        url.searchParams.set('cardId', id);
      } else {
        url.searchParams.delete('cardId');
      }
      window.history.replaceState(
        null,
        '',
        url.pathname + (url.search ? url.search : '') + url.hash,
      );
    }
  };

  useEffect(() => {
    const handlePopState = () => {
      const search = typeof window !== 'undefined' ? window.location.search : '';
      const cardId = new URLSearchParams(search).get('cardId');
      setSelectedCardId(cardId);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  const [isEditingBoardName, setIsEditingBoardName] = useState(false);
  const [boardName, setBoardName] = useState('');
  const [isAddingColumn, setIsAddingColumn] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  // Board filters
  const [filterSearch, setFilterSearch] = useState('');
  const [filterPriority, setFilterPriority] = useState<string>('all');
  const [filterAssignee, setFilterAssignee] = useState<string>('all');
  const [filterTag, setFilterTag] = useState<string>('all');

  // View switcher, persisted per board (FEATURE_PLAN 2.2)
  const [viewMode, setViewMode] = useState<BoardViewMode>(() => readStoredMode(boardId));
  useEffect(() => {
    setViewMode(readStoredMode(boardId));
    setIsAddingColumn(false);
  }, [boardId]);

  const changeView = (mode: BoardViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_STORAGE_PREFIX + boardId, mode);
    } catch {
      // ignore quota/private-mode errors
    }
  };

  const { data: members = [] } = useMembers(workspaceId);
  const { data: tags = [] } = useProjectTags(workspaceId, projectId);

  const columns = useMemo<ColumnItem[]>(() => board?.columns || [], [board?.columns]);

  const filteredColumns = useMemo(() => {
    return columns.map((col) => ({
      ...col,
      cards: col.cards.filter((card) => {
        if (filterSearch.trim()) {
          const q = filterSearch.toLowerCase();
          if (!card.title.toLowerCase().includes(q)) return false;
        }
        if (filterPriority !== 'all' && card.priority !== filterPriority) {
          return false;
        }
        if (filterAssignee !== 'all') {
          if (!card.assignees.some((a) => a.userId === filterAssignee)) return false;
        }
        if (filterTag !== 'all') {
          if (!card.tags.some((t) => t.id === filterTag)) return false;
        }
        return true;
      }),
    }));
  }, [columns, filterSearch, filterPriority, filterAssignee, filterTag]);

  const isFiltered =
    filterSearch.trim() !== '' ||
    filterPriority !== 'all' ||
    filterAssignee !== 'all' ||
    filterTag !== 'all';

  if (isLoading || !board) {
    return (
      <div className="p-8 flex items-center justify-center text-sm text-[var(--muted)]">
        {t('boards.loadingBoard')}
      </div>
    );
  }

  const handleBoardNameSave = () => {
    if (boardName.trim() && boardName !== board.name) {
      updateBoardMutation.mutate({
        workspaceId,
        projectId,
        boardId,
        name: boardName.trim(),
      });
    }
    setIsEditingBoardName(false);
  };

  const handleDeleteBoard = async () => {
    try {
      await deleteBoardMutation.mutateAsync({ workspaceId, projectId, boardId });
      setConfirmDeleteOpen(false);
      navigate(projectTarget(workspaceId, projectId));
    } catch {
      // The mutation surfaces the failure via a toast and leaves the dialog open.
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0 bg-[var(--bg)] text-[var(--text)]">
      {/* Board Header Bar */}
      <div className="px-3.5 py-2.5 sm:px-6 sm:py-3.5 border-b border-[var(--line)] flex items-center justify-between gap-3 bg-[var(--surface)]">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="text-xl sm:text-2xl shrink-0">{board.icon || '📋'}</span>
          {isEditingBoardName ? (
            <input
              type="text"
              autoFocus
              value={boardName}
              onChange={(e) => setBoardName(e.target.value)}
              onBlur={handleBoardNameSave}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleBoardNameSave();
                if (e.key === 'Escape') setIsEditingBoardName(false);
              }}
              className="text-lg sm:text-xl md:text-2xl bg-transparent border-b-2 border-[var(--accent)] focus:outline-none text-[var(--text)] min-w-0 text-[16px] w-full"
              style={{
                fontFamily: 'Archivo, sans-serif',
                fontVariationSettings: "'wdth' 122, 'wght' 800",
              }}
            />
          ) : (
            <h1
              onClick={() => {
                setBoardName(board.name);
                setIsEditingBoardName(true);
              }}
              className="text-lg sm:text-xl md:text-2xl text-[var(--text)] cursor-pointer hover:opacity-80 truncate tracking-tight font-bold"
              style={{
                fontFamily: 'Archivo, sans-serif',
                fontVariationSettings: "'wdth' 122, 'wght' 800",
                letterSpacing: '-0.02em',
              }}
              title={t('boards.clickToRename')}
            >
              {board.name}
            </h1>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {viewMode === 'kanban' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setIsAddingColumn(true)}
              className="px-2.5 sm:px-3 min-h-[38px] sm:min-h-0"
              title={t('boards.addColumn')}
              aria-label={t('boards.addColumn')}
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('boards.addColumn')}</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmDeleteOpen(true)}
            className="p-1.5 text-[var(--muted)] hover:text-[var(--danger)] cursor-pointer min-h-[38px] sm:min-h-0"
            title={t('sidebar.deleteBoardToTrash')}
            aria-label={t('sidebar.deleteBoardToTrash')}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Mobile View Switcher (Kanban | List | Calendar) */}
      <div className="flex md:hidden items-center justify-between px-3.5 py-1.5 border-b border-[var(--hair)] bg-[var(--surface2)]">
        <SegmentedControl
          value={viewMode}
          onValueChange={(v) => changeView(v as BoardViewMode)}
          ariaLabel="Board view"
          size="sm"
          className="w-full"
          fullWidth
          options={viewTabs.map((tab) => ({
            value: tab.mode,
            label: (
              <span className="flex items-center gap-1.5">
                <tab.icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </span>
            ),
          }))}
        />
      </div>

      {/* Filter Bar + Desktop View Switcher — horizontally scrollable chip track */}
      <div className="border-b border-[var(--line)] bg-[var(--surface2)]">
        <div className="px-3.5 md:px-6 py-2 flex items-center gap-2 md:gap-3 md:flex-wrap text-xs overflow-x-auto no-scrollbar whitespace-nowrap snap-x">
          <div className="flex items-center gap-1.5 text-[var(--muted)] shrink-0">
            <Filter className="w-3.5 h-3.5" />
            <span className="font-semibold uppercase tracking-wider text-[10px]">{t('boards.filterLabel')}</span>
          </div>

          {/* Text Search */}
          <div className="relative flex items-center shrink-0">
            <Search className="w-3 h-3 text-[var(--muted)] absolute left-2 pointer-events-none" />
            <Input
              type="text"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder={t('boards.searchCards')}
              aria-label={t('boards.searchCards')}
              className="pl-7 pr-2 w-28 sm:w-32 focus:w-40 sm:focus:w-44 transition-all text-xs"
            />
          </div>

          {/* Priority Filter */}
          <Select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            aria-label={t('boards.filterByPriority')}
            className="shrink-0 w-auto text-xs"
          >
            <option value="all">{t('boards.allPriorities')}</option>
            <option value="urgent">{t('common.priorities.urgent')}</option>
            <option value="high">{t('common.priorities.high')}</option>
            <option value="medium">{t('common.priorities.medium')}</option>
            <option value="low">{t('common.priorities.low')}</option>
          </Select>

          {/* Assignee Filter */}
          <Select
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            aria-label={t('boards.filterByAssignee')}
            className="shrink-0 w-auto text-xs"
          >
            <option value="all">{t('boards.allAssignees')}</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name || m.email}
              </option>
            ))}
          </Select>

          {/* Tag Filter */}
          <Select
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
            aria-label={t('boards.filterByTag')}
            className="shrink-0 w-auto text-xs"
          >
            <option value="all">{t('boards.allTags')}</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.name}
              </option>
            ))}
          </Select>

          {/* Reset Filter Button */}
          {isFiltered && (
            <Chip
              active
              onClick={() => {
                setFilterSearch('');
                setFilterPriority('all');
                setFilterAssignee('all');
                setFilterTag('all');
              }}
              className="shrink-0 text-xs"
            >
              <X className="w-3 h-3" />
              <span>{t('boards.resetFilters')}</span>
            </Chip>
          )}

          {/* Desktop View Switcher (persisted per board) */}
          <SegmentedControl
            value={viewMode}
            onValueChange={(v) => changeView(v as BoardViewMode)}
            ariaLabel="Board view"
            className="hidden md:flex ml-auto shrink-0"
            options={viewTabs.map((tab) => ({
              value: tab.mode,
              label: (
                <span className="flex items-center gap-1.5">
                  <tab.icon className="w-3.5 h-3.5" />
                  <span>{tab.label}</span>
                </span>
              ),
            }))}
          />
        </div>
      </div>

      {/* Active View */}
      {viewMode === 'kanban' ? (
        <KanbanView
          workspaceId={workspaceId}
          boardId={boardId}
          projectId={projectId}
          columns={columns}
          filteredColumns={filteredColumns}
          isAddingColumn={isAddingColumn}
          setIsAddingColumn={setIsAddingColumn}
          onCardClick={(id) => openCard(id)}
        />
      ) : viewMode === 'list' ? (
        <ListView workspaceId={workspaceId} projectId={projectId} boardId={boardId} columns={filteredColumns} onCardClick={(id) => openCard(id)} />
      ) : (
        <CalendarView
          workspaceId={workspaceId}
          projectId={projectId}
          boardId={boardId}
          columns={filteredColumns}
          onCardClick={(id) => openCard(id)}
        />
      )}

      {/* Selected Card Side Panel */}
      {selectedCardId && (
        <CardPanel
          cardId={selectedCardId}
          workspaceId={workspaceId}
          boardId={boardId}
          projectId={projectId}
          columns={columns.map((c) => ({ id: c.id, name: c.name }))}
          onClose={() => openCard(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={t('sidebar.confirmDeleteBoardTitle')}
        message={t('sidebar.confirmDeleteBoardMessage', { name: board.name })}
        confirmLabel={t('sidebar.deleteBoardToTrash')}
        danger
        busy={deleteBoardMutation.isPending}
        onConfirm={handleDeleteBoard}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
