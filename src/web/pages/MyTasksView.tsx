import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { toast } from 'sonner';
import { AlarmClock, Calendar, CheckCircle2, Circle, Inbox, ListTodo } from 'lucide-react';
import {
  useBoard,
  useMoveCard,
  useMyTasks,
  useProjects,
  useUpdateCard,
  type MyTaskItem,
} from '../lib/queries';
import { CardPanel } from '../components/boards/CardPanel';
import { projectApiPath } from '../lib/workspaceRoutes';
import { Badge } from '../components/ui/Badge';
import { Select } from '../components/ui/Select';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { StatusDiamond } from '../components/ui/StatusDiamond';
import { useTranslation } from '../lib/i18n';

type StatusFilter = 'all' | 'open' | 'completed';

// Basalt Layer-4 priority adapter: angular token classes. Export shape preserved.
const PRIORITY_BADGES: Record<string, { label: string; class: string }> = {
  low: { label: 'Low', class: 'border-l-[var(--c4)]' },
  medium: { label: 'Medium', class: 'border-l-[var(--c3)]' },
  high: { label: 'High', class: 'border-l-[var(--c2)]' },
  urgent: { label: 'Urgent', class: 'border-l-[var(--danger)]' },
};

const PRIORITY_DIAMONDS: Record<string, string> = {
  low: 'var(--c4)',
  medium: 'var(--c3)',
  high: 'var(--c2)',
  urgent: 'var(--danger)',
};

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function TaskRow({
  task,
  onOpen,
  onComplete,
  onSnooze,
  t,
  formatDate,
}: {
  task: MyTaskItem;
  onOpen: () => void;
  onComplete: () => void;
  onSnooze: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatDate: (value: number | Date, options?: Intl.DateTimeFormatOptions) => string;
}) {
  const overdue = !task.isCompleted && task.dueDate !== null && task.dueDate < startOfToday();
  const priority = task.priority ? PRIORITY_BADGES[task.priority] : undefined;
  const diamond = task.priority ? PRIORITY_DIAMONDS[task.priority] : undefined;
  const priorityLabel = task.priority
    ? (t(`common.priorities.${task.priority}` as any) || priority?.label)
    : undefined;
  const hasFooter = Boolean(priority || task.dueDate !== null || !task.isCompleted);

  return (
    <div
      className={`group flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-3 p-3 sm:py-2.5 bg-[var(--surface)] border border-[var(--line)] hover:bg-[var(--hi)] transition ${
        priority ? `border-l-4 ${priority.class}` : ''
      }`}
    >
      {/* Top / Left zone: Complete checkbox + Title + meta */}
      <div className="flex items-start sm:items-center gap-0 sm:gap-3 flex-1 min-w-0">
        <button
          type="button"
          onClick={onComplete}
          title={task.isCompleted ? t('tasks.markAsOpen') : t('tasks.markAsComplete')}
          aria-label={task.isCompleted ? t('tasks.markAsOpen') : t('tasks.markAsComplete')}
          className={`shrink-0 min-w-[44px] min-h-[44px] -ml-2 -mt-2.5 sm:m-0 sm:min-w-0 sm:min-h-0 flex items-center justify-center transition cursor-pointer ${
            task.isCompleted
              ? 'text-[var(--c4)] hover:brightness-110'
              : 'text-[var(--muted)] hover:text-[var(--c4)]'
          }`}
        >
          {task.isCompleted ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
        </button>

        <button
          type="button"
          onClick={onOpen}
          className="flex-1 min-w-0 text-left cursor-pointer"
        >
          <div
            className={`text-sm font-semibold sm:font-medium leading-snug line-clamp-2 sm:truncate ${
              task.isCompleted ? 'text-[var(--muted)] line-through' : 'text-[var(--text)]'
            }`}
          >
            {task.title || t('common.untitled')}
          </div>
          <div className="mt-1.5 sm:mt-1 flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-1.5 text-[11px] text-[var(--muted)]">
            <div className="flex items-center flex-wrap gap-x-2 sm:gap-x-1.5 gap-y-1 min-w-0">
              <Badge className="max-w-full">
                <span className="shrink-0">{task.projectIcon || '📁'}</span>
                <span className="truncate max-w-[200px] sm:max-w-[140px]">{task.projectName}</span>
              </Badge>
              <span className="hidden sm:inline text-[var(--muted)]" aria-hidden="true">
                ·
              </span>
              <span className="truncate max-w-full sm:max-w-[160px]">
                {task.boardName} / {task.columnName}
              </span>
            </div>
            {task.tags.length > 0 && (
              <div className="flex items-center flex-wrap gap-1.5">
                {task.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="px-1.5 py-0.5 font-medium border-l-2 max-w-[180px] truncate"
                    style={{
                      borderLeftColor: tag.color || '#64748b',
                      backgroundColor: 'var(--surface2)',
                    }}
                  >
                    #{tag.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </button>
      </div>

      {/* Bottom (mobile) / Right (desktop): priority, due date, snooze */}
      {hasFooter && (
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-[var(--hair)] sm:border-0 sm:pt-0 sm:justify-end sm:shrink-0">
          {(priority || task.dueDate !== null) && (
            <div className="flex items-center flex-wrap gap-2 min-w-0">
              {priority && (
                <Badge className={priority.class}>
                  <StatusDiamond color={diamond ?? 'var(--c1)'} size={6} />
                  {priorityLabel}
                </Badge>
              )}

              {task.dueDate !== null && (
                <span
                  className={`inline-flex items-center gap-1 text-[11px] font-medium whitespace-nowrap ${
                    overdue ? 'text-[var(--danger)]' : 'text-[var(--muted)]'
                  }`}
                >
                  <Calendar className="w-3 h-3 shrink-0" />
                  {formatDate(task.dueDate, { month: 'short', day: 'numeric' })}
                </span>
              )}
            </div>
          )}

          {!task.isCompleted && (
            <button
              type="button"
              onClick={onSnooze}
              title={t('tasks.snoozeTomorrow')}
              aria-label={t('tasks.snoozeTomorrow')}
              className="ml-auto sm:ml-0 shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 sm:p-1 min-h-[32px] sm:min-h-0 sm:min-w-0 text-[11px] font-medium text-[var(--muted)] hover:text-[var(--c2)] bg-[var(--surface2)] sm:bg-transparent border border-[var(--line)] sm:border-0 hover:bg-[var(--hi)] sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 transition cursor-pointer"
            >
              <AlarmClock className="w-3.5 h-3.5 shrink-0" />
              <span className="sm:hidden">{t('tasks.snooze')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TaskGroup({
  icon,
  title,
  tone,
  tasks,
  onSelect,
  onComplete,
  onSnooze,
  t,
  formatDate,
}: {
  icon: React.ReactNode;
  title: string;
  tone: string;
  tasks: MyTaskItem[];
  onSelect: (task: MyTaskItem) => void;
  onComplete: (task: MyTaskItem) => void;
  onSnooze: (task: MyTaskItem) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  formatDate: (value: number | Date, options?: Intl.DateTimeFormatOptions) => string;
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="space-y-2 sm:space-y-1.5">
      <div className="flex items-center gap-2 pt-0.5">
        <span className={tone}>{icon}</span>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
          {title}
        </h2>
        <Badge>{tasks.length}</Badge>
      </div>
      <div className="space-y-2 sm:space-y-1.5">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onOpen={() => onSelect(task)}
            onComplete={() => onComplete(task)}
            onSnooze={() => onSnooze(task)}
            t={t}
            formatDate={formatDate}
          />
        ))}
      </div>
    </section>
  );
}

export function MyTasksView() {
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  const { t, formatDate } = useTranslation();
  const [status, setStatus] = useState<StatusFilter>('open');
  const [projectId, setProjectId] = useState<string>('all');
  const [selected, setSelected] = useState<MyTaskItem | null>(null);

  const { data: tasks = [], isLoading } = useMyTasks({
    status,
    projectId: projectId === 'all' ? undefined : projectId,
  }, workspaceId);
  const { data: projects = [] } = useProjects(workspaceId);
  const moveCardMutation = useMoveCard();
  const updateCardMutation = useUpdateCard();
  const queryClient = useQueryClient();

  // Columns for the open CardPanel (needed for the status dropdown).
  const { data: openBoard } = useBoard(workspaceId, selected?.projectId, selected?.boardId);
  const panelColumns = useMemo(
    () => (openBoard?.columns || []).map((c: any) => ({ id: c.id, name: c.name })),
    [openBoard],
  );

  const groups = useMemo(() => {
    const todayStart = startOfToday();
    const todayEnd = todayStart + 86_400_000;
    const weekEnd = todayStart + 7 * 86_400_000;

    const overdue: MyTaskItem[] = [];
    const today: MyTaskItem[] = [];
    const upcoming: MyTaskItem[] = [];
    const later: MyTaskItem[] = [];
    const completed: MyTaskItem[] = [];

    for (const task of tasks) {
      if (task.isCompleted) {
        completed.push(task);
        continue;
      }
      if (task.dueDate === null) {
        later.push(task);
      } else if (task.dueDate < todayStart) {
        overdue.push(task);
      } else if (task.dueDate < todayEnd) {
        today.push(task);
      } else if (task.dueDate < weekEnd) {
        upcoming.push(task);
      } else {
        later.push(task);
      }
    }

    const byDue = (a: MyTaskItem, b: MyTaskItem) =>
      (a.dueDate ?? Number.MAX_SAFE_INTEGER) - (b.dueDate ?? Number.MAX_SAFE_INTEGER);
    overdue.sort(byDue);
    today.sort(byDue);
    upcoming.sort(byDue);
    completed.sort((a, b) => b.createdAt - a.createdAt);

    return { overdue, today, upcoming, later, completed };
  }, [tasks]);

  const handleComplete = async (task: MyTaskItem) => {
    if (task.isCompleted) {
      // Re-open: move back to the first non-done column on its board.
      try {
        if (!workspaceId) throw new Error('Workspace is unavailable');
        const res = await fetch(projectApiPath(workspaceId, task.projectId, `boards/${task.boardId}`));
        if (!res.ok) throw new Error('Failed to load board details');
        const board = (await res.json()) as { columns: Array<{ id: string; name: string }> };
        const openCol = board.columns.find((c) => !/done|completed|closed|shipped/i.test(c.name));
        if (!openCol) {
          toast.error(t('common.error'));
          return;
        }
        await moveCardMutation.mutateAsync({
          workspaceId,
          projectId: task.projectId,
          cardId: task.id,
          boardId: task.boardId,
          columnId: openCol.id,
        });
        queryClient.invalidateQueries({ queryKey: ['my-tasks'] });
        toast.success(t('tasks.taskReopened'));
      } catch (err: any) {
        toast.error(err?.message || t('common.error'));
      }
      return;
    }

    // Complete: move into the board's Done/Completed column.
    try {
      if (!workspaceId) throw new Error('Workspace is unavailable');
      const res = await fetch(projectApiPath(workspaceId, task.projectId, `boards/${task.boardId}`));
      if (!res.ok) throw new Error('Failed to load board details');
      const board = (await res.json()) as { columns: Array<{ id: string; name: string }> };
      const doneCol = board.columns.find((c) => /done|completed|closed|shipped/i.test(c.name));
      if (!doneCol) {
        toast.error(`"${task.boardName}" has no Done/Completed column to move this card into.`);
        return;
      }
      await moveCardMutation.mutateAsync({
        workspaceId,
        projectId: task.projectId,
        cardId: task.id,
        boardId: task.boardId,
        columnId: doneCol.id,
      });
      queryClient.invalidateQueries({ queryKey: ['my-tasks'] });
      toast.success(t('tasks.taskMarkedComplete'));
    } catch (err: any) {
      toast.error(err?.message || t('common.error'));
    }
  };

  const handleSnooze = async (task: MyTaskItem) => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    try {
      await updateCardMutation.mutateAsync({
        workspaceId: workspaceId!,
        projectId: task.projectId,
        cardId: task.id,
        boardId: task.boardId,
        dueDate: tomorrow.getTime(),
      });
      queryClient.invalidateQueries({ queryKey: ['my-tasks'] });
      toast.success(t('tasks.snoozedSuccess'));
    } catch (err: any) {
      toast.error(err?.message || t('common.error'));
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)]">
      <div className="max-w-4xl mx-auto px-3.5 py-4 sm:px-6 sm:py-8 space-y-4">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 pb-3 sm:pb-4 border-b border-[var(--hair)]">
          <div className="flex items-center gap-2.5">
            <Inbox className="w-5 h-5 sm:w-6 sm:h-6 text-[var(--accent)] shrink-0" />
            <h1 className="text-xl sm:text-2xl font-bold text-[var(--text)]">{t('tasks.title')}</h1>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
            {/* Status tabs — geometric segmented control */}
            <SegmentedControl
              fullWidth
              className="w-full sm:w-auto"
              value={status}
              onValueChange={(v) => setStatus(v as StatusFilter)}
              options={[
                { value: 'open', label: t('tasks.open') },
                { value: 'completed', label: t('tasks.completed') },
                { value: 'all', label: t('tasks.all') },
              ]}
            />

            {/* Project filter */}
            <Select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              aria-label={t('tasks.allProjects')}
              className="w-full sm:w-auto h-9 sm:h-8"
            >
              <option value="all">{t('tasks.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.icon || '📁'} {p.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {/* Grouped task sections */}
        {isLoading ? (
          <div className="py-16 text-center text-sm text-[var(--muted)]">{t('tasks.loadingTasks')}</div>
        ) : tasks.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-2 text-[var(--muted)]">
            <ListTodo className="w-8 h-8" />
            <p className="text-sm">
              {status === 'completed'
                ? t('tasks.noCompletedTasks')
                : t('tasks.noTasksAssigned')}
            </p>
          </div>
        ) : (
          <div className="space-y-5 sm:space-y-4">
            {[
              {
                key: 'overdue',
                icon: <AlarmClock className="w-4 h-4" />,
                title: t('tasks.overdue'),
                tone: 'text-[var(--danger)]',
                items: groups.overdue,
              },
              {
                key: 'today',
                icon: <Calendar className="w-4 h-4" />,
                title: t('tasks.dueToday'),
                tone: 'text-[var(--c2)]',
                items: groups.today,
              },
              {
                key: 'upcoming',
                icon: <Calendar className="w-4 h-4" />,
                title: t('tasks.upcoming'),
                tone: 'text-[var(--c4)]',
                items: groups.upcoming,
              },
              {
                key: 'later',
                icon: <ListTodo className="w-4 h-4" />,
                title: t('tasks.later'),
                tone: 'text-[var(--muted)]',
                items: groups.later,
              },
              {
                key: 'completed',
                icon: <CheckCircle2 className="w-4 h-4" />,
                title: t('tasks.completed'),
                tone: 'text-[var(--c4)]',
                items: groups.completed,
              },
            ].map((section) => (
              <TaskGroup
                key={section.key}
                icon={section.icon}
                title={section.title}
                tone={section.tone}
                tasks={section.items}
                onSelect={setSelected}
                onComplete={handleComplete}
                onSnooze={handleSnooze}
                t={t}
                formatDate={formatDate}
              />
            ))}
          </div>
        )}
      </div>

      {/* Card side panel */}
      {selected && (
        <CardPanel
          workspaceId={workspaceId!}
          cardId={selected.id}
          boardId={selected.boardId}
          projectId={selected.projectId}
          columns={panelColumns}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
