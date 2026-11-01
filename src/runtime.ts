import { AsyncLocalStorage } from "node:async_hooks";
import type { CacheEntry } from "@rebask/core/cache";

export interface CacheRpc {
  generation(): Promise<number>;
  finishInvalidation(): Promise<void>;
  lookup(
    key: string,
    seedTags: string[],
  ): Promise<{ entry: CacheEntry | null; epoch: number; blocked: boolean }>;
  write(
    key: string,
    entry: CacheEntry,
    epoch: number,
    token?: string,
  ): Promise<boolean>;
  remove(key: string): Promise<void>;
  invalidate(tag: string): Promise<void>;
  claim(key: string): Promise<{ token: string; epoch: number } | null>;
  release(key: string, token: string): Promise<void>;
}
export interface CacheNamespace {
  getByName(name: string): CacheRpc;
}
interface CacheContext {
  namespace: CacheNamespace;
  draft: boolean;
  pageFreshUntil: number;
  waitUntil: (promise: Promise<unknown>) => void;
  epochs: Map<string, number>;
  leases: Map<string, string>;
}
const requests = new AsyncLocalStorage<CacheContext>();
export function cacheContext() {
  const context = requests.getStore();
  if (!context)
    throw new Error(
      "Durable cache requires the generated Worker request context",
    );
  return context;
}
export function withCacheRequest<T>(
  namespace: CacheNamespace,
  waitUntil: CacheContext["waitUntil"],
  task: () => T,
  draft = false,
): T {
  return requests.run(
    {
      namespace,
      waitUntil,
      draft,
      pageFreshUntil: Infinity,
      epochs: new Map(),
      leases: new Map(),
    },
    task,
  );
}
/** Native Rebask background refreshes must survive the HTTP response on Workers. */
export function runCacheTask(task: () => Promise<void>): void {
  const parent = requests.getStore();
  if (!parent) {
    void task();
    return;
  }
  requests.run({ ...parent, epochs: new Map(), leases: new Map() }, () => {
    parent.waitUntil(task());
  });
}
export function keepCacheWrite<T>(promise: Promise<T>): Promise<T> {
  requests.getStore()?.waitUntil(promise);
  return promise;
}

/** Adapter Draft Mode; authorization to unpublished content remains app-owned. */
export function isDraftMode(): boolean {
  return requests.getStore()?.draft ?? false;
}
export function notePageEntry(entry: CacheEntry | null) {
  const context = requests.getStore();
  if (
    context &&
    entry?.type === 2 &&
    !(entry as { postponed?: unknown }).postponed
  )
    context.pageFreshUntil = Math.min(
      context.pageFreshUntil,
      entry.timestamp + entry.revalidate * 1000,
    );
}
export function pageFreshUntil() {
  return requests.getStore()?.pageFreshUntil ?? 0;
}
