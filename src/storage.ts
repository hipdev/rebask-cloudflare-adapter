import { createHash } from "node:crypto";
import { BaseCacheStorage, type CacheEntry } from "@rebask/core/cache";

export interface BuildArtifacts {
  deploymentId: string;
  durableCache?: boolean;
  manifest: Record<string, unknown>;
  entries: Record<string, CacheEntry>;
}

// Only immutable build output is shared. Runtime renders, auth, permissions and
// use-cache data are never retained by this adapter.
export class BuildArtifactStorage extends BaseCacheStorage {
  constructor(private readonly artifacts: BuildArtifacts) {
    super();
  }
  protected async read(key: string): Promise<CacheEntry | null> {
    if (
      !/^(ph|pr|ps):/.test(key) ||
      key.split(":")[1] !== this.artifacts.deploymentId
    )
      return null;
    const entry =
      this.artifacts.entries[createHash("sha256").update(key).digest("hex")];
    if (!entry || (entry.type !== 1 && entry.type !== 2)) return null;
    return structuredClone(entry);
  }
  async set() {}
  async delete() {}
  async revalidateTag() {
    throw new Error(
      "Worker build artifacts are immutable; tagged runtime caching requires a separate durable storage adapter.",
    );
  }
  async tryClaim() {
    return null;
  }
}
