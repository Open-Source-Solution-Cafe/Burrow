import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveLockController, type EditorScope } from './saveLockController';

const oldScope: EditorScope = {
  workspaceId: 'workspace-old',
  projectId: 'project-old',
  notepadId: 'notepad-old',
  clientId: 'client-tab',
};
const nextScope: EditorScope = {
  workspaceId: 'workspace-next',
  projectId: 'project-next',
  notepadId: 'notepad-next',
  clientId: 'client-tab',
};

afterEach(() => vi.useRealTimers());

describe('SaveLockController', () => {
  it('flushes pending editor content before releasing the captured old scope', async () => {
    vi.useFakeTimers();
    const events: unknown[] = [];
    const switched = vi.fn();
    const controller = new SaveLockController({
      scope: oldScope,
      savedContent: 'saved',
      version: 4,
      debounceMs: 800,
      retryMs: 60_000,
      save: async (scope, content, version, keepalive) => {
        events.push(['save', scope, content, version, keepalive]);
        return { version: version + 1 };
      },
      release: async (scope, keepalive) => {
        events.push(['release', scope, keepalive]);
      },
      onScopeSwitched: switched,
    });

    controller.schedule('latest edit');
    await expect(controller.switchScope(nextScope)).resolves.toBe(true);
    expect(events).toEqual([
      ['save', oldScope, 'latest edit', 4, false],
      ['release', oldScope, false],
    ]);
    expect(switched).toHaveBeenCalledWith(nextScope);
    expect(controller.getState()).toMatchObject({
      scope: nextScope,
      savedContent: 'latest edit',
      dirtyContent: null,
      status: 'saved',
    });
    controller.dispose();
  });

  it('waits for an in-flight save before releasing the original scope and switching', async () => {
    let resolveSave!: (result: { version: number }) => void;
    const savePending = new Promise<{ version: number }>((resolve) => {
      resolveSave = resolve;
    });
    const events: unknown[] = [];
    const switched = vi.fn();
    const controller = new SaveLockController({
      scope: oldScope,
      savedContent: 'saved',
      version: 4,
      save: async (scope, content, version, keepalive) => {
        events.push(['save-start', scope, content, version, keepalive]);
        const result = await savePending;
        events.push(['save-finished', scope, result.version]);
        return result;
      },
      release: async (scope, keepalive) => {
        events.push(['release', scope, keepalive]);
      },
      onScopeSwitched: switched,
    });

    const save = controller.saveNow('latest edit');
    expect(events).toEqual([['save-start', oldScope, 'latest edit', 4, false]]);

    const switchScope = controller.switchScope(nextScope);
    expect(controller.getState()).toMatchObject({
      scope: oldScope,
      pendingScope: nextScope,
      status: 'saving',
    });
    expect(events).toEqual([['save-start', oldScope, 'latest edit', 4, false]]);
    expect(switched).not.toHaveBeenCalled();

    resolveSave({ version: 5 });
    await expect(save).resolves.toBe(true);
    await expect(switchScope).resolves.toBe(true);

    expect(events).toEqual([
      ['save-start', oldScope, 'latest edit', 4, false],
      ['save-finished', oldScope, 5],
      ['release', oldScope, false],
    ]);
    expect(switched).toHaveBeenCalledWith(nextScope);
    expect(controller.getState()).toMatchObject({
      scope: nextScope,
      savedContent: 'latest edit',
      dirtyContent: null,
      version: 5,
      status: 'saved',
    });
    controller.dispose();
  });

  it('keeps failed content dirty for retry and exposes discard to restore the last saved text', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'));
    const controller = new SaveLockController({
      scope: oldScope,
      savedContent: 'last saved',
      version: 2,
      retryMs: 60_000,
      save: async (...args) => {
        await save(...args);
        return { version: 3 };
      },
      release: async () => {},
    });

    await expect(controller.saveNow('unsaved draft')).resolves.toBe(false);
    expect(controller.getState()).toMatchObject({
      dirtyContent: 'unsaved draft',
      savedContent: 'last saved',
      status: 'error',
    });
    expect(controller.discard()).toBe('last saved');
    expect(controller.getState()).toMatchObject({ dirtyContent: null, status: 'saved' });

    await expect(controller.saveNow('retry draft')).resolves.toBe(false);
    expect(controller.getState()).toMatchObject({ dirtyContent: 'retry draft', status: 'error' });
    await expect(controller.retry()).resolves.toBe(true);
    expect(controller.getState()).toMatchObject({
      dirtyContent: null,
      savedContent: 'retry draft',
      status: 'saved',
    });
    controller.dispose();
  });

  it('keeps dirty content and the old lock scope when a scope handoff save fails', async () => {
    const controller = new SaveLockController({
      scope: oldScope,
      savedContent: 'saved',
      version: 1,
      retryMs: 60_000,
      save: async () => {
        throw new Error('offline');
      },
      release: vi.fn(),
    });
    controller.schedule('keep this draft');

    await expect(controller.switchScope(nextScope)).resolves.toBe(false);
    expect(controller.getState()).toMatchObject({
      scope: oldScope,
      pendingScope: nextScope,
      dirtyContent: 'keep this draft',
      status: 'error',
    });
    controller.dispose();
  });
});
