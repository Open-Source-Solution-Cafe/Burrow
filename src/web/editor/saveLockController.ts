export interface EditorScope {
  workspaceId: string;
  projectId: string;
  notepadId: string;
  clientId: string;
}

export type EditorSaveStatus = 'saved' | 'saving' | 'error' | 'conflict';

export interface SaveLockState {
  scope: EditorScope;
  savedContent: string;
  dirtyContent: string | null;
  status: EditorSaveStatus;
  version: number;
  pendingScope: EditorScope | null;
  error: Error | null;
}

export class SaveConflictError extends Error {
  constructor(message = 'The document changed elsewhere') {
    super(message);
    this.name = 'SaveConflictError';
  }
}

export function createSaveLockState(
  scope: EditorScope,
  savedContent: string,
  version: number,
): SaveLockState {
  return {
    scope: { ...scope },
    savedContent,
    dirtyContent: null,
    status: 'saved',
    version,
    pendingScope: null,
    error: null,
  };
}

export function setDirtyContent(state: SaveLockState, content: string): SaveLockState {
  return content === state.savedContent
    ? { ...state, dirtyContent: null, status: 'saved', error: null }
    : { ...state, dirtyContent: content, status: 'saving', error: null };
}

export function saveSucceeded(
  state: SaveLockState,
  content: string,
  version: number,
): SaveLockState {
  return {
    ...state,
    savedContent: content,
    dirtyContent: state.dirtyContent === content ? null : state.dirtyContent,
    version,
    status: state.dirtyContent === content ? 'saved' : 'saving',
    error: null,
  };
}

export function saveFailed(state: SaveLockState, error: Error): SaveLockState {
  return {
    ...state,
    status: error instanceof SaveConflictError ? 'conflict' : 'error',
    error,
  };
}

export function discardDirtyContent(state: SaveLockState): SaveLockState {
  return { ...state, dirtyContent: null, status: 'saved', error: null };
}

interface SaveLockControllerOptions {
  scope: EditorScope;
  savedContent: string;
  version: number;
  save: (
    scope: EditorScope,
    content: string,
    version: number,
    keepalive: boolean,
  ) => Promise<{ version: number }>;
  release: (scope: EditorScope, keepalive: boolean) => Promise<void>;
  onStateChange?: (state: SaveLockState) => void;
  onScopeSwitched?: (scope: EditorScope) => void;
  debounceMs?: number;
  retryMs?: number;
}

/** Owns the single pending-save queue, its timers, and scoped lock handoff. */
export class SaveLockController {
  private state: SaveLockState;
  private readonly options: SaveLockControllerOptions;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private releaseInFlight: Promise<boolean> | null = null;
  private switchInFlight: Promise<boolean> | null = null;

  constructor(options: SaveLockControllerOptions) {
    this.options = options;
    this.state = createSaveLockState(options.scope, options.savedContent, options.version);
  }

  getState(): SaveLockState {
    return this.state;
  }

  get isDirty(): boolean {
    return this.state.dirtyContent !== null;
  }

  setVersion(version: number): void {
    this.update({ ...this.state, version });
  }

  schedule(content: string): void {
    this.update(setDirtyContent(this.state, content));
    this.clearRetry();
    this.clearDebounce();
    if (!this.state.dirtyContent) {
      if (this.state.pendingScope) void this.retry();
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.retry();
    }, this.options.debounceMs ?? 800);
  }

  async saveNow(content: string, keepalive = false): Promise<boolean> {
    this.update(setDirtyContent(this.state, content));
    this.clearDebounce();
    return this.retry(keepalive);
  }

  async retry(keepalive = false): Promise<boolean> {
    this.clearDebounce();
    this.clearRetry();
    const saved = await this.flush(keepalive);
    if (!saved) return false;
    if (this.state.pendingScope) return this.completeScopeSwitch(keepalive);
    return true;
  }

  async switchScope(nextScope: EditorScope): Promise<boolean> {
    if (sameScope(this.state.scope, nextScope)) return true;
    this.clearDebounce();
    this.update({ ...this.state, pendingScope: { ...nextScope } });
    return this.retry();
  }

  async releaseCurrent(keepalive = false): Promise<boolean> {
    if (this.releaseInFlight) return this.releaseInFlight;
    if (this.state.pendingScope) return this.retry(keepalive);
    const release = (async () => {
      const saved = await this.retry(keepalive);
      if (!saved) return false;
      try {
        await this.options.release({ ...this.state.scope }, keepalive);
        return true;
      } catch (error) {
        this.update(saveFailed(this.state, asError(error, 'Failed to release edit lock')));
        this.scheduleRetry();
        return false;
      } finally {
        this.releaseInFlight = null;
      }
    })();
    this.releaseInFlight = release;
    return release;
  }

  discard(): string {
    this.clearDebounce();
    this.clearRetry();
    const savedContent = this.state.savedContent;
    this.update(discardDirtyContent(this.state));
    if (this.state.pendingScope) void this.completeScopeSwitch(false);
    return savedContent;
  }

  dispose(): void {
    this.clearDebounce();
    this.clearRetry();
  }

  private async flush(keepalive: boolean): Promise<boolean> {
    if (this.inFlight) {
      const finished = await this.inFlight;
      if (!finished) return false;
      if (this.state.dirtyContent) return this.flush(keepalive);
      return true;
    }
    const content = this.state.dirtyContent;
    if (content === null) return true;
    const scope = { ...this.state.scope };
    const version = this.state.version;
    this.update({ ...this.state, status: 'saving', error: null });
    const operation = (async () => {
      try {
        const result = await this.options.save(scope, content, version, keepalive);
        this.update(saveSucceeded(this.state, content, result.version));
        return true;
      } catch (error) {
        this.update(saveFailed(this.state, asError(error, 'Failed to save document')));
        if (!(error instanceof SaveConflictError)) this.scheduleRetry();
        return false;
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = operation;
    const saved = await operation;
    if (!saved) return false;
    if (this.state.dirtyContent !== null) return this.flush(keepalive);
    return true;
  }

  private async completeScopeSwitch(keepalive: boolean): Promise<boolean> {
    if (this.switchInFlight) return this.switchInFlight;
    if (!this.state.pendingScope) return true;
    const previousScope = { ...this.state.scope };
    const switching = (async () => {
      try {
        await this.options.release(previousScope, keepalive);
      } catch (error) {
        this.update(saveFailed(this.state, asError(error, 'Failed to release edit lock')));
        this.scheduleRetry();
        return false;
      } finally {
        this.switchInFlight = null;
      }
      const nextScope = this.state.pendingScope;
      if (!nextScope) return true;
      this.update({
        ...this.state,
        scope: { ...nextScope },
        pendingScope: null,
        status: 'saved',
        error: null,
      });
      this.options.onScopeSwitched?.({ ...nextScope });
      return true;
    })();
    this.switchInFlight = switching;
    return switching;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retry();
    }, this.options.retryMs ?? 3_000);
  }

  private clearDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private update(state: SaveLockState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}

function sameScope(left: EditorScope, right: EditorScope): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.notepadId === right.notepadId &&
    left.clientId === right.clientId
  );
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
