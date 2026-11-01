import { createHash } from "node:crypto";
import { BaseCacheStorage, type CacheEntry } from "@rebask/core/cache";
import type { BuildArtifacts } from "./storage.js";
import {
  cacheContext,
  keepCacheWrite,
  isDraftMode,
  notePageEntry,
} from "./runtime.js";
import { SHARDS } from "./shard.js";

export class DurableCacheStorage extends BaseCacheStorage {
  constructor(private artifacts: BuildArtifacts) {
    super();
  }
  private address(key: string) {
    const [kind, deployment] = key.split(":");
    if (!(
      kind === "dd" ||
      (["ph", "pr", "ps", "pm", "du"].includes(kind!) &&
        deployment === this.artifacts.deploymentId)
    ))
      return null;
    const hash = createHash("sha256").update(key).digest("hex");
    const shard = `rebask-cache-v1-${hash[0]}`;
    return { hash, shard };
  }
  private seed(key: string, hash: string): CacheEntry | null {
    const entry = this.artifacts.entries[hash];
    const expected: Record<string, number[]> = {
      ph: [2],
      pr: [1],
      ps: [1],
      pm: [5],
      du: [3],
      dd: [4],
    };
    return entry && expected[key.split(":")[0]!]!.includes(entry.type)
      ? structuredClone(entry)
      : null;
  }
  protected async read(key: string): Promise<CacheEntry | null> {
    if (isDraftMode()) return null;
    const address = this.address(key);
    if (!address) return null;
    const context = cacheContext(),
      seed = this.seed(key, address.hash);
    const result = await context.namespace
      .getByName(address.shard)
      .lookup(address.hash, seed?.tags ?? []);
    // Keep the earliest observed epoch for this request/task. Never refresh it
    // after an invalidation: an older concurrent computation could write later.
    if (!context.epochs.has(address.shard))
      context.epochs.set(address.shard, result.epoch);
    const entry = result.entry ?? (result.blocked ? null : seed);
    notePageEntry(entry);
    return entry;
  }
  async set(key: string, entry: CacheEntry) {
    if (isDraftMode()) return;
    const address = this.address(key);
    if (!address) return;
    const expected: Record<string, number[]> = {
      ph: [2],
      pr: [1],
      ps: [1],
      pm: [5],
      du: [3],
      dd: [4],
    };
    if (!expected[key.split(":")[0]!]!.includes(entry.type)) return;
    const context = cacheContext(),
      epoch = context.epochs.get(address.shard);
    // No pre-computation read or regeneration claim => no safe generation fence.
    if (epoch === undefined) return;
    await keepCacheWrite(
      context.namespace
        .getByName(address.shard)
        .write(address.hash, entry, epoch, context.leases.get(key)),
    );
  }
  async delete(key: string) {
    const address = this.address(key);
    if (!address) return;
    await keepCacheWrite(
      cacheContext().namespace.getByName(address.shard).remove(address.hash),
    );
  }
  async revalidateTag(tag: string) {
    const context = cacheContext();
    await keepCacheWrite(
      Promise.all(
        Array.from({ length: SHARDS }, (_, i) =>
          context.namespace
            .getByName(`rebask-cache-v1-${i.toString(16)}`)
            .invalidate(tag),
        ),
      ).then(() =>
        context.namespace.getByName("rebask-cache-v1-0").finishInvalidation(),
      ),
    );
  }
  async tryClaim(key: string) {
    if (isDraftMode()) return null;
    const address = this.address(key);
    if (!address) return null;
    const context = cacheContext(),
      stub = context.namespace.getByName(address.shard);
    const claim = await stub.claim(address.hash);
    if (!claim) return null;
    if (!context.epochs.has(address.shard))
      context.epochs.set(address.shard, claim.epoch);
    context.leases.set(key, claim.token);
    return async () => {
      if (context.leases.get(key) === claim.token) context.leases.delete(key);
      await keepCacheWrite(stub.release(address.hash, claim.token));
    };
  }
}
