import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
  FilePanelController,
  type FilePanelProps,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import '@blocknote/shadcn/style.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { nanoid } from 'nanoid';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  LayoutTemplate,
  Lock,
  MoreHorizontal,
  Plus,
  Printer,
  Search,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { schema } from './schema';
import { MediaPicker } from './MediaPicker';
import { EditorFilePanel } from './EditorFilePanel';
import { createMediaUploader } from './mediaUpload';
import {
  getAtMenuSuggestions,
  getCustomSlashItems,
  getHashMenuSuggestions,
  type SuggestionDialogState,
} from './suggestionItems';
import { NotepadPickerModal, TaskPickerModal, BoardPickerModal } from './ReferenceDialogs';
import { TemplatePickerModal } from './TemplatePicker';
import { DocumentOutline } from './DocumentOutline';
import { BasaltSuggestionMenu } from './BasaltSuggestionMenu';
import { Avatar } from '../components/ui/Avatar';
import { Button } from '../components/ui/Button';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { useAccount, useProjectTags } from '../lib/queries';
import { projectPath, projectTarget, projectApiPath } from '../lib/workspaceRoutes';
import { SaveConflictError, SaveLockController, type EditorScope } from './saveLockController';
import { useTheme } from '../lib/theme';
import { ReferenceScopeProvider } from './referenceScope';

function getTabClientId(): string {
  if (typeof window === 'undefined') return nanoid();
  try {
    let id = window.sessionStorage.getItem('burrow_client_id');
    if (!id) {
      id = nanoid();
      window.sessionStorage.setItem('burrow_client_id', id);
    }
    return id;
  } catch {
    return nanoid();
  }
}

export interface NotepadEditorProps {
  workspaceId: string;
  notepadId: string;
  projectId: string;
  hideTitle?: boolean;
  hideFavorite?: boolean;
}

interface NotepadData {
  id: string;
  workspaceId: string;
  projectId: string;
  kind: 'notepad' | 'card';
  title: string;
  icon?: string | null;
  coverKey?: string | null;
  content: string;
  version: number;
  isFavorite: boolean;
  tags: Array<{ id: string; name: string; color?: string | null }>;
  backlinks: Array<{ id: string; title: string; icon?: string | null }>;
  lock: {
    userId?: string;
    clientId?: string;
    name: string;
    expiresAt: number;
    isMe?: boolean;
  } | null;
}

function sameNotepadScope(left: NotepadData, right: NotepadData): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.id === right.id
  );
}

interface LockBannerState {
  holderName: string;
  isMe?: boolean;
  expiresAt?: number;
}

interface NotepadEditorInnerProps {
  initialData: NotepadData;
  pendingData?: NotepadData;
  hideTitle?: boolean;
  hideFavorite?: boolean;
  onReload: () => void;
  onScopeSwitchComplete: (data: NotepadData) => void;
}

function isBlankDocument(doc: any[]): boolean {
  if (doc.length === 0) return true;
  if (doc.length > 1) return false;
  const only = doc[0];
  if (only?.type !== 'paragraph') return false;
  const hasContent = Array.isArray(only.content) && only.content.length > 0;
  const hasChildren = Array.isArray(only.children) && only.children.length > 0;
  return !hasContent && !hasChildren;
}

function NotepadEditorInner({
  initialData,
  pendingData,
  hideTitle = false,
  hideFavorite = false,
  onReload,
  onScopeSwitchComplete,
}: NotepadEditorInnerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isModern, isDark } = useTheme();
  const { data: account } = useAccount();
  const [data, setData] = useState<NotepadData>(initialData);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'conflict' | 'error'>('saved');
  const [availableBanner, setAvailableBanner] = useState(false);
  const [conflictBanner, setConflictBanner] = useState(false);
  const [showBacklinks, setShowBacklinks] = useState(true);
  const [dialogState, setDialogState] = useState<SuggestionDialogState>({ type: null });
  const [isBlank, setIsBlank] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);

  const { data: projectTags = [] } = useProjectTags(data.workspaceId, data.projectId);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const tagMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showTagMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setShowTagMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showTagMenu]);

  const clientIdRef = useRef(getTabClientId());
  const hasLockRef = useRef<boolean>(
    Boolean(
      initialData.lock &&
      initialData.lock.expiresAt > Date.now() &&
      initialData.lock.clientId === clientIdRef.current,
    ),
  );
  const [lockBanner, setLockBanner] = useState<LockBannerState | null>(() => {
    if (initialData.lock && initialData.lock.expiresAt > Date.now()) {
      const isCurrentClient = initialData.lock.clientId === clientIdRef.current;
      if (!isCurrentClient) {
        return {
          holderName: initialData.lock.name,
          isMe: !!initialData.lock.isMe,
          expiresAt: initialData.lock.expiresAt,
        };
      }
    }
    return null;
  });

  const isFocusedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const titleTimeoutRef = useRef<number | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const titleTextareaRef = useRef<HTMLTextAreaElement>(null);
  const skipUnmountSideEffectsRef = useRef(false);
  const isMountedRef = useRef(true);
  const pendingDataRef = useRef(pendingData);
  const onScopeSwitchCompleteRef = useRef(onScopeSwitchComplete);
  pendingDataRef.current = pendingData;
  onScopeSwitchCompleteRef.current = onScopeSwitchComplete;

  // Auto-resize title textarea to fit content height without vertical scrollbars
  useEffect(() => {
    const el = titleTextareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [data.title]);

  // Parse initial content safely
  const initialContent = useMemo(() => {
    if (!initialData.content) return undefined;
    try {
      const parsed = JSON.parse(initialData.content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (err) {
      console.warn('Failed to parse initial notepad content', err);
    }
    return undefined;
  }, [initialData.content]);

  // Instantiate BlockNote editor with preloaded content
  const membership = account?.workspaces.find((workspace) => workspace.id === data.workspaceId);
  const isEditable =
    Boolean(membership && membership.role !== 'viewer') && !lockBanner && !availableBanner;
  const editor = useCreateBlockNote(
    {
      schema,
      initialContent,
      uploadFile: createMediaUploader(initialData, (message) => toast.error(message)),
    },
    [initialData.workspaceId, initialData.projectId, initialData.id],
  );

  const controllerRef = useRef<SaveLockController | null>(null);
  if (!controllerRef.current) {
    const scope: EditorScope = {
      workspaceId: initialData.workspaceId,
      projectId: initialData.projectId,
      notepadId: initialData.id,
      clientId: clientIdRef.current,
    };
    controllerRef.current = new SaveLockController({
      scope,
      savedContent: initialContent ? initialData.content : JSON.stringify(editor.document),
      version: initialData.version,
      save: async (capturedScope, content, version, keepalive) => {
        const body = JSON.stringify({
          content,
          baseVersion: version,
          clientId: capturedScope.clientId,
        });
        const response = await fetch(
          projectApiPath(
            capturedScope.workspaceId,
            capturedScope.projectId,
            `notepads/${capturedScope.notepadId}/content`,
          ),
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            keepalive: Boolean(keepalive && body.length < 60_000),
            body,
          },
        );
        if (response.status === 409) {
          const conflict = (await response.json()) as {
            error?: { code?: string; holder?: { name?: string; isMe?: boolean } };
          };
          if (conflict.error?.code === 'locked') {
            hasLockRef.current = false;
            stopHeartbeat();
            setLockBanner({
              holderName: conflict.error.holder?.name || 'Someone',
              isMe: !!conflict.error.holder?.isMe,
            });
            setAvailableBanner(false);
            throw new SaveConflictError('Edit lock was lost');
          }
          setConflictBanner(true);
          throw new SaveConflictError();
        }
        if (!response.ok) {
          const failure = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
            message?: string;
          };
          throw new Error(failure.error?.message || failure.message || 'Save failed');
        }
        const result = (await response.json()) as { version: number };
        setConflictBanner(false);
        return result;
      },
      release: async (capturedScope, keepalive) => {
        if (!hasLockRef.current) return;
        const response = await fetch(
          projectApiPath(
            capturedScope.workspaceId,
            capturedScope.projectId,
            `notepads/${capturedScope.notepadId}/lock`,
          ),
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: capturedScope.clientId }),
            keepalive,
          },
        );
        if (!response.ok && response.status !== 404) throw new Error('Failed to release edit lock');
        hasLockRef.current = false;
      },
      onStateChange: (state) => {
        if (isMountedRef.current) setSaveStatus(state.status);
      },
      onScopeSwitched: (nextScope) => {
        const nextData = pendingDataRef.current;
        if (
          nextData &&
          nextData.workspaceId === nextScope.workspaceId &&
          nextData.projectId === nextScope.projectId &&
          nextData.id === nextScope.notepadId
        ) {
          onScopeSwitchCompleteRef.current(nextData);
        }
      },
    });
  }
  const saveController = controllerRef.current;

  useEffect(() => {
    if (!pendingData) return;
    void saveController.switchScope({
      workspaceId: pendingData.workspaceId,
      projectId: pendingData.projectId,
      notepadId: pendingData.id,
      clientId: clientIdRef.current,
    });
  }, [pendingData, saveController]);

  // Track blankness for the "Start with a template" banner.
  useEffect(() => {
    setIsBlank(isBlankDocument(editor.document));
    const unbind = editor.onChange(() => {
      setIsBlank(isBlankDocument(editor.document));
    });
    return unbind;
  }, [editor]);

  const exportMarkdown = () => {
    try {
      const md = editor.blocksToMarkdownLossy(editor.document);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(data.title || 'Untitled').replace(/[\\/:*?"<>|]/g, '-')}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Markdown export failed', err);
      toast.error('Failed to export Markdown');
    }
  };

  // Polling when locked by another client/user (every 10 seconds)
  useEffect(() => {
    if (!lockBanner) return;
    const pollInterval = window.setInterval(async () => {
      try {
        const res = await fetch(
          projectApiPath(
            initialData.workspaceId,
            initialData.projectId,
            `notepads/${initialData.id}`,
          ),
        );
        if (!res.ok) return;
        const json = (await res.json()) as NotepadData;
        if (json.lock && json.lock.expiresAt > Date.now()) {
          const isCurrentClient = json.lock.clientId === clientIdRef.current;
          if (!isCurrentClient) {
            setLockBanner({
              holderName: json.lock.name,
              isMe: !!json.lock.isMe,
              expiresAt: json.lock.expiresAt,
            });
          } else {
            hasLockRef.current = true;
            setLockBanner(null);
            setAvailableBanner(false);
          }
        } else {
          setLockBanner(null);
          setAvailableBanner(true);
        }
      } catch (err) {
        console.warn('Lock poll error', err);
      }
    }, 10_000);
    return () => window.clearInterval(pollInterval);
  }, [lockBanner, initialData.id]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      window.clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  // Lock claim & release
  const claimSeqRef = useRef(0);
  const claimInFlightRef = useRef<{ seq: number; promise: Promise<boolean> } | null>(null);

  const claimLock = useCallback(
    async (takeover = false) => {
      if (claimInFlightRef.current && !takeover) {
        return claimInFlightRef.current.promise;
      }

      const seq = ++claimSeqRef.current;
      const promise = (async () => {
        try {
          const res = await fetch(
            projectApiPath(
              initialData.workspaceId,
              initialData.projectId,
              `notepads/${initialData.id}/lock`,
            ),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                clientId: clientIdRef.current,
                takeover,
              }),
            },
          );

          // If a newer claim request was started while this was in flight, ignore this response
          if (seq !== claimSeqRef.current) {
            return false;
          }

          if (res.status === 409) {
            const err = (await res.json()) as {
              error?: { holder?: { name?: string; isMe?: boolean; userId?: string } };
            };
            hasLockRef.current = false;
            stopHeartbeat();
            setLockBanner({
              holderName: err.error?.holder?.name || 'Someone',
              isMe: !!err.error?.holder?.isMe,
            });
            setAvailableBanner(false);
            return false;
          }
          if (res.ok) {
            hasLockRef.current = true;
            setLockBanner(null);
            setAvailableBanner(false);
            return true;
          }
        } catch (err) {
          console.warn('Lock claim error', err);
          toast.error(err instanceof Error ? err.message : 'Failed to claim edit lock');
        } finally {
          if (claimInFlightRef.current?.seq === seq) {
            claimInFlightRef.current = null;
          }
        }
        return false;
      })();

      claimInFlightRef.current = { seq, promise };
      return promise;
    },
    [initialData.workspaceId, initialData.projectId, initialData.id, stopHeartbeat],
  );

  const releaseLock = useCallback(() => {
    stopHeartbeat();
    void saveController.releaseCurrent().then((released) => {
      if (!released && isMountedRef.current)
        toast.error('Could not save and release the edit lock');
    });
  }, [saveController, stopHeartbeat]);

  const startHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) return;
    heartbeatIntervalRef.current = window.setInterval(() => {
      if (isFocusedRef.current || hasLockRef.current) {
        claimLock();
      }
    }, 30_000);
  }, [claimLock]);

  useEffect(() => {
    if (hasLockRef.current) {
      startHeartbeat();
    }
  }, [startHeartbeat]);

  const executeSave = useCallback(
    (content: string, options?: { isUnload?: boolean }) =>
      saveController.saveNow(content, Boolean(options?.isUnload)),
    [saveController],
  );

  const scheduleSave = useCallback(
    (content: string) => saveController.schedule(content),
    [saveController],
  );

  const handleDiscardSave = () => {
    const savedContent = saveController.discard();
    setConflictBanner(false);
    if (!editor) return;
    try {
      const blocks = JSON.parse(savedContent);
      if (Array.isArray(blocks) && blocks.length > 0) {
        editor.replaceBlocks(editor.document, blocks as any[]);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Could not restore the last saved document',
      );
    }
  };

  // Listen to editor changes
  useEffect(() => {
    if (!editor || !isEditable) return;
    const unbind = editor.onChange(() => {
      if (!hasLockRef.current && !lockBanner && !availableBanner) {
        claimLock();
        startHeartbeat();
      }
      const json = JSON.stringify(editor.document);
      scheduleSave(json);
    });
    return unbind;
  }, [editor, isEditable, scheduleSave, lockBanner, availableBanner, claimLock, startHeartbeat]);

  // Focus & blur management for lock claiming and releasing
  const handleFocus = useCallback(() => {
    isFocusedRef.current = true;
    if (!lockBanner && !availableBanner) {
      claimLock();
      startHeartbeat();
    }
  }, [claimLock, lockBanner, availableBanner, startHeartbeat]);

  const handleBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (containerRef.current && containerRef.current.contains(e.relatedTarget as Node)) {
        return;
      }
      if (typeof document !== 'undefined' && !document.hasFocus()) {
        return;
      }
      isFocusedRef.current = false;
      stopHeartbeat();
      if (editor) {
        const docJson = JSON.stringify(editor.document);
        if (saveController.isDirty || docJson !== saveController.getState().savedContent) {
          void executeSave(docJson).then((saved) => {
            if (saved && hasLockRef.current && !isFocusedRef.current) releaseLock();
          });
          return;
        }
      }
      if (hasLockRef.current) {
        releaseLock();
      }
    },
    [editor, executeSave, releaseLock, saveController, stopHeartbeat],
  );

  // Page unload & unmount lock release
  useEffect(() => {
    isMountedRef.current = true;
    const handlePageHide = () => {
      if (hasLockRef.current) {
        if (editor) saveController.schedule(JSON.stringify(editor.document));
        void saveController.releaseCurrent(true).then((released) => {
          if (!released && isMountedRef.current)
            toast.error('Could not save and release the edit lock');
        });
      }
    };

    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);

    return () => {
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
      isMountedRef.current = false;
      stopHeartbeat();
      if (titleTimeoutRef.current) window.clearTimeout(titleTimeoutRef.current);
      if (hasLockRef.current && !skipUnmountSideEffectsRef.current) {
        if (editor) saveController.schedule(JSON.stringify(editor.document));
        void saveController.releaseCurrent(true);
      }
      saveController.dispose();
    };
  }, [editor, releaseLock, saveController, stopHeartbeat]);

  const toggleFavorite = async () => {
    const next = !data.isFavorite;
    setData((prev) => ({ ...prev, isFavorite: next }));
    queryClient.setQueryData<Array<{ id: string; isFavorite: boolean }>>(
      ['notepads', initialData.workspaceId, initialData.projectId],
      (old) =>
        old ? old.map((n) => (n.id === initialData.id ? { ...n, isFavorite: next } : n)) : old,
    );
    try {
      const res = await fetch(
        projectApiPath(
          initialData.workspaceId,
          initialData.projectId,
          `notepads/${initialData.id}`,
        ),
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isFavorite: next }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(err?.error?.message || 'Failed to update favorite');
      }
      queryClient.invalidateQueries({
        queryKey: ['notepads', initialData.workspaceId, initialData.projectId],
      });
    } catch (err) {
      setData((prev) => ({ ...prev, isFavorite: !next }));
      queryClient.invalidateQueries({
        queryKey: ['notepads', initialData.workspaceId, initialData.projectId],
      });
      const msg = err instanceof Error ? err.message : 'Failed to update favorite';
      console.error(msg, err);
      toast.error(msg);
    }
  };

  const handleTitleChange = (newTitle: string) => {
    setData((prev) => ({ ...prev, title: newTitle }));
    if (titleTimeoutRef.current) window.clearTimeout(titleTimeoutRef.current);
    titleTimeoutRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch(
          projectApiPath(
            initialData.workspaceId,
            initialData.projectId,
            `notepads/${initialData.id}`,
          ),
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle }),
          },
        );
        if (!res.ok) {
          const err = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(err?.error?.message || 'Failed to save title');
        }
        queryClient.setQueryData<Array<{ id: string; title: string } & Record<string, unknown>>>(
          ['notepads', account?.user.id, initialData.workspaceId, initialData.projectId],
          (old) =>
            old
              ? old.map((n) =>
                  n.id === initialData.id ? { ...n, title: newTitle.trim() || 'Untitled' } : n,
                )
              : old,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to save title';
        console.error('Title save error', err);
        toast.error(msg);
      }
    }, 400);
  };

  const handleDeleteNotepad = async () => {
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      const res = await fetch(
        projectApiPath(
          initialData.workspaceId,
          initialData.projectId,
          `notepads/${initialData.id}`,
        ),
        { method: 'DELETE' },
      );
      if (res.status === 404) {
        // Already deleted — treat as success, same as the sidebar tree.
      } else if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(err?.error?.message || 'Failed to delete notepad');
      }
      setConfirmDeleteOpen(false);
      queryClient.invalidateQueries({
        queryKey: ['notepads', initialData.workspaceId, initialData.projectId],
      });
      navigate(projectTarget(initialData.workspaceId, initialData.projectId));
    } catch (err) {
      setConfirmDeleteOpen(false);
      setIsDeleting(false);
      const msg = err instanceof Error ? err.message : 'Failed to delete notepad';
      console.error(msg, err);
      toast.error(msg);
    }
  };

  const bannersNode = (
    <>
      {/* Top Banner: Read-only Lock */}
      {lockBanner && (
        <div className="p-3 bg-[var(--surface2)] border border-[var(--line)] border-l-4 border-l-[var(--c2)] flex items-center justify-between gap-3 text-xs text-[var(--text)]">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-[var(--c2)] shrink-0" />
            <span>
              {lockBanner.isMe ? (
                <>You are currently editing this notepad in another window or tab (read-only).</>
              ) : (
                <>
                  <strong>{lockBanner.holderName}</strong> is currently editing this notepad
                  (read-only).
                </>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {lockBanner.isMe && (
              <Button
                variant="primary"
                onClick={async () => {
                  const ok = await claimLock(true);
                  if (ok) {
                    skipUnmountSideEffectsRef.current = true;
                    await onReload();
                  }
                }}
                className="px-2.5 py-1 text-xs font-medium"
              >
                Edit Here Instead
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={async () => {
                const ok = await claimLock(false);
                if (ok) {
                  skipUnmountSideEffectsRef.current = true;
                  await onReload();
                }
              }}
              className="px-2.5 py-1 text-xs font-medium"
            >
              Check Availability
            </Button>
          </div>
        </div>
      )}

      {/* Top Banner: Now Available */}
      {availableBanner && !lockBanner && (
        <div className="p-3 bg-[var(--surface2)] border border-[var(--line)] border-l-4 border-l-[var(--c4)] flex items-center justify-between gap-3 text-xs text-[var(--text)]">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[var(--c4)] shrink-0" />
            <span>This notepad is now available to edit.</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                const ok = await claimLock(false);
                if (ok) {
                  setAvailableBanner(false);
                  skipUnmountSideEffectsRef.current = true;
                  await onReload();
                }
              }}
              className="px-2.5 py-1 bg-[var(--accent)] text-[var(--accent-ink)] text-xs font-medium transition cursor-pointer"
            >
              Start Editing
            </button>
            <button
              onClick={() => {
                setAvailableBanner(false);
                skipUnmountSideEffectsRef.current = true;
                onReload();
              }}
              className="p-1 text-[var(--c4)] hover:text-[var(--text)] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Top Banner: Version Conflict */}
      {conflictBanner && (
        <div className="p-3 bg-[var(--surface2)] border border-[var(--line)] border-l-4 border-l-[var(--danger)] flex items-center justify-between gap-3 text-xs text-[var(--text)]">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-[var(--danger)]" />
            <span>This notepad changed elsewhere. Reload to get latest changes or overwrite.</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                skipUnmountSideEffectsRef.current = true;
                onReload();
              }}
              className="px-2.5 py-1 bg-[var(--surface)] border border-[var(--line)] text-xs font-medium hover:bg-[var(--hi)] cursor-pointer"
            >
              Reload
            </button>
            <button
              onClick={async () => {
                if (!editor) return;
                try {
                  const res = await fetch(
                    projectApiPath(
                      initialData.workspaceId,
                      initialData.projectId,
                      `notepads/${initialData.id}`,
                    ),
                  );
                  if (res.ok) {
                    const latest = (await res.json()) as { version: number };
                    saveController.setVersion(latest.version);
                  }
                  setConflictBanner(false);
                  await saveController.retry();
                } catch (err: any) {
                  toast.error(err?.message || 'Failed to fetch latest notepad version');
                }
              }}
              className="px-2.5 py-1 bg-[var(--danger)] text-white text-xs font-medium cursor-pointer"
            >
              Overwrite
            </button>
          </div>
        </div>
      )}
    </>
  );

  const updateNotepadTags = async (newTagIds: string[]) => {
    try {
      const putRes = await fetch(
        projectApiPath(
          initialData.workspaceId,
          initialData.projectId,
          `notepads/${initialData.id}/tags`,
        ),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagIds: newTagIds }),
        },
      );
      if (!putRes.ok) {
        const errJson = (await putRes.json().catch(() => ({}))) as {
          error?: { message?: string };
          message?: string;
        };
        throw new Error(errJson.error?.message || errJson.message || 'Failed to update tags');
      }
      const res = await fetch(
        projectApiPath(
          initialData.workspaceId,
          initialData.projectId,
          `notepads/${initialData.id}`,
        ),
      );
      if (res.ok) {
        const json = (await res.json()) as NotepadData;
        setData(json);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update tags');
    }
  };

  const removeTag = async (tagId: string) => {
    const nextTags = (data.tags || []).filter((t) => t.id !== tagId).map((t) => t.id);
    await updateNotepadTags(nextTags);
  };

  const addTag = async (tagId: string) => {
    const currentTags = (data.tags || []).map((t) => t.id);
    if (!currentTags.includes(tagId)) {
      await updateNotepadTags([...currentTags, tagId]);
    }
  };

  const handleAddOrCreateTag = async () => {
    const trimmed = tagSearch.trim().replace(/^#/, '');
    if (!trimmed) return;
    const existing = projectTags.find((pt) => pt.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      await addTag(existing.id);
      setShowTagMenu(false);
      setTagSearch('');
      return;
    }
    try {
      const res = await fetch(projectApiPath(data.workspaceId, data.projectId, 'tags'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as {
          error?: { message?: string };
          message?: string;
        };
        throw new Error(errJson.error?.message || errJson.message || 'Failed to create tag');
      }
      const newTag = (await res.json()) as { id: string; name: string };
      await queryClient.invalidateQueries({ queryKey: ['tags', data.workspaceId, data.projectId] });
      toast.success(`Tag #${newTag.name} created`);
      await addTag(newTag.id);
      setShowTagMenu(false);
      setTagSearch('');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to create tag');
    }
  };

  const attachedTags = data.tags || [];
  const cleanTagSearch = tagSearch.trim().replace(/^#/, '');
  const availableTags = projectTags.filter(
    (pt) =>
      !attachedTags.some((t) => t.id === pt.id) &&
      pt.name.toLowerCase().includes(cleanTagSearch.toLowerCase()),
  );
  const exactTagMatch = projectTags.some(
    (pt) => pt.name.toLowerCase() === cleanTagSearch.toLowerCase(),
  );

  const tagsNode = (
    <div className="flex items-center gap-1.5 flex-wrap">
      {attachedTags.map((tag) => (
        <span
          key={tag.id}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-[var(--surface2)] border border-[var(--line)] text-[var(--text)] select-none"
        >
          <span className="text-[var(--muted)]">#</span>
          <span>{tag.name}</span>
          <button
            type="button"
            onClick={() => removeTag(tag.id)}
            title={`Remove #${tag.name}`}
            className="p-0.5 text-[var(--muted)] hover:text-[var(--danger)] cursor-pointer"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}

      <div className="relative" ref={tagMenuRef}>
        <button
          type="button"
          onClick={() => setShowTagMenu((v) => !v)}
          title="Add tag"
          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs border border-dashed border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)] hover:border-[var(--muted)] bg-[var(--surface)] transition cursor-pointer select-none"
        >
          <Plus className="w-3 h-3" />
          <span>Tag</span>
        </button>

        {showTagMenu && (
          <div className="absolute left-0 top-full mt-1 w-52 bg-[var(--surface)] border border-[var(--line)] p-1.5 z-40 text-xs">
            <div className="mb-1.5">
              <input
                type="text"
                autoFocus
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    await handleAddOrCreateTag();
                  } else if (e.key === 'Escape') {
                    setShowTagMenu(false);
                  }
                }}
                placeholder="Search or new tag…"
                className="w-full px-2 py-1 text-xs bg-[var(--surface2)] border border-[var(--line)] text-[var(--text)] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="max-h-36 overflow-y-auto space-y-0.5">
              {availableTags.map((pt) => (
                <button
                  key={pt.id}
                  type="button"
                  onClick={() => {
                    addTag(pt.id);
                    setShowTagMenu(false);
                    setTagSearch('');
                  }}
                  className="w-full text-left px-2 py-1 text-xs hover:bg-[var(--accent)] hover:text-[var(--accent-ink)] flex items-center gap-1.5 cursor-pointer transition"
                >
                  <Tag className="w-3 h-3 shrink-0" style={{ color: pt.color || 'var(--c4)' }} />
                  <span>#{pt.name}</span>
                </button>
              ))}
              {cleanTagSearch && !exactTagMatch && (
                <button
                  type="button"
                  onClick={handleAddOrCreateTag}
                  className="w-full text-left px-2 py-1 text-xs hover:bg-[var(--accent)] hover:text-[var(--accent-ink)] flex items-center gap-1.5 text-[var(--accent)] hover:text-[var(--accent-ink)] font-medium cursor-pointer transition"
                >
                  <Plus className="w-3 h-3 shrink-0" />
                  <span>Create "#{cleanTagSearch}"</span>
                </button>
              )}
              {!cleanTagSearch && availableTags.length === 0 && (
                <div className="p-2 text-center text-xs text-[var(--muted)]">
                  No other tags. Type to create.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const exportMenuNode = (
    <div className="relative">
      <Button
        variant="ghost"
        onClick={() => setShowExportMenu((v) => !v)}
        title="Document actions"
        className="p-1.5 border border-[var(--line)] text-[var(--muted)] hover:text-[var(--text)] transition"
      >
        <MoreHorizontal className="w-4 h-4" />
      </Button>
      {showExportMenu && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-[var(--surface)] border border-[var(--line)] p-1 z-30 text-xs">
          <button
            onClick={() => {
              setShowExportMenu(false);
              setDialogState({ type: 'template' });
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[var(--text)] hover:bg-[var(--hi)]"
          >
            <LayoutTemplate className="w-3.5 h-3.5" />
            <span>Apply a template…</span>
          </button>
          <button
            onClick={() => {
              setShowExportMenu(false);
              exportMarkdown();
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[var(--text)] hover:bg-[var(--hi)]"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Export to Markdown</span>
          </button>
          <button
            onClick={() => {
              setShowExportMenu(false);
              window.print();
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-[var(--text)] hover:bg-[var(--hi)]"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>Print / Export as PDF</span>
          </button>
          <div className="my-1 border-t border-[var(--line)]" />
          {data.kind !== 'card' && (
            <button
              onClick={() => {
                setShowExportMenu(false);
                setConfirmDeleteOpen(true);
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[var(--danger)] hover:bg-[var(--danger)]/10 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete to Trash</span>
            </button>
          )}
        </div>
      )}
    </div>
  );

  const starterTemplateNode = isBlank && isEditable && (
    <div className="no-print w-full flex items-center justify-between gap-3 p-3 border border-dashed border-[var(--line)] bg-[var(--surface2)] text-xs">
      <div className="flex items-center gap-2 text-[var(--muted)]">
        <LayoutTemplate className="w-4 h-4 text-[var(--accent)] shrink-0" />
        <span>This page is empty — start from a template?</span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          onClick={() => setDialogState({ type: 'template' })}
          className="px-2.5 py-1 font-medium"
        >
          Browse templates
        </Button>
        <Button variant="secondary" onClick={() => setIsBlank(false)} className="px-2.5 py-1">
          Write from scratch
        </Button>
      </div>
    </div>
  );

  const renderFilePanel = useCallback(
    (props: FilePanelProps) => (
      <EditorFilePanel {...props} workspaceId={data.workspaceId} projectId={data.projectId} />
    ),
    [data.workspaceId, data.projectId],
  );

  const blockNoteViewNode = editor && (
    <BlockNoteView
      editor={editor}
      editable={isEditable}
      slashMenu={false}
      filePanel={false}
      theme={isDark ? 'dark' : 'light'}
      className={hideTitle ? 'w-full bn-embedded' : 'w-full'}
    >
      <FilePanelController
        filePanel={renderFilePanel}
        portalElement={typeof document === 'undefined' ? undefined : document.body}
        floatingUIOptions={{ useFloatingOptions: { strategy: 'fixed' } }}
      />
      {/* Custom Slash Menu */}
      <SuggestionMenuController
        triggerCharacter="/"
        suggestionMenuComponent={BasaltSuggestionMenu}
        getItems={async (query) => {
          const mediaItem = {
            title: 'Media',
            subtext: 'Upload an image, reuse project media, or link a video',
            aliases: ['image', 'picture', 'video', 'youtube', 'upload', 'library'],
            group: 'Media',
            icon: <FileText className="w-4 h-4" />,
            onItemClick: () => setMediaOpen(true),
          };
          const defaultItems = getDefaultReactSlashMenuItems(editor).filter(
            (item) => !['Image', 'Video'].includes(item.title),
          );
          const customItems = getCustomSlashItems(
            editor,
            data.kind === 'card' ? 'card' : 'notepad',
            data.projectId || '',
            setDialogState,
          );
          const all = [mediaItem, ...customItems, ...defaultItems];
          const q = query.toLowerCase();
          return all.filter(
            (item) =>
              item.title.toLowerCase().includes(q) ||
              item.aliases?.some((a) => a.toLowerCase().includes(q)),
          );
        }}
      />

      {/* At (@) Menu: People, Notepads, Cards, Dates */}
      <SuggestionMenuController
        triggerCharacter="@"
        suggestionMenuComponent={BasaltSuggestionMenu}
        getItems={async (query) => {
          return getAtMenuSuggestions(query, data.workspaceId, data.projectId || '', editor);
        }}
      />

      {/* Hash (#) Menu: Project Tags */}
      <SuggestionMenuController
        triggerCharacter="#"
        suggestionMenuComponent={BasaltSuggestionMenu}
        getItems={async (query) => {
          return getHashMenuSuggestions(
            query,
            data.workspaceId,
            data.projectId || '',
            initialData.id,
            editor,
            async (tagId) => {
              await addTag(tagId);
            },
          );
        }}
      />
    </BlockNoteView>
  );

  const backlinksNode = data.backlinks && data.backlinks.length > 0 && (
    <div className="border-t border-[var(--hair)] pt-6">
      <button
        onClick={() => setShowBacklinks(!showBacklinks)}
        className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-3 hover:text-[var(--text)]"
      >
        {showBacklinks ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        <span>Backlinks ({data.backlinks.length})</span>
      </button>

      {showBacklinks && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {data.backlinks.map((link) => (
            <a
              key={link.id}
              href={`${projectPath(data.workspaceId, data.projectId)}/notepads/${encodeURIComponent(link.id)}`}
              className="p-2.5 border border-[var(--line)] hover:bg-[var(--hi)] flex items-center gap-2 text-xs transition"
            >
              {link.icon ? (
                <span className="text-sm shrink-0">{link.icon}</span>
              ) : (
                <FileText className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              )}
              <span className="truncate font-medium">{link.title}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );

  const dialogsNode = (
    <>
      {mediaOpen && isEditable && (
        <MediaPicker
          key={`${data.workspaceId}/${data.projectId}`}
          workspaceId={data.workspaceId}
          projectId={data.projectId}
          onClose={() => setMediaOpen(false)}
          onSelect={(selection) => {
            if (!isEditable) return;
            const current = editor.getTextCursorPosition().block;
            if (selection.kind === 'link') {
              editor.insertBlocks(
                [
                  {
                    type: 'paragraph',
                    content: [{ type: 'link', href: selection.url, content: selection.url }],
                  },
                ],
                current,
                'after',
              );
            } else if (selection.kind === 'youtube') {
              editor.insertBlocks(
                [{ type: 'youtube', props: { videoId: selection.videoId } }],
                current,
                'after',
              );
            } else {
              editor.insertBlocks(
                [{ type: selection.kind, props: { url: selection.url, name: selection.name || '' } }],
                current,
                'after',
              );
            }
          }}
        />
      )}
      {/* Template dialog: /template slash command, header menu, blank-doc banner */}
      {dialogState.type === 'template' && (
        <TemplatePickerModal editor={editor} onClose={() => setDialogState({ type: null })} />
      )}

      {/* Delete to Trash confirmation */}
      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete notepad"
        message={`Move "${data.title || 'Untitled'}" to Trash? You can restore it from Trash if needed.`}
        confirmLabel="Delete to Trash"
        danger
        busy={isDeleting}
        onConfirm={handleDeleteNotepad}
        onCancel={() => {
          if (!isDeleting) setConfirmDeleteOpen(false);
        }}
      />

      {/* Reference Dialogs: /notepad, /task, and /board */}
      {dialogState.type === 'notepad' && data.projectId && (
        <NotepadPickerModal
          workspaceId={data.workspaceId}
          projectId={data.projectId}
          onClose={() => setDialogState({ type: null })}
          onSelectNotepad={(selectedId) => {
            if (editor) {
              const currentBlock = editor.getTextCursorPosition().block;
              editor.insertBlocks(
                [{ type: 'notepadLink', props: { notepadId: selectedId } }],
                currentBlock,
                'after',
              );
            }
          }}
        />
      )}

      {dialogState.type === 'task' && data.projectId && (
        <TaskPickerModal
          workspaceId={data.workspaceId}
          projectId={data.projectId}
          onClose={() => setDialogState({ type: null })}
          onCardCreated={(createdCardId) => {
            if (editor) {
              const currentBlock = editor.getTextCursorPosition().block;
              editor.insertBlocks(
                [{ type: 'cardLink', props: { cardId: createdCardId } }],
                currentBlock,
                'after',
              );
            }
          }}
        />
      )}

      {dialogState.type === 'board' && data.projectId && (
        <BoardPickerModal
          workspaceId={data.workspaceId}
          projectId={data.projectId}
          onClose={() => setDialogState({ type: null })}
          onSelectBoard={(selectedBoardId) => {
            if (editor) {
              const currentBlock = editor.getTextCursorPosition().block;
              editor.insertBlocks(
                [{ type: 'boardLink', props: { boardId: selectedBoardId } }],
                currentBlock,
                'after',
              );
            }
          }}
        />
      )}
    </>
  );

  if (hideTitle) {
    return (
      <div
        ref={containerRef}
        onFocusCapture={handleFocus}
        onBlurCapture={handleBlur}
        className="w-full space-y-4"
      >
        {bannersNode}

        <div className="w-full flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-2">
            {!hideFavorite && (
              <Button
                variant="ghost"
                onClick={toggleFavorite}
                className={`p-1.5 border transition ${
                  data.isFavorite
                    ? 'text-[var(--accent-ink)] bg-[var(--accent)] border-[var(--accent)]'
                    : 'text-[var(--muted)] border-[var(--line)] hover:text-[var(--text)]'
                }`}
                title="Favorite"
              >
                <Star className={`w-4 h-4 ${data.isFavorite ? 'fill-current' : ''}`} />
              </Button>
            )}

            <span className="text-xs text-[var(--muted)]">
              {saveStatus === 'saving' && 'Saving…'}
              {saveStatus === 'saved' && 'Saved'}
              {saveStatus === 'conflict' && 'Conflict'}
              {(saveStatus === 'error' || saveStatus === 'conflict') && (
                <span className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void saveController.retry()}
                    className="text-rose-500 hover:text-[var(--danger)] underline font-medium cursor-pointer"
                  >
                    Retry save
                  </button>
                  <button
                    type="button"
                    onClick={handleDiscardSave}
                    className="text-[var(--muted)] hover:text-[var(--text)] underline cursor-pointer"
                  >
                    Discard
                  </button>
                </span>
              )}
            </span>

            {tagsNode}
          </div>

          <div className="flex items-center gap-1.5 relative">
            <DocumentOutline editor={editor} containerRef={containerRef} variant="floating" />
            {exportMenuNode}
          </div>
        </div>

        {starterTemplateNode}

        <div className="w-full pt-1 bn-embedded">{blockNoteViewNode}</div>

        {dialogsNode}
        {backlinksNode}
      </div>
    );
  }

  const titleNode = (
    <div className="w-full">
      <textarea
        ref={titleTextareaRef}
        rows={1}
        value={data.title || ''}
        onChange={(e) => handleTitleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (editor) {
              editor.focus();
            }
          } else if (e.key === 'ArrowDown') {
            if (e.currentTarget.selectionStart === e.currentTarget.value.length) {
              if (editor) {
                editor.focus();
              }
            }
          }
        }}
        placeholder="Untitled"
        disabled={!isEditable}
        className={
          isModern
            ? 'w-full resize-none overflow-hidden bg-transparent border-none outline-none focus:outline-none focus:ring-0 p-0 text-[32px] sm:text-[40px] font-bold tracking-[-0.03em] leading-[1.1] text-[var(--text)] placeholder:text-[var(--muted)]/50 transition-colors disabled:opacity-70 disabled:cursor-not-allowed'
            : 'w-full resize-none overflow-hidden bg-transparent border-none outline-none focus:outline-none focus:ring-0 p-0 font-display text-[34px] sm:text-[46px] font-extrabold leading-[1.05] tracking-[-0.02em] text-[var(--text)] placeholder:text-[var(--muted)]/50 transition-colors disabled:opacity-70 disabled:cursor-not-allowed'
        }
      />
    </div>
  );

  if (isModern) {
    return (
      <div
        ref={containerRef}
        onFocusCapture={handleFocus}
        onBlurCapture={handleBlur}
        className="w-full min-h-full flex flex-col relative"
      >
        {/* Top Header Bar */}
        <div className="no-print min-h-[46px] py-1 shrink-0 flex items-center justify-between gap-4 px-6 text-[13px] text-[var(--muted)] border-b border-[var(--hair)]">
          <div className="flex items-center gap-3 min-w-0 flex-wrap">
            <div className="flex items-center gap-1.5 shrink-0">
              <span>Notepads</span>
              <span className="opacity-50">/</span>
              <span className="text-[var(--text)] font-medium truncate max-w-[200px]">
                {data.title || 'Untitled'}
              </span>
            </div>
            {tagsNode}
          </div>

          <div className="flex items-center gap-3.5 shrink-0">
            <span>
              {saveStatus === 'saving' && 'Saving…'}
              {saveStatus === 'saved' && 'Saved'}
              {saveStatus === 'conflict' && 'Conflict'}
              {(saveStatus === 'error' || saveStatus === 'conflict') && (
                <span className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void saveController.retry()}
                    className="text-[var(--danger)] underline cursor-pointer"
                  >
                    Retry save
                  </button>
                  <button
                    type="button"
                    onClick={handleDiscardSave}
                    className="text-[var(--muted)] underline cursor-pointer"
                  >
                    Discard
                  </button>
                </span>
              )}
            </span>

            {!hideFavorite && (
              <button
                type="button"
                onClick={toggleFavorite}
                title={data.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                aria-label="Favorite"
                className={`p-1.5 transition cursor-pointer ${
                  data.isFavorite
                    ? 'text-[var(--accent)]'
                    : 'text-[var(--muted)] hover:text-[var(--text)]'
                }`}
              >
                <Star className={`w-4 h-4 ${data.isFavorite ? 'fill-current' : ''}`} />
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(window.location.href);
                toast.success('Notepad link copied to clipboard');
              }}
              className="h-7 px-3 theme-radius-md bg-[var(--accent)] text-[var(--accent-ink)] font-semibold text-[13px] flex items-center hover:brightness-110 transition cursor-pointer"
            >
              Share
            </button>

            <DocumentOutline editor={editor} containerRef={containerRef} variant="floating" />

            {exportMenuNode}
          </div>
        </div>

        {/* Flat Obsidian Canvas */}
        <div className="w-full max-w-[780px] pl-6 sm:pl-24 pr-6 pt-11 pb-20 flex flex-col gap-5">
          {bannersNode}
          {titleNode}
          {starterTemplateNode}
          <div className="w-full pt-2 min-h-[350px]">{blockNoteViewNode}</div>
          {backlinksNode}
        </div>

        {dialogsNode}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
      className="w-full min-h-full flex flex-col px-4 sm:px-5 pb-5 relative"
    >
      {/* Top Header Bar */}
      <div className="no-print min-h-[60px] py-2 shrink-0 flex items-center justify-between gap-4 text-[13px] font-semibold text-[var(--ink-muted)]">
        <div className="flex items-center gap-3 min-w-0 flex-wrap">
          <div className="flex items-center gap-1.5 shrink-0">
            <span>Notepads</span>
            <span className="opacity-50">/</span>
            <span className="text-[var(--text)] truncate max-w-[200px]">
              {data.title || 'Untitled'}
            </span>
          </div>
          {tagsNode}
        </div>

        <div className="flex items-center gap-3.5 shrink-0">
          <span className="flex items-center gap-2 font-medium text-[var(--ink-muted)]">
            <span className="diamond-dot" />
            {saveStatus === 'saving' && 'Saving…'}
            {saveStatus === 'saved' && 'Saved'}
            {saveStatus === 'conflict' && 'Conflict'}
            {(saveStatus === 'error' || saveStatus === 'conflict') && (
              <span className="inline-flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveController.retry()}
                  className="text-[var(--danger)] underline cursor-pointer"
                >
                  Retry save
                </button>
                <button
                  type="button"
                  onClick={handleDiscardSave}
                  className="text-[var(--muted)] underline cursor-pointer"
                >
                  Discard
                </button>
              </span>
            )}
          </span>

          <div className="hidden sm:flex items-center">
            <Avatar
              name={account?.user?.name || 'TM'}
              size="sm"
              className="w-[30px] h-[30px] text-[10px] font-extrabold"
            />
            {lockBanner && !lockBanner.isMe && (
              <Avatar
                name={lockBanner.holderName}
                size="sm"
                className="-ml-1.5 w-[30px] h-[30px] text-[10px] font-extrabold bg-[var(--accent)] text-[var(--accent-ink)]"
              />
            )}
          </div>

          {!hideFavorite && (
            <button
              type="button"
              onClick={toggleFavorite}
              title={data.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-label="Favorite"
              className={`p-1.5 transition cursor-pointer ${
                data.isFavorite
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--ink-muted)] hover:text-[var(--text)]'
              }`}
            >
              <Star className={`w-4 h-4 ${data.isFavorite ? 'fill-current' : ''}`} />
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(window.location.href);
              toast.success('Notepad link copied to clipboard');
            }}
            className="h-8 px-[18px] chamfer-btn bg-[var(--accent)] text-[var(--accent-ink)] flex items-center text-[12px] font-display uppercase tracking-[0.08em] hover:brightness-110 transition cursor-pointer"
          >
            Share
          </button>

          <div className="lg:hidden">
            <DocumentOutline editor={editor} containerRef={containerRef} variant="floating" />
          </div>

          {exportMenuNode}
        </div>
      </div>

      {/* Elevated Chamfered Surface Card */}
      <div className="flex-1 chamfer-lg bg-[var(--surface)] px-6 sm:pl-10 sm:pr-9 pt-11 pb-24 flex gap-7 min-h-[calc(100vh-84px)]">
        <div className="flex-1 min-w-0 flex flex-col gap-5">
          {bannersNode}
          {titleNode}
          {starterTemplateNode}
          <div className="w-full border-t border-[var(--hair)] pt-4 min-h-[350px]">
            {blockNoteViewNode}
          </div>
          {backlinksNode}
        </div>

        <div className="hidden lg:block">
          <DocumentOutline editor={editor} containerRef={containerRef} variant="inline" />
        </div>
      </div>

      {/* Floating Bottom Command Bar */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('burrow:open-palette'))}
        className="no-print fixed bottom-7 left-1/2 -translate-x-1/2 z-20 hidden md:flex items-center gap-2.5 h-[42px] pl-4 pr-2.5 bg-[var(--side)] border border-[var(--line)] float-command-bar text-[var(--ink-muted)] hover:text-[var(--text)] hover:border-[var(--accent)] font-semibold text-[13px] transition cursor-pointer"
      >
        <Search className="w-4 h-4 shrink-0" />
        <span className="w-[200px] text-left">Search or command</span>
        <span className="border border-[var(--line)] px-2 py-0.5 text-[11px] text-[var(--text)]">
          Ctrl+K
        </span>
      </button>

      {dialogsNode}
    </div>
  );
}

export function NotepadEditor({
  workspaceId,
  notepadId,
  projectId,
  hideTitle = false,
  hideFavorite = false,
}: NotepadEditorProps) {
  const { data: account } = useAccount();
  const [reloadKey, setReloadKey] = useState(0);
  const [displayedData, setDisplayedData] = useState<NotepadData | null>(null);
  const {
    data,
    isPending: loading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['notepad', account?.user.id, workspaceId, projectId, notepadId],
    enabled: Boolean(account?.user.id),
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(
        projectApiPath(workspaceId, projectId, `notepads/${notepadId}`),
        {
          signal,
        },
      );
      if (!response.ok) throw new Error('This notepad is unavailable in this project.');
      const note = (await response.json()) as NotepadData;
      if (
        note.id !== notepadId ||
        note.projectId !== projectId ||
        note.workspaceId !== workspaceId
      ) {
        throw new Error('This notepad is unavailable in this project.');
      }
      return note;
    },
  });

  useEffect(() => {
    if (data && (!displayedData || sameNotepadScope(data, displayedData))) {
      setDisplayedData(data);
    }
  }, [data, displayedData]);

  const activeData = displayedData ?? data ?? null;
  const pendingData = data && activeData && !sameNotepadScope(data, activeData) ? data : undefined;

  if (!activeData && loading) {
    return (
      <div
        className={
          hideTitle ? 'w-full space-y-4' : 'w-full max-w-4xl mx-auto py-8 px-6 sm:px-14 space-y-6'
        }
      >
        <div className="h-8 w-48 bg-[var(--surface2)] animate-pulse" />
        <div className="h-64 bg-[var(--surface2)] animate-pulse" />
      </div>
    );
  }

  if (!activeData) {
    return (
      <div className="w-full p-12 max-w-xl mx-auto text-center space-y-4">
        <div className="text-4xl">📄</div>
        <h2 className="text-lg font-semibold text-[var(--text)]">Notepad Unavailable</h2>
        <p className="text-xs text-[var(--muted)]">
          {error?.message || 'This notepad is no longer available.'}
        </p>
      </div>
    );
  }

  return (
    <ReferenceScopeProvider
      value={{ workspaceId: activeData.workspaceId, projectId: activeData.projectId }}
    >
      <NotepadEditorInner
        key={`${activeData.workspaceId}-${activeData.projectId}-${activeData.id}-${reloadKey}`}
        initialData={activeData}
        pendingData={pendingData}
        hideTitle={hideTitle}
        hideFavorite={hideFavorite}
        onScopeSwitchComplete={setDisplayedData}
        onReload={async () => {
          const result = await refetch();
          if (result.error) toast.error(result.error.message);
          else setReloadKey((key) => key + 1);
        }}
      />
    </ReferenceScopeProvider>
  );
}

export default NotepadEditor;
