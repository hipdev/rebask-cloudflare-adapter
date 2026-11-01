import type { CacheEntry } from "@rebask/core/cache";

export const SHARDS = 16;
export const MAX_ENTRY_BYTES = 1_000_000;
export const LEASE_MS = 30_000;
const YEAR_MS = 31_536_000_000;
interface Row {
  [column: string]: SqlStorageValue;
  key: string;
  payload: string | null;
  expires: number;
  bytes: number;
  epoch: number;
  touched: number;
}
/** SQL-only coordination atom; used by the Durable Object and real SQLite tests. */
export class CacheShard {
  constructor(
    private sql: Pick<SqlStorage, "exec">,
    private transaction: <T>(task: () => T) => T,
    private now = Date.now,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES (1,0);
      CREATE TABLE IF NOT EXISTS tags (tag TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (key TEXT PRIMARY KEY, payload TEXT, expires INTEGER NOT NULL, bytes INTEGER NOT NULL, epoch INTEGER NOT NULL, touched INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_expiry ON entries(expires);
      CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, token TEXT NOT NULL, until INTEGER NOT NULL);`);
  }
  generation() {
    return this.epoch();
  }
  finishInvalidation() {
    this.sql.exec("UPDATE meta SET epoch=epoch+1 WHERE id=1");
  }
  private epoch(): number {
    return this.sql
      .exec<{ epoch: number }>("SELECT epoch FROM meta WHERE id=1")
      .one().epoch;
  }
  private tagsAfter(tags: string[], epoch: number): boolean {
    return tags.some(
      (tag) =>
        (this.sql
          .exec<{ epoch: number }>("SELECT epoch FROM tags WHERE tag=?", tag)
          .toArray()[0]?.epoch ?? 0) > epoch,
    );
  }
  private validTags(tags: string[]) {
    if (
      tags.length > 64 ||
      tags.some((tag) => typeof tag !== "string" || tag.length > 256)
    )
      throw new Error("Cache tags exceed supported bounds");
  }
  lookup(key: string, seedTags: string[]) {
    this.validTags(seedTags);
    return this.transaction(() => {
      const epoch = this.epoch();
      const row = this.sql
        .exec<Row>("SELECT * FROM entries WHERE key=?", key)
        .toArray()[0];
      if (row && row.expires > this.now()) {
        if (!row.payload) return { entry: null, epoch, blocked: true };
        const entry = JSON.parse(row.payload) as CacheEntry;
        if (this.tagsAfter(entry.tags ?? [], row.epoch)) {
          this.sql.exec(
            "UPDATE entries SET payload=NULL,bytes=0,expires=? WHERE key=?",
            this.now() + YEAR_MS,
            key,
          );
          return { entry: null, epoch, blocked: true };
        }
        return { entry, epoch, blocked: false };
      }
      if (row) {
        this.sql.exec(
          "UPDATE entries SET payload=NULL,bytes=0,expires=? WHERE key=?",
          this.now() + YEAR_MS,
          key,
        );
        return { entry: null, epoch, blocked: true };
      }
      // Build snapshots have no runtime epoch. Conservatively reject a tagged
      // snapshot after ANY invalidation of that tag, including an earlier deploy.
      return { entry: null, epoch, blocked: this.tagsAfter(seedTags, 0) };
    });
  }
  write(key: string, entry: CacheEntry, observedEpoch: number, token?: string) {
    const tags = entry.tags ?? [];
    this.validTags(tags);
    const payload = JSON.stringify(entry),
      bytes = new TextEncoder().encode(payload).length;
    if (
      bytes > MAX_ENTRY_BYTES ||
      !Number.isFinite(entry.timestamp) ||
      !Number.isFinite(entry.expire) ||
      !Number.isFinite(entry.revalidate) ||
      entry.expire <= 0 ||
      entry.revalidate < 0
    )
      return false;
    const expires = entry.timestamp + Math.min(entry.expire * 1000, YEAR_MS);
    return this.transaction(() => {
      const lease = this.sql
        .exec<{
          token: string;
          until: number;
        }>("SELECT token,until FROM leases WHERE key=?", key)
        .toArray()[0];
      if (
        token
          ? !lease || lease.token !== token || lease.until <= this.now()
          : lease && lease.until > this.now()
      )
        return false;
      if (
        !Number.isInteger(observedEpoch) ||
        observedEpoch < 0 ||
        observedEpoch > this.epoch() ||
        this.tagsAfter(tags, observedEpoch) ||
        expires <= this.now()
      )
        return false;
      if (
        this.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM entries")
          .one().count >= 4096 &&
        !this.sql.exec("SELECT key FROM entries WHERE key=?", key).toArray()
          .length
      )
        return false;
      this.sql.exec(
        "INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?,?)",
        key,
        payload,
        expires,
        bytes,
        this.epoch(),
        this.now(),
      );
      this.sweep();
      // Bounded cache per shard. Evict payloads, never invalidation tombstones.
      while (
        this.sql
          .exec<{
            bytes: number;
            count: number;
          }>(
            "SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count FROM entries WHERE payload IS NOT NULL",
          )
          .one().bytes > 16_000_000 ||
        this.sql
          .exec<{
            count: number;
          }>("SELECT COUNT(*) AS count FROM entries WHERE payload IS NOT NULL")
          .one().count > 512
      ) {
        this.sql.exec(
          "UPDATE entries SET payload=NULL,bytes=0,expires=? WHERE key=(SELECT key FROM entries WHERE payload IS NOT NULL ORDER BY touched LIMIT 1)",
          this.now() + YEAR_MS,
        );
      }
      return true;
    });
  }
  remove(key: string) {
    this.transaction(() => {
      if (
        this.sql
          .exec<{
            count: number;
          }>("SELECT COUNT(*) AS count FROM entries WHERE payload IS NULL")
          .one().count >= 4096 &&
        !this.sql.exec("SELECT key FROM entries WHERE key=?", key).toArray()
          .length
      )
        throw new Error("Cache tombstone capacity exceeded");
      this.sql.exec(
        "INSERT OR REPLACE INTO entries VALUES (?,NULL,?,0,?,?)",
        key,
        this.now() + YEAR_MS,
        this.epoch(),
        this.now(),
      );
    });
  }
  invalidate(tag: string) {
    this.validTags([tag]);
    this.transaction(() => {
      if (
        this.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM tags")
          .one().count >= 10000 &&
        !this.sql.exec("SELECT tag FROM tags WHERE tag=?", tag).toArray().length
      )
        throw new Error("Cache tag capacity exceeded");
      this.sql.exec("UPDATE meta SET epoch=epoch+1 WHERE id=1");
      this.sql.exec(
        "INSERT OR REPLACE INTO tags VALUES (?,?)",
        tag,
        this.epoch(),
      );
    });
  }
  claim(key: string) {
    return this.transaction(() => {
      const existing = this.sql
        .exec<{ until: number }>("SELECT until FROM leases WHERE key=?", key)
        .toArray()[0];
      if (existing && existing.until > this.now()) return null;
      const token = crypto.randomUUID();
      this.sql.exec(
        "INSERT OR REPLACE INTO leases VALUES (?,?,?)",
        key,
        token,
        this.now() + LEASE_MS,
      );
      return { token, epoch: this.epoch() };
    });
  }
  release(key: string, token: string) {
    this.sql.exec("DELETE FROM leases WHERE key=? AND token=?", key, token);
  }
  sweep() {
    this.sql.exec(
      "DELETE FROM entries WHERE payload IS NULL AND expires<=?",
      this.now(),
    );
    this.sql.exec(
      "UPDATE entries SET payload=NULL,bytes=0,expires=? WHERE payload IS NOT NULL AND expires<=?",
      this.now() + YEAR_MS,
      this.now(),
    );
    this.sql.exec("DELETE FROM leases WHERE until<=?", this.now());
  }
}
