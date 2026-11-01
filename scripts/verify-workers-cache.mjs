import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { createDraftCookie } from "../dist/draft.js";
const origin = process.argv[2];
assert.ok(
  origin?.startsWith("https://"),
  "Pass the deployed packed example HTTPS origin",
);
const proof = [];
async function get(path = "/catalog/item-a", headers = {}) {
  const r = await fetch(new URL(path, origin), {
    headers: { accept: "text/html", ...headers },
  });
  const body = await r.text();
  assert.equal(r.status, 200, `${path}: ${r.status}`);
  return {
    status: r.status,
    cache: r.headers.get("cf-cache-status"),
    execution: r.headers.get("x-rebask-worker-execution"),
    cdn: r.headers.get("x-rebask-cdn"),
    draft: r.headers.get("x-rebask-draft"),
    partial: r.headers.get("x-rebask-prerender"),
    type: r.headers.get("content-type"),
    generated: body.match(/data-generated="(\d+)"/)?.[1],
    body,
  };
}
async function hit() {
  for (let i = 0; i < 30; i++) {
    const r = await get();
    if (r.cache === "HIT") return r;
    await setTimeout(150);
  }
  throw Error("Managed CDN never reached HIT");
}
let first = await hit();
for (let i = 0; i < 3; i++) {
  const next = await hit();
  assert.ok(first.execution);
  assert.equal(
    next.execution,
    first.execution,
    "HIT executed the origin handler",
  );
  assert.equal(next.generated, first.generated);
}
proof.push({
  check: "native-HIT-without-execution",
  cache: first.cache,
  execution: first.execution,
});
for (const headers of [
  { cookie: "qa=1" },
  { authorization: "Bearer qa-invalid" },
  { accept: "text/x-component" },
  { "x-rebask-tree": "1" },
]) {
  const a = await get(undefined, headers),
    b = await get(undefined, headers);
  assert.notEqual(a.cache, "HIT");
  assert.notEqual(b.cache, "HIT");
  assert.notEqual(a.execution, first.execution);
  assert.notEqual(a.execution, b.execution);
  proof.push({
    check: "bypass",
    request: Object.keys(headers)[0],
    cache: b.cache,
    freshExecutions: true,
  });
}
const viewerA = await get("/alice", { "x-example-viewer": "native-a" });
const viewerB = await get("/alice", { "x-example-viewer": "native-b" });
assert.equal(viewerA.partial, "1");
assert.equal(viewerB.partial, "1");
assert.notEqual(viewerA.cache, "HIT");
assert.notEqual(viewerB.cache, "HIT");
assert.ok(
  viewerA.body.includes("native-a") && !viewerA.body.includes("native-b"),
);
assert.ok(
  viewerB.body.includes("native-b") && !viewerB.body.includes("native-a"),
);
proof.push({ check: "PPR-viewer-isolation", streaming: true });
const key = process.argv[3]
  ? (await readFile(process.argv[3], "utf8")).trim()
  : null;
if (key) {
  const purge = async () => {
    const r = await fetch(new URL("/__qa-invalidate", origin), {
      method: "POST",
      headers: { "x-qa-key": key },
    });
    assert.equal(r.status, 204, await r.text());
  };
  const denied = await fetch(new URL("/__qa-invalidate", origin), {
    method: "POST",
  });
  assert.equal(denied.status, 403);
  await denied.body?.cancel();
  await purge();
  let fresh;
  for (let i = 0; i < 30; i++) {
    fresh = await get();
    if (
      fresh.generated &&
      fresh.generated !== first.generated &&
      fresh.cache === "HIT"
    )
      break;
    await setTimeout(150);
  }
  assert.notEqual(
    fresh.generated,
    first.generated,
    "Acknowledged invalidation retained old public data",
  );
  assert.notEqual(fresh.execution, first.execution);
  first = fresh;
  // The QA build delays a native origin fill BEFORE the generation recheck.
  const concurrent = get(undefined, {
    accept: "text/html;qa-late-fill",
    "x-qa-late-fill": key,
  });
  await setTimeout(500);
  await purge();
  const stale = await concurrent;
  assert.notEqual(stale.cache, "HIT");
  assert.equal(
    stale.cdn,
    "BYPASS",
    "Concurrent invalidation allowed a stale fill",
  );
  const newer = await hit();
  assert.notEqual(newer.generated, first.generated);
  proof.push({
    check: "tag-invalidation-and-late-fill-fence",
    nativePurgeAccepted: true,
    lateFill: stale.cdn,
  });
  const started = performance.now();
  const response = await fetch(new URL("/alice", origin), {
    headers: {
      accept: "text/html",
      "x-qa-delay": key,
      "accept-encoding": "gzip, br",
      "x-example-viewer": "delayed-native",
    },
  });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let initial = "";
  while (!initial.includes('aria-label="Main navigation"')) {
    const r = await reader.read();
    assert.ok(!r.done);
    initial += decoder.decode(r.value, { stream: true });
  }
  const shellMs = Math.round(performance.now() - started);
  let complete = initial;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    complete += decoder.decode(r.value, { stream: true });
  }
  const completeMs = Math.round(performance.now() - started);
  assert.ok(shellMs < 1500, `Shell blocked on resume (${shellMs}ms)`);
  assert.ok(completeMs >= 1750);
  assert.ok(complete.includes("delayed-native"));
  proof.push({ check: "native-delayed-PPR", shellMs, completeMs });
}
if (process.argv[4]) {
  const secret = (await readFile(process.argv[4], "utf8")).trim();
  const cookie = (await createDraftCookie(secret, 60)).split(";")[0];
  const a = await get(undefined, { cookie }),
    b = await get(undefined, { cookie });
  assert.equal(a.draft, "1");
  assert.equal(b.draft, "1");
  assert.notEqual(a.cache, "HIT");
  assert.notEqual(b.cache, "HIT");
  assert.notEqual(a.execution, b.execution);
  assert.notEqual(a.generated, b.generated);
  const tampered = await get(undefined, { cookie: cookie + "invalid" });
  assert.equal(tampered.draft, null);
  proof.push({
    check: "signed-Draft-Mode",
    freshExecutions: true,
    freshData: true,
    tamperedRejected: true,
  });
}
console.log(JSON.stringify(proof, null, 2));
if (process.env.QA_EVIDENCE)
  await writeFile(
    process.env.QA_EVIDENCE,
    JSON.stringify(proof, null, 2) + "\n",
  );
