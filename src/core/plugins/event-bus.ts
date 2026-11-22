import { AsyncLocalStorage } from 'node:async_hooks';
import type { BurrowEventMap } from '@burrow/sdk';
import { redactSecrets } from './logger';

export type BeforeEventHandler<K extends keyof BurrowEventMap> = (
  payload: BurrowEventMap[K],
) => Promise<void> | void;

export type AfterEventHandler<K extends keyof BurrowEventMap> = (
  payload: BurrowEventMap[K],
) => Promise<void> | void;

export interface EventExecutionContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface EventHandlerOptions {
  pluginId?: string;
  isEnabled?: () => boolean;
  timeoutMs?: number;
  secretValues?: readonly string[];
  firstPartyCore?: boolean;
}

interface RegisteredBeforeHandler {
  pluginId: string;
  handler: BeforeEventHandler<any>;
  isEnabled?: () => boolean;
  timeoutMs: number;
  firstPartyCore: boolean;
}

interface RegisteredAfterHandler {
  pluginId: string;
  handler: AfterEventHandler<any>;
  isEnabled?: () => boolean;
  timeoutMs: number;
  secretValues: readonly string[];
}

const DEFAULT_BEFORE_TIMEOUT_MS = 2_500;
const DEFAULT_AFTER_TIMEOUT_MS = 5_000;
const MAX_LISTENERS_PER_EVENT = 50;

function cloneEventValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (seen.has(value as object)) return seen.get(value as object) as T;
  if (Array.isArray(value)) {
    const arr: unknown[] = [];
    seen.set(value, arr);
    for (const item of value) arr.push(cloneEventValue(item, seen));
    return arr as unknown as T;
  }
  const out: Record<string, unknown> = {};
  seen.set(value as object, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = cloneEventValue(v, seen);
  }
  return out as T;
}

function deepFreezeValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeValue(item, seen);
  } else {
    for (const val of Object.values(value as Record<string, unknown>)) {
      deepFreezeValue(val, seen);
    }
  }
  return Object.freeze(value);
}

const executionContextStorage = new AsyncLocalStorage<EventExecutionContext>();

export function runWithEventExecutionContext<T>(
  ctx: EventExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  return executionContextStorage.run(ctx, fn);
}

async function runWithTimeout<T>(fn: () => Promise<T> | T, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Typed domain event bus separating synchronous pre-action guards (`before*`)
 * from post-commit async handlers (`after*` dispatched off the hot path).
 */
export class PluginEventBus {
  private readonly beforeHandlers = new Map<keyof BurrowEventMap, RegisteredBeforeHandler[]>();
  private readonly afterHandlers = new Map<keyof BurrowEventMap, RegisteredAfterHandler[]>();
  private readonly pendingTasks = new Set<Promise<void>>();

  onBefore<K extends keyof BurrowEventMap>(
    event: K,
    handler: BeforeEventHandler<K>,
    options: EventHandlerOptions = {},
  ): () => void {
    const entry: RegisteredBeforeHandler = {
      pluginId: options.pluginId ?? 'core',
      handler: handler as BeforeEventHandler<any>,
      isEnabled: options.isEnabled,
      timeoutMs: options.timeoutMs ?? DEFAULT_BEFORE_TIMEOUT_MS,
      firstPartyCore: Boolean(options.firstPartyCore),
    };
    const list = this.beforeHandlers.get(event) ?? [];
    if (list.length >= MAX_LISTENERS_PER_EVENT) {
      throw new Error(
        `Maximum listener limit (${MAX_LISTENERS_PER_EVENT}) exceeded for event "${String(event)}"`,
      );
    }
    list.push(entry);
    this.beforeHandlers.set(event, list);
    return () => {
      const current = this.beforeHandlers.get(event);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  on<K extends keyof BurrowEventMap>(
    event: K,
    handler: AfterEventHandler<K>,
    options: EventHandlerOptions = {},
  ): () => void {
    const entry: RegisteredAfterHandler = {
      pluginId: options.pluginId ?? 'core',
      handler: handler as AfterEventHandler<any>,
      isEnabled: options.isEnabled,
      timeoutMs: options.timeoutMs ?? DEFAULT_AFTER_TIMEOUT_MS,
      secretValues: options.secretValues ?? [],
    };
    const list = this.afterHandlers.get(event) ?? [];
    if (list.length >= MAX_LISTENERS_PER_EVENT) {
      throw new Error(
        `Maximum listener limit (${MAX_LISTENERS_PER_EVENT}) exceeded for event "${String(event)}"`,
      );
    }
    list.push(entry);
    this.afterHandlers.set(event, list);
    return () => {
      const current = this.afterHandlers.get(event);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  /** Run pre-action guards sequentially before the core write executes. Errors or timeouts abort the request. */
  async emitBefore<K extends keyof BurrowEventMap>(
    event: K,
    payload: BurrowEventMap[K],
  ): Promise<void> {
    const handlers = this.beforeHandlers.get(event);
    if (!handlers || handlers.length === 0) return;
    let lockedInitialExportKeys = false;
    for (const entry of [...handlers]) {
      if (entry.isEnabled && !entry.isEnabled()) continue;
      let argPayload: BurrowEventMap[K];
      if (entry.firstPartyCore) {
        if (
          !lockedInitialExportKeys &&
          payload &&
          typeof payload === 'object' &&
          'payload' in payload &&
          (payload as { payload?: unknown }).payload &&
          typeof (payload as { payload: unknown }).payload === 'object'
        ) {
          const inner = (payload as { payload: Record<string, unknown> }).payload;
          for (const k of Object.keys(inner)) {
            const val = inner[k];
            deepFreezeValue(val);
            Object.defineProperty(inner, k, {
              value: val,
              writable: false,
              configurable: false,
              enumerable: true,
            });
          }
          lockedInitialExportKeys = true;
        }
        argPayload = payload;
      } else {
        argPayload = cloneEventValue(payload);
      }
      await runWithTimeout(
        () => entry.handler(argPayload),
        entry.timeoutMs,
        `Plugin "${entry.pluginId}" before:${String(event)}`,
      );
    }
  }

  /**
   * Dispatch post-commit listeners without blocking or failing the already-committed operation.
   * Uses `ctx.waitUntil` in Workers or a non-blocking microtask queue in Node/Postgres.
   */
  async emitAfter<K extends keyof BurrowEventMap>(
    event: K,
    payload: BurrowEventMap[K],
    explicitWaitUntil?: (promise: Promise<unknown>) => void,
  ): Promise<void> {
    const handlers = this.afterHandlers.get(event);
    if (!handlers || handlers.length === 0) return;

    const active = [...handlers].filter((entry) => !entry.isEnabled || entry.isEnabled());
    if (active.length === 0) return;

    const executeAll = async () => {
      const results = await Promise.allSettled(
        active.map((entry) =>
          runWithTimeout(
            () => entry.handler(deepFreezeValue(cloneEventValue(payload))),
            entry.timeoutMs,
            `Plugin "${entry.pluginId}" after:${String(event)}`,
          ),
        ),
      );
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          const entry = active[i]!;
          const rawMsg =
            result.reason instanceof Error ? result.reason.message : String(result.reason ?? 'error');
          console.error(
            `[plugins:event:${entry.pluginId}] "${String(event)}" handler failed:`,
            redactSecrets(rawMsg, entry.secretValues),
          );
        }
      });
    };

    const waitUntil = explicitWaitUntil ?? executionContextStorage.getStore()?.waitUntil;
    if (waitUntil) {
      const runPromise = executeAll();
      this.pendingTasks.add(runPromise);
      const tracked = runPromise.finally(() => {
        this.pendingTasks.delete(runPromise);
      });
      waitUntil(tracked);
      return;
    }

    // Off hot path in Node/Postgres runtimes: schedule asynchronously without blocking response
    const bgPromise = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        void executeAll().finally(resolve);
      });
    });
    this.pendingTasks.add(bgPromise);
    void bgPromise.finally(() => {
      this.pendingTasks.delete(bgPromise);
    });
  }

  /** Await any pending background `waitUntil` or microtask plugin jobs (primarily for tests). */
  async flushPending(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks]);
    }
  }
}
