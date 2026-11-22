import { AsyncLocalStorage } from 'node:async_hooks';
import type { BurrowEventMap } from '@burrow/sdk';

export type BeforeEventHandler<K extends keyof BurrowEventMap> = (
  payload: BurrowEventMap[K],
) => Promise<void> | void;

export type AfterEventHandler<K extends keyof BurrowEventMap> = (
  payload: BurrowEventMap[K],
) => Promise<void> | void;

export interface EventExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

const executionContextStorage = new AsyncLocalStorage<EventExecutionContext>();

export function runWithEventExecutionContext<T>(
  ctx: EventExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return executionContextStorage.run(ctx, fn);
}

/**
 * Typed domain event bus separating synchronous pre-action guards (`before*`)
 * from post-commit async handlers (`after*` dispatched via `ExecutionContext.waitUntil`).
 */
export class PluginEventBus {
  private readonly beforeHandlers = new Map<
    keyof BurrowEventMap,
    Array<BeforeEventHandler<any>>
  >();
  private readonly afterHandlers = new Map<
    keyof BurrowEventMap,
    Array<AfterEventHandler<any>>
  >();
  private readonly pendingTasks = new Set<Promise<void>>();

  onBefore<K extends keyof BurrowEventMap>(event: K, handler: BeforeEventHandler<K>): () => void {
    const list = this.beforeHandlers.get(event) ?? [];
    list.push(handler as BeforeEventHandler<any>);
    this.beforeHandlers.set(event, list);
    return () => {
      const current = this.beforeHandlers.get(event);
      if (!current) return;
      const idx = current.indexOf(handler as BeforeEventHandler<any>);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  on<K extends keyof BurrowEventMap>(event: K, handler: AfterEventHandler<K>): () => void {
    const list = this.afterHandlers.get(event) ?? [];
    list.push(handler as AfterEventHandler<any>);
    this.afterHandlers.set(event, list);
    return () => {
      const current = this.afterHandlers.get(event);
      if (!current) return;
      const idx = current.indexOf(handler as AfterEventHandler<any>);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /** Run pre-action guards sequentially before the core write executes. Errors abort the request. */
  async emitBefore<K extends keyof BurrowEventMap>(
    event: K,
    payload: BurrowEventMap[K],
  ): Promise<void> {
    const handlers = this.beforeHandlers.get(event);
    if (!handlers || handlers.length === 0) return;
    for (const handler of [...handlers]) {
      await handler(payload);
    }
  }

  /**
   * Dispatch post-commit listeners without affecting the already-committed operation.
   * Uses `ctx.waitUntil` when inside a Cloudflare Worker request, or awaits deterministically otherwise.
   */
  async emitAfter<K extends keyof BurrowEventMap>(
    event: K,
    payload: BurrowEventMap[K],
    explicitWaitUntil?: (promise: Promise<unknown>) => void,
  ): Promise<void> {
    const handlers = this.afterHandlers.get(event);
    if (!handlers || handlers.length === 0) return;

    const snapshot = [...handlers];
    const runPromise = Promise.allSettled(
      snapshot.map((handler) => Promise.resolve().then(() => handler(payload))),
    ).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(`[plugins:event] "${String(event)}" handler failed:`, result.reason);
        }
      }
    });

    this.pendingTasks.add(runPromise);
    const tracked = runPromise.finally(() => {
      this.pendingTasks.delete(runPromise);
    });

    const waitUntil = explicitWaitUntil ?? executionContextStorage.getStore()?.waitUntil;
    if (waitUntil) {
      waitUntil(tracked);
      return;
    }

    await tracked;
  }

  /** Await any pending background `waitUntil` plugin tasks (primarily for tests). */
  async flushPending(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks]);
    }
  }
}
