import { DurableObject } from "cloudflare:workers";
import type { CacheEntry } from "@rebask/core/cache";
import { CacheShard } from "./shard.js";

export class RebaskCache extends DurableObject<unknown> {
  private shard: CacheShard;
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.shard = new CacheShard(ctx.storage.sql, (task) =>
      ctx.storage.transactionSync(task),
    );
  }
  lookup(key: string, seedTags: string[]) {
    return this.shard.lookup(key, seedTags);
  }
  async write(key: string, entry: CacheEntry, epoch: number, token?: string) {
    const result = this.shard.write(key, entry, epoch, token);
    if (result && (await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    return result;
  }
  remove(key: string) {
    this.shard.remove(key);
  }
  invalidate(tag: string) {
    this.shard.invalidate(tag);
  }
  claim(key: string) {
    return this.shard.claim(key);
  }
  release(key: string, token: string) {
    this.shard.release(key, token);
  }
  alarm() {
    this.shard.sweep();
  }
}
