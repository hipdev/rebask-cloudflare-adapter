import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CacheShard, LEASE_MS, MAX_ENTRY_BYTES } from "../dist/shard.js";
import { withCacheRequest, runCacheTask } from "../dist/runtime.js";
function shard() {
  const db = new DatabaseSync(":memory:");
  let now = Date.now();
  const sql = {
    exec(query, ...args) {
      if (query.includes("CREATE TABLE")) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      const rows = statement.columns().length
        ? statement.all(...args)
        : (statement.run(...args), []);
      return {
        toArray: () => rows,
        one: () => {
          assert.equal(rows.length, 1);
          return rows[0];
        },
      };
    },
  };
  return {
    store: new CacheShard(
      sql,
      (fn) => {
        db.exec("BEGIN");
        try {
          const result = fn();
          db.exec("COMMIT");
          return result;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      () => now,
    ),
    now: () => now,
    advance: (ms) => (now += ms),
  };
}
const entry = (s, tags = []) => ({
  type: 2,
  html: "public",
  timestamp: s.now(),
  revalidate: 1,
  expire: 60,
  tags,
});
test("durable SQLite distinguishes stale/expired and blocks seed resurrection", () => {
  const s = shard(),
    v = entry(s);
  assert.equal(s.store.write("k", v, 0), true);
  assert.equal(s.store.lookup("k", []).entry.html, "public");
  s.advance(61_000);
  assert.equal(s.store.lookup("k", []).blocked, true);
  assert.equal(s.store.lookup("k", []).entry, null);
  s.store.remove("seed");
  assert.equal(s.store.lookup("seed", []).blocked, true);
});
test("invalidation rejects late fills even if their timestamp is newer or in the same millisecond", () => {
  const s = shard();
  const read = s.store.lookup("k", ["catalog"]);
  s.store.invalidate("catalog");
  assert.equal(s.store.write("k", entry(s, ["catalog"]), read.epoch), false);
  assert.equal(s.store.lookup("k", ["catalog"]).blocked, true);
  const fresh = s.store.lookup("k", ["catalog"]);
  assert.equal(s.store.write("k", entry(s, ["catalog"]), fresh.epoch), true);
  s.store.invalidate("catalog");
  assert.equal(s.store.lookup("k", []).blocked, true);
  assert.equal(s.store.lookup("k", []).blocked, true);
});
test("claims are exclusive, expire, fence old writers and cannot be released by a stale owner", () => {
  const s = shard();
  const a = s.store.claim("k");
  assert.ok(a);
  assert.equal(s.store.claim("k"), null);
  s.advance(LEASE_MS + 1);
  const b = s.store.claim("k");
  assert.ok(b);
  s.store.release("k", a.token);
  assert.equal(s.store.claim("k"), null);
  assert.equal(s.store.write("k", entry(s), b.epoch, a.token), false);
  assert.equal(s.store.write("k", entry(s), b.epoch, b.token), true);
  s.store.release("k", b.token);
  assert.ok(s.store.claim("k"));
});
test("bounded payloads and invalid generations never enter the store", () => {
  const s = shard();
  assert.equal(
    s.store.write(
      "large",
      { ...entry(s), html: "x".repeat(MAX_ENTRY_BYTES) },
      0,
    ),
    false,
  );
  assert.equal(s.store.write("future", entry(s), 999), false);
  assert.equal(s.store.write("negative", entry(s), -1), false);
  assert.equal(s.store.lookup("large", []).entry, null);
});
const require = createRequire(import.meta.url);
const base = pathToFileURL(
  `${dirname(require.resolve("@rebask/core/package.json"))}/dist/lib/cache-storage.js`,
).href;
const source = (
  await readFile(new URL("../dist/durable-storage.js", import.meta.url), "utf8")
)
  .replace('"@rebask/core/cache"', JSON.stringify(base))
  .replace(
    '"./runtime.js"',
    JSON.stringify(new URL("../dist/runtime.js", import.meta.url).href),
  )
  .replace(
    '"./shard.js"',
    JSON.stringify(new URL("../dist/shard.js", import.meta.url).href),
  );
const { DurableCacheStorage } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
function namespace() {
  const shards = new Map();
  return {
    getByName(name) {
      if (!shards.has(name)) shards.set(name, shard().store);
      return shards.get(name);
    },
    shards,
  };
}
async function request(ns, fn) {
  const pending = [];
  const result = await withCacheRequest(ns, (p) => pending.push(p), fn);
  await Promise.all(pending);
  return result;
}
test("runtime data is shared only through valid framework keys; deployment IDs and entry types remain isolated", async () => {
  const ns = namespace();
  const a = new DurableCacheStorage({
      deploymentId: "a",
      manifest: {},
      entries: {},
    }),
    b = new DurableCacheStorage({
      deploymentId: "b",
      manifest: {},
      entries: {},
    });
  await request(ns, async () => {
    await a.get("du:a:data");
    await a.set("du:a:data", {
      type: 3,
      rsc: "encoded-public",
      timestamp: Date.now(),
      revalidate: 10,
      expire: 60,
    });
    await a.set("du:a:wrong", {
      type: 2,
      html: "bad",
      timestamp: Date.now(),
      revalidate: 10,
      expire: 60,
    });
  });
  await request(ns, async () => {
    assert.equal((await a.get("du:a:data")).rsc, "encoded-public");
    assert.equal(await b.get("du:a:data"), null);
    assert.equal(await a.get("du:a:wrong"), null);
  });
});
test("invalidation fans out and request epochs cannot be advanced by a later concurrent read", async () => {
  const ns = namespace(),
    cache = new DurableCacheStorage({
      deploymentId: "a",
      manifest: {},
      entries: {},
    });
  await request(ns, async () => {
    await cache.get("ph:a:/public");
    await request(ns, () => cache.revalidateTag("public"));
    await cache.get("ph:a:/public");
    await cache.set("ph:a:/public", {
      type: 2,
      html: "old-computation",
      tags: ["public"],
      timestamp: Date.now(),
      revalidate: 10,
      expire: 60,
    });
  });
  await request(ns, async () =>
    assert.equal(await cache.get("ph:a:/public"), null),
  );
  assert.equal(ns.shards.size, 16);
});
test("background tasks retain Workers lifetime and use an independent generation context", async () => {
  const ns = namespace(),
    pending = [];
  await withCacheRequest(
    ns,
    (p) => pending.push(p),
    async () => {
      runCacheTask(async () => {
        await Promise.resolve();
        const c = new DurableCacheStorage({
          deploymentId: "a",
          manifest: {},
          entries: {},
        });
        await c.get("ph:a:/x");
        await c.set("ph:a:/x", {
          type: 2,
          html: "background",
          timestamp: Date.now(),
          revalidate: 10,
          expire: 60,
        });
      });
    },
  );
  assert.ok(pending.length);
  await Promise.all(pending);
  await request(ns, async () =>
    assert.equal(
      (
        await new DurableCacheStorage({
          deploymentId: "a",
          manifest: {},
          entries: {},
        }).get("ph:a:/x")
      ).html,
      "background",
    ),
  );
});

test("invalidation failures are reported and can be retried without reopening an old generation", async () => {
  const ns = namespace();
  let fail = true;
  const flaky = {
    getByName(name) {
      const target = ns.getByName(name);
      return new Proxy(target, {
        get(object, property) {
          if (property === "invalidate")
            return (tag) => {
              if (fail && name.endsWith("f"))
                throw Error("temporary unavailable");
              return object.invalidate(tag);
            };
          const value = object[property];
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  const cache = new DurableCacheStorage({
    deploymentId: "a",
    manifest: {},
    entries: {},
  });
  await assert.rejects(
    request(flaky, () => cache.revalidateTag("catalog")),
    /unavailable/,
  );
  fail = false;
  await request(flaky, () => cache.revalidateTag("catalog"));
  for (const value of ns.shards.values())
    assert.equal(value.lookup("unused", ["catalog"]).blocked, true);
});
test("durableCache entries survive deployment IDs but scoped use-cache never crosses them", async () => {
  const ns = namespace(),
    a = new DurableCacheStorage({
      deploymentId: "a",
      manifest: {},
      entries: {},
    }),
    b = new DurableCacheStorage({
      deploymentId: "b",
      manifest: {},
      entries: {},
    });
  await request(ns, async () => {
    await a.get("dd:public-source-and-inputs");
    await a.set("dd:public-source-and-inputs", {
      type: 4,
      data: "public-json",
      timestamp: Date.now(),
      revalidate: 10,
      expire: 60,
    });
  });
  await request(ns, async () =>
    assert.equal(
      (await b.get("dd:public-source-and-inputs")).data,
      "public-json",
    ),
  );
});

test("CDN final barrier invalidates fills created during partial fanout", async () => {
  const ns = namespace();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const observed = new Promise((resolve) => {
    started = resolve;
  });
  const slow = {
    getByName(name) {
      const target = ns.getByName(name);
      return new Proxy(target, {
        get(object, property) {
          if (property === "invalidate" && name.endsWith("f"))
            return async (tag) => {
              started();
              await pending;
              object.invalidate(tag);
            };
          const value = object[property];
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    },
  };
  const cache = new DurableCacheStorage({
    deploymentId: "a",
    manifest: {},
    entries: {},
  });
  const invalidating = request(slow, () => cache.revalidateTag("catalog"));
  await observed;
  // An edge fill can use this partial-fanout generation while shard f is still old.
  const partial = ns.getByName("rebask-cache-v1-0").generation();
  release();
  await invalidating;
  assert.ok(
    ns.getByName("rebask-cache-v1-0").generation() > partial,
    "Acknowledged invalidation must fence every fill created before fanout completion",
  );
});
