import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createDraftCookie } from "../dist/draft.js";
const root = resolve(import.meta.dirname, "..");
execFileSync(
  process.execPath,
  [resolve(root, "scripts/prepare-workers-cache-qa.mjs")],
  { cwd: root, stdio: "inherit" },
);
const fixture = resolve(root, ".artifacts/managed");
const config = JSON.parse(
  await readFile(resolve(fixture, ".output/server/wrangler.json"), "utf8"),
);
assert.deepEqual(config.cache, { enabled: true, cross_version_cache: false });
const draft = (await readFile(resolve(fixture, "draft.key"), "utf8")).trim();
await writeFile(
  resolve(fixture, ".output/server/.dev.vars"),
  `REBASK_DRAFT_SECRET=${draft}\n`,
  { mode: 0o600 },
);
const child = spawn(
  process.execPath,
  [
    resolve(fixture, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--config",
    resolve(fixture, ".output/server/wrangler.json"),
    "--ip",
    "127.0.0.1",
    "--port",
    "8790",
  ],
  { cwd: fixture, detached: true, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
child.stdout.on("data", (c) => (log += c));
child.stderr.on("data", (c) => (log += c));
const origin = "http://127.0.0.1:8790";
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error(log);
    try {
      const r = await fetch(origin, { signal: AbortSignal.timeout(1000) });
      await r.body?.cancel();
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await setTimeout(250);
  }
  assert.ok(ready, log);
  const cookie = (await createDraftCookie(draft)).split(";")[0];
  const ids = new Set();
  for (const headers of [
    { cookie },
    { cookie },
    { cookie: cookie + "invalid" },
    { authorization: "Bearer qa-invalid" },
    { accept: "text/x-component" },
  ]) {
    const r = await fetch(origin + "/catalog/item-a", { headers });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /private.*no-store/);
    assert.equal(r.headers.get("x-rebask-cdn"), "BYPASS");
    const id = r.headers.get("x-rebask-worker-execution");
    assert.ok(id);
    assert.ok(!ids.has(id));
    ids.add(id);
    if (headers.cookie === cookie)
      assert.equal(r.headers.get("x-rebask-draft"), "1");
    else assert.equal(r.headers.get("x-rebask-draft"), null);
    await r.arrayBuffer();
  }
  for (const viewer of ["local-a", "local-b"]) {
    const r = await fetch(origin + "/alice", {
      headers: { "x-example-viewer": viewer },
    });
    assert.equal(r.headers.get("x-rebask-prerender"), "1");
    assert.equal(r.headers.get("x-rebask-cdn"), "BYPASS");
    assert.ok((await r.text()).includes(viewer));
  }
  assert.doesNotMatch(log, /\[ERROR\]|Uncaught|ENOENT/);
  console.log(
    "Managed packed consumer passed: config/version isolation, signed Draft Mode/auth/RSC bypass, fresh execution IDs and native PPR. Actual no-execution HITs require remote Workers Cache verification.",
  );
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
}
