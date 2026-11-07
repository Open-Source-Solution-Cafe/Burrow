import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Layout, Search } from 'lucide-react';
import { useBoards, useCreateCard } from '../lib/queries';
import { ModalShell } from '../components/ui/ModalShell';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { projectApiPath } from '../lib/workspaceRoutes';
import { useTranslation } from '../lib/i18n';

interface NotepadPickerModalProps {
  workspaceId: string;
  projectId: string;
  onClose: () => void;
  onSelectNotepad: (notepadId: string) => void;
}

export function NotepadPickerModal({
  workspaceId,
  projectId,
  onClose,
  onSelectNotepad,
}: NotepadPickerModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'new' | 'existing'>('new');
  const [newTitle, setNewTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; label: string }>>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleCreateNew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(projectApiPath(workspaceId, projectId, 'notepads'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
          message?: string;
        };
        throw new Error(err.error?.message || err.message || 'Failed to create notepad');
      }
      const data = (await res.json()) as { id: string };
      queryClient.invalidateQueries({ queryKey: ['notepads', workspaceId, projectId] });
      onSelectNotepad(data.id);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create notepad');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/suggest?type=notepad&projectId=${encodeURIComponent(projectId)}&q=${encodeURIComponent(q.trim())}`,
      );
      if (!res.ok) {
        throw new Error('Failed to search notepads');
      }
      const data = (await res.json()) as Array<{ id: string; label: string }>;
      setResults(data);
    } catch (err: any) {
      console.error(err);
      toast.error(err?.message || 'Failed to search notepads');
    }
  };

  return (
    <ModalShell open onClose={onClose} title={t('editor.linkNotepad')} className="sm:max-w-md">
      {/* Tab Switcher — geometric segmented control */}
      <div className="m-4">
        <SegmentedControl
          value={tab}
          onValueChange={(v) => setTab(v as 'new' | 'existing')}
          options={[
            { value: 'new', label: t('editor.createNew') },
            { value: 'existing', label: t('editor.existingNotepad') },
          ]}
          fullWidth
        />
      </div>

      {/* Tab Body */}
      <div className="pt-3">
        {tab === 'new' ? (
          <form onSubmit={handleCreateNew} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[var(--muted)] mb-1">
                {t('editor.notepadTitle')}
              </label>
              <Input
                type="text"
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder={t('editor.notepadTitlePlaceholder')}
                className="w-full p-2.5 text-base sm:text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                className="px-3 py-1.5 text-xs min-h-[44px] sm:min-h-0"
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!newTitle.trim() || isSubmitting}
                className="px-3 py-1.5 text-xs font-semibold min-h-[44px] sm:min-h-0"
              >
                {isSubmitting ? t('common.saving') : t('editor.createAndLink')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[var(--muted)] absolute left-3 top-3" />
              <Input
                type="text"
                autoFocus
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder={t('editor.searchNotepadsPlaceholder')}
                className="w-full pl-9 pr-3 py-2 text-base sm:text-xs"
              />
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {results.length === 0 ? (
                <div className="p-4 text-center text-xs text-[var(--muted)] italic">
                  {searchQuery ? t('editor.noMatchingNotepads') : t('editor.typeToSearch')}
                </div>
              ) : (
                results.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => {
                      onSelectNotepad(r.id);
                      onClose();
                    }}
                    className="w-full p-2 min-h-[44px] sm:min-h-0 text-left text-xs text-[var(--text)] hover:bg-[var(--hi)] flex items-center gap-2 transition"
                  >
                    <FileText className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                    <span className="truncate">{r.label || t('editor.untitled')}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

interface TaskPickerModalProps {
  workspaceId: string;
  projectId: string;
  onClose: () => void;
  onCardCreated: (cardId: string) => void;
}

export function TaskPickerModal({ workspaceId, projectId, onClose, onCardCreated }: TaskPickerModalProps) {
  const { t } = useTranslation();
  const { data: boards = [] } = useBoards(workspaceId, projectId);
  const createCardMutation = useCreateCard();

  const [selectedBoardId, setSelectedBoardId] = useState(boards[0]?.id || '');
  const [selectedColId, setSelectedColId] = useState('');
  const [title, setTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [columns, setColumns] = useState<Array<{ id: string; name: string }>>([]);

  // Load columns for the initially selected board on mount / when boards are loaded
  useEffect(() => {
    if (boards.length > 0 && !selectedBoardId) {
      setSelectedBoardId(boards[0]?.id || '');
    }
  }, [boards, selectedBoardId]);

  useEffect(() => {
    if (!selectedBoardId) return;
    let cancelled = false;
    fetch(projectApiPath(workspaceId, projectId, `boards/${selectedBoardId}`))
      .then((res) => (res.ok ? res.json() : null))
      .then((board: { columns?: Array<{ id: string; name: string }> } | null) => {
        if (cancelled || !board) return;
        const cols = board.columns || [];
        setColumns(cols);
        setSelectedColId((prev) => {
          if (cols.some((c) => c.id === prev)) return prev;
          return cols[0]?.id || '';
        });
      })
      .catch((err) => toast.error(err?.message || 'Failed to load board columns'));

    return () => {
      cancelled = true;
    };
  }, [selectedBoardId, workspaceId, projectId]);

  const handleBoardChange = (bId: string) => {
    setSelectedBoardId(bId);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !selectedColId || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await createCardMutation.mutateAsync({
        workspaceId,
        projectId,
        boardId: selectedBoardId,
        columnId: selectedColId,
        title: title.trim(),
      });
      onCardCreated(res.cardId);
      onClose();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create card');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalShell open onClose={onClose} title={t('editor.createAndLinkTaskCard')} className="sm:max-w-md">
      <form onSubmit={handleSubmit} className="pt-3 space-y-4">
        <div>
          <label className="block text-xs font-medium text-[var(--muted)] mb-1">{t('editor.selectBoard')}</label>
          <Select
            value={selectedBoardId}
            onChange={(e) => handleBoardChange(e.target.value)}
            className="w-full p-2 text-base sm:text-xs min-h-[44px] sm:min-h-0"
          >
            <option value="" disabled>
              {t('editor.selectBoardPlaceholder')}
            </option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <label className="block text-xs font-medium text-[var(--muted)] mb-1">{t('editor.column')}</label>
          <Select
            value={selectedColId}
            onChange={(e) => setSelectedColId(e.target.value)}
            className="w-full p-2 text-base sm:text-xs min-h-[44px] sm:min-h-0"
          >
            {columns.length === 0 ? (
              <option value="">{t('editor.selectBoardFirst')}</option>
            ) : (
              columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))
            )}
          </Select>
        </div>

        <div>
          <label className="block text-xs font-medium text-[var(--muted)] mb-1">{t('editor.taskTitle')}</label>
          <Input
            type="text"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('editor.taskTitlePlaceholder')}
            className="w-full p-2.5 text-base sm:text-xs"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--hair)]">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            className="px-3 py-1.5 text-xs min-h-[44px] sm:min-h-0"
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!selectedColId || !title.trim() || isSubmitting}
            className="px-3 py-1.5 text-xs font-semibold min-h-[44px] sm:min-h-0"
          >
            {isSubmitting ? t('common.saving') : t('editor.createAndInsertLink')}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

interface BoardPickerModalProps {
  workspaceId: string;
  projectId: string;
  onClose: () => void;
  onSelectBoard: (boardId: string) => void;
}

export function BoardPickerModal({ workspaceId, projectId, onClose, onSelectBoard }: BoardPickerModalProps) {
  const { t } = useTranslation();
  const { data: boards = [], isLoading } = useBoards(workspaceId, projectId);

  return (
    <ModalShell open onClose={onClose} title={t('editor.linkBoard')} className="sm:max-w-md">
      <div className="pt-3 space-y-2">
        {isLoading ? (
          <div className="p-4 text-center text-xs text-[var(--muted)]">{t('editor.loadingBoards')}</div>
        ) : boards.length === 0 ? (
          <div className="p-4 text-center text-xs text-[var(--muted)] italic">
            {t('editor.noBoardsFound')}
          </div>
        ) : (
          <div className="max-h-60 overflow-y-auto space-y-1">
            {boards.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  onSelectBoard(b.id);
                  onClose();
                }}
                className="w-full p-2.5 min-h-[44px] sm:min-h-0 text-left text-xs text-[var(--text)] hover:bg-[var(--hi)] flex items-center gap-2.5 transition border border-[var(--line)]"
              >
                <Layout className="w-4 h-4 text-blue-500 shrink-0" />
                <span className="font-medium truncate">{b.name}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end pt-2 border-t border-[var(--hair)]">
          <Button type="button" variant="ghost" onClick={onClose} className="px-3 py-1.5 text-xs">
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
