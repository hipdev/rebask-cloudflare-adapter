import { AsyncLocalStorage } from "node:async_hooks";
import type { CacheEntry } from "@rebask/core/cache";

export interface CacheRpc {
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
): T {
  return requests.run(
    { namespace, waitUntil, epochs: new Map(), leases: new Map() },
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
