import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
const require = createRequire(import.meta.url);
// Core's public cache barrel requires Vite virtual modules; isolate the real base class.
const base = pathToFileURL(
  `${dirname(require.resolve("@rebask/core/package.json"))}/dist/lib/cache-storage.js`,
).href;
const source = (
  await readFile(new URL("../dist/storage.js", import.meta.url), "utf8")
).replace('"@rebask/core/cache"', JSON.stringify(base));
const { BuildArtifactStorage } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const key = "ph:build:/alice";
const entry = {
  type: 2,
  html: "public shell",
  timestamp: Date.now(),
  revalidate: 3600,
  expire: 3600,
};
function storage(value = entry) {
  return new BuildArtifactStorage({
    deploymentId: "build",
    manifest: {},
    entries: { [createHash("sha256").update(key).digest("hex")]: value },
  });
}
test("build reads are cloned; runtime/private writes and promotion are disabled", async () => {
  const c = storage();
  const a = await c.get(key);
  a.html = "mutated";
  await c.set(key, { ...entry, html: "private viewer" });
  await c.delete(key);
  assert.equal((await c.get(key)).html, "public shell");
  assert.equal(await c.tryClaim(key), null);
});
test("other deployment IDs, data namespaces, wrong types and expiry miss", async () => {
  const c = storage();
  assert.equal(await c.get("ph:other:/alice"), null);
  assert.equal(await c.get("du:build:/alice"), null);
  assert.equal(await storage({ ...entry, type: 3 }).get(key), null);
  assert.equal(
    await storage({ ...entry, timestamp: 0, expire: 1 }).get(key),
    null,
  );
});
test("tag invalidation must not silently pretend success", async () => {
  await assert.rejects(storage().revalidateTag("posts"), /immutable/);
});
