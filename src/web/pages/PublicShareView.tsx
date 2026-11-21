import { useMemo, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import '@blocknote/shadcn/style.css';
import { Calendar, CheckSquare, Globe, Square, X } from 'lucide-react';
import { schema } from '../editor/schema';
import { useTheme } from '../lib/theme';

interface PublicNotepadPayload {
  kind: 'notepad';
  title: string;
  icon: string | null;
  content: string;
  tags: Array<{ id: string; name: string; color: string | null }>;
  updatedAt: number;
}

interface PublicCardItem {
  id: string;
  title: string;
  priority: 'low' | 'medium' | 'high' | 'urgent' | null;
  dueDate: number | null;
  tags: Array<{ id: string; name: string; color?: string | null }>;
  totalSubtasks: number;
  completedSubtasks: number;
  content: string;
  subtasks: Array<{ id: string; title: string; completed: boolean }>;
}

interface PublicBoardPayload {
  kind: 'board';
  name: string;
  icon: string | null;
  columns: Array<{
    id: string;
    name: string;
    color: string | null;
    wipLimit: number | null;
    cards: PublicCardItem[];
  }>;
  updatedAt: number;
}

type PublicSharePayload = PublicNotepadPayload | PublicBoardPayload;

function ReadOnlyBlockNote({ content }: { content: string }) {
  const { isDark } = useTheme();
  const initialContent = useMemo(() => {
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
    } catch {
      return undefined;
    }
  }, [content]);

  const editor = useCreateBlockNote({
    schema,
    initialContent: initialContent as any,
  });

  return (
    <BlockNoteView
      editor={editor}
      editable={false}
      slashMenu={false}
      filePanel={false}
      theme={isDark ? 'dark' : 'light'}
    />
  );
}

export function PublicShareView() {
  const { token } = useParams({ strict: false }) as { token?: string };
  const [selectedCard, setSelectedCard] = useState<PublicCardItem | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['public-share-view', token],
    queryFn: async () => {
      if (!token) throw new Error('Missing share token');
      const res = await fetch(`/api/public/shares/${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error('Shared page not found or access revoked');
      return (await res.json()) as PublicSharePayload;
    },
    enabled: Boolean(token),
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] text-sm text-[var(--muted)]">
        Loading shared page…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-2 bg-[var(--bg)] text-[var(--text)] p-6 text-center">
        <Globe className="w-8 h-8 text-[var(--muted)]" />
        <h1 className="text-lg font-bold">This shared link is unavailable</h1>
        <p className="text-xs text-[var(--muted)] max-w-md">
          The page or board may have been unpublished, expired, or removed.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="px-4 sm:px-6 py-2.5 border-b border-[var(--line)] bg-[var(--surface)] flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
          <Globe className="w-3.5 h-3.5 text-[var(--accent)]" />
          <span>Shared read-only via Burrow</span>
        </div>
        <span className="text-[11px] font-mono text-[var(--muted)]">
          Updated {new Date(data.updatedAt).toLocaleDateString()}
        </span>
      </header>

      {data.kind === 'notepad' ? (
        <main className="flex-1 w-full max-w-4xl mx-auto px-4 sm:px-8 py-8 space-y-5">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              {data.icon && <span className="text-3xl">{data.icon}</span>}
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{data.title}</h1>
            </div>
            {data.tags.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {data.tags.map((t) => (
                  <span
                    key={t.id}
                    className="px-2 py-0.5 text-xs border border-[var(--line)] bg-[var(--surface2)]"
                  >
                    #{t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="pt-2">
            <ReadOnlyBlockNote key={data.content} content={data.content} />
          </div>
        </main>
      ) : (
        <main className="flex-1 flex flex-col min-h-0">
          <div className="px-4 sm:px-6 py-4 border-b border-[var(--hair)] flex items-center gap-2.5">
            <span className="text-2xl">{data.icon || '📋'}</span>
            <h1 className="text-xl sm:text-2xl font-bold">{data.name}</h1>
          </div>
          <div className="flex-1 overflow-x-auto p-4 sm:p-6">
            <div className="flex gap-4 items-start min-h-full">
              {data.columns.map((col) => (
                <div
                  key={col.id}
                  className="w-72 shrink-0 border border-[var(--line)] bg-[var(--surface)] p-3 space-y-2.5"
                >
                  <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider">
                    <span>{col.name}</span>
                    <span className="font-mono text-[var(--muted)]">{col.cards.length}</span>
                  </div>
                  <div className="space-y-2">
                    {col.cards.map((card) => (
                      <button
                        key={card.id}
                        type="button"
                        onClick={() => setSelectedCard(card)}
                        className="w-full text-left p-2.5 border border-[var(--line)] bg-[var(--surface2)] hover:border-[var(--accent)] transition space-y-1.5 cursor-pointer"
                      >
                        <div className="text-xs font-semibold text-[var(--text)]">
                          {card.title}
                        </div>
                        <div className="flex items-center gap-2 flex-wrap text-[10px] text-[var(--muted)]">
                          {card.priority && (
                            <span className="uppercase font-mono px-1.5 py-0.5 border border-[var(--line)] bg-[var(--surface)]">
                              {card.priority}
                            </span>
                          )}
                          {card.dueDate && (
                            <span className="inline-flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {new Date(card.dueDate).toLocaleDateString()}
                            </span>
                          )}
                          {card.totalSubtasks > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <CheckSquare className="w-3 h-3" />
                              {card.completedSubtasks}/{card.totalSubtasks}
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {selectedCard && (
            <div className="fixed inset-0 z-50 bg-black/40 flex justify-end">
              <div className="w-full max-w-xl bg-[var(--surface)] border-l border-[var(--line)] h-full overflow-y-auto p-5 space-y-4">
                <div className="flex items-start justify-between gap-3 border-b border-[var(--hair)] pb-3">
                  <h2 className="text-lg font-bold text-[var(--text)]">{selectedCard.title}</h2>
                  <button
                    type="button"
                    onClick={() => setSelectedCard(null)}
                    className="p-1 text-[var(--muted)] hover:text-[var(--text)] cursor-pointer"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {selectedCard.tags.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {selectedCard.tags.map((t) => (
                      <span
                        key={t.id}
                        className="px-2 py-0.5 text-xs border border-[var(--line)] bg-[var(--surface2)]"
                      >
                        #{t.name}
                      </span>
                    ))}
                  </div>
                )}

                {selectedCard.subtasks.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                      Subtasks
                    </div>
                    {selectedCard.subtasks.map((s) => (
                      <div key={s.id} className="flex items-center gap-2 text-xs">
                        {s.completed ? (
                          <CheckSquare className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                        ) : (
                          <Square className="w-3.5 h-3.5 text-[var(--muted)] shrink-0" />
                        )}
                        <span className={s.completed ? 'line-through text-[var(--muted)]' : ''}>
                          {s.title}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="pt-2 border-t border-[var(--hair)]">
                  <ReadOnlyBlockNote key={selectedCard.id} content={selectedCard.content} />
                </div>
              </div>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
