import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = resolve(root, ".artifacts");
await mkdir(artifacts, { recursive: true });
const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", artifacts], {
    cwd: root,
    encoding: "utf8",
  }),
);
assert.ok(
  pack.files.every(
    (f) =>
      !/^(?:src|examples|tests|node_modules|\.env|\.github)\//.test(f.path),
  ),
  "Unexpected tarball file",
);
const fixture = resolve(artifacts, "basic");
await rm(fixture, { recursive: true, force: true });
await cp(resolve(root, "examples/basic"), fixture, { recursive: true });
const pkg = JSON.parse(
  await readFile(resolve(fixture, "package.json"), "utf8"),
);
pkg.dependencies["rebask-cloudflare-adapter"] =
  `file:${resolve(artifacts, pack.filename)}`;
await writeFile(resolve(fixture, "package.json"), JSON.stringify(pkg, null, 2));
execFileSync(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: fixture, stdio: "inherit" },
);
const invalidateNonce = randomUUID();
const draftSecret = randomUUID() + randomUUID();
await mkdir(resolve(fixture, "app/__qa-invalidate"), { recursive: true });
await writeFile(
  resolve(fixture, "app/__qa-invalidate/route.ts"),
  `import { revalidateTag } from "@rebask/core/cache";
export async function POST(request: Request) {
 if (request.headers.get("x-qa-key") !== ${JSON.stringify(invalidateNonce)}) return new Response(null,{status:403});
 await revalidateTag("catalog"); return new Response(null,{status:204});
}`,
);
execFileSync(
  process.execPath,
  [resolve(fixture, "node_modules/vite/bin/vite.js"), "build"],
  { cwd: fixture, stdio: "inherit" },
);
execFileSync("npm", ["run", "typecheck"], { cwd: fixture, stdio: "inherit" });
const generatedConfig = JSON.parse(
  await readFile(resolve(fixture, ".output/server/wrangler.json"), "utf8"),
);
assert.equal(
  generatedConfig.define["process.env.NODE_ENV"],
  '"production"',
  "Runtime Flight must match production prerenders/client",
);
await writeFile(
  resolve(fixture, ".output/server/.dev.vars"),
  `REBASK_DRAFT_SECRET=${draftSecret}\n`,
);
const workers = [];
async function start(directory, port) {
  const child = spawn(
    process.execPath,
    [
      resolve(fixture, "node_modules/wrangler/bin/wrangler.js"),
      "dev",
      "--config",
      resolve(directory, ".output/server/wrangler.json"),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  workers.push(child);
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw Error(log);
    try {
      const r = await fetch(origin, { signal: AbortSignal.timeout(1000) });
      await r.body?.cancel();
      if (r.ok) return { origin, child, log: () => log };
    } catch {}
    await setTimeout(250);
  }
  throw Error(`Workerd startup failed: ${log}`);
}
try {
  let normal = await start(fixture, 8788);
  for (const [slug, viewer] of [
    ["alice", "viewer-a"],
    ["alice", "viewer-b"],
    ["bob", "viewer-c"],
  ]) {
    const r = await fetch(`${normal.origin}/${slug}`, {
      headers: { "x-example-viewer": viewer },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-rebask-cache"), "HIT");
    assert.equal(r.headers.get("x-rebask-prerender"), "1");
    assert.match(r.headers.get("cache-control"), /private.*no-store/);
    const html = await r.text();
    const visible = html
      .slice(html.indexOf("<body"))
      .split(/<div hidden(?:="")? id="S:/)[0]
      .split("<script")[0];
    assert.match(visible, /aria-label="Main navigation"/);
    assert.ok(visible.indexOf("<nav") < visible.indexOf("<main"));
    assert.ok(html.includes(viewer) && html.includes(slug));
    for (const other of ["viewer-a", "viewer-b", "viewer-c"].filter(
      (v) => v !== viewer,
    ))
      assert.ok(!html.includes(other), "Runtime viewer leaked across requests");
  }
  for (const path of [
    "/.cache/cloudflare/ppr-artifacts.mjs",
    "/dist/.rebask/prerendered-paths.json",
  ]) {
    const r = await fetch(normal.origin + path);
    assert.equal(r.status, 404);
    await r.body?.cancel();
  }
  const reject = await fetch(`${normal.origin}/alice`, {
    method: "POST",
    headers: { origin: "https://untrusted.invalid", "x-rebask-resume": "1" },
    body: "forged",
  });
  assert.equal(reject.status, 403);
  await reject.body?.cancel();
  const rsc = await fetch(`${normal.origin}/alice`, {
    headers: { accept: "text/x-component", "x-example-viewer": "rsc-viewer" },
  });
  assert.match(rsc.headers.get("content-type"), /^text\/x-component/);
  assert.ok((await rsc.text()).includes("rsc-viewer"));
  const html = await fetch(`${normal.origin}/alice`);
  assert.match(html.headers.get("content-type"), /^text\/html/);
  await html.body?.cancel();
  const publicValues = [];
  for (const viewer of ["data-viewer-a", "data-viewer-b"]) {
    const response = await fetch(`${normal.origin}/public-data/shared`, {
      headers: { "x-example-viewer": viewer },
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes(viewer));
    assert.ok(
      !html.includes(
        viewer === "data-viewer-a" ? "data-viewer-b" : "data-viewer-a",
      ),
    );
    publicValues.push(html.match(/data-generated="(\d+)"/)?.[1]);
    await setTimeout(150);
  }
  assert.ok(publicValues[0]);
  assert.equal(
    publicValues[0],
    publicValues[1],
    "use-cache was not shared independently of uncached viewer content",
  );
  async function catalog() {
    const response = await fetch(`${normal.origin}/catalog/item-a`);
    assert.equal(response.status, 200);
    const html = await response.text();
    const generated = html.match(/data-generated="(\d+)"/)?.[1];
    assert.ok(generated, "Missing catalog snapshot");
    return {
      generated,
      cache: response.headers.get("x-rebask-cache"),
      partial: response.headers.get("x-rebask-prerender"),
      cdn: response.headers.get("x-rebask-cdn"),
    };
  }
  let snapshot = await catalog();
  for (let i = 0; i < 20; i++) {
    await setTimeout(100);
    snapshot = await catalog();
    if (snapshot.cache === "HIT" && snapshot.partial !== "1") break;
  }
  assert.equal(snapshot.cache, "HIT");
  assert.notEqual(
    snapshot.partial,
    "1",
    "Public dynamic path was not promoted to complete cached HTML",
  );
  assert.equal(
    (await catalog()).generated,
    snapshot.generated,
    "Runtime result was not reused",
  );
  await setTimeout(200);
  assert.equal(
    (await catalog()).cdn,
    "HIT",
    "Complete public HTML never reached edge cache",
  );
  const { createDraftCookie } = await import("../dist/draft.js");
  const cookie = (await createDraftCookie(draftSecret)).split(";")[0];
  let previousDraft;
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${normal.origin}/catalog/item-a`, {
      headers: { cookie },
    });
    assert.equal(r.headers.get("x-rebask-draft"), "1");
    assert.equal(r.headers.get("x-rebask-cdn"), "BYPASS");
    const value = (await r.text()).match(/data-generated="(\d+)"/)?.[1];
    assert.ok(value);
    assert.notEqual(value, snapshot.generated, "Draft reused public use-cache");
    if (previousDraft)
      assert.notEqual(
        value,
        previousDraft,
        "Draft cached its own generated value",
      );
    previousDraft = value;
    await setTimeout(30);
  }
  assert.equal(
    (await catalog()).generated,
    snapshot.generated,
    "Draft overwrote public cache",
  );
  const tampered = await fetch(`${normal.origin}/catalog/item-a`, {
    headers: { cookie: cookie + "x" },
  });
  assert.equal(tampered.headers.get("x-rebask-draft"), null);
  assert.equal(tampered.headers.get("x-rebask-cdn"), "BYPASS");
  await tampered.body.cancel();
  const transformed = await fetch(
    `${normal.origin}/_rebask/image?url=/images/sample.png&w=128&q=75`,
    { headers: { accept: "image/webp" } },
  );
  assert.equal(transformed.status, 200, await transformed.clone().text());
  assert.equal(transformed.headers.get("content-type"), "image/webp");
  const imageBytes = Buffer.from(await transformed.arrayBuffer());
  assert.equal(imageBytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(imageBytes.toString("ascii", 8, 12), "WEBP");
  await setTimeout(100);
  const transformedHit = await fetch(
    `${normal.origin}/_rebask/image?url=/images/sample.png&w=128&q=75`,
    { headers: { accept: "image/webp" } },
  );
  assert.equal(transformedHit.headers.get("x-rebask-image-cache"), "HIT");
  await transformedHit.body.cancel();
  const unauthorizedImage = await fetch(
    `${normal.origin}/_rebask/image?url=https%3A%2F%2Fprivate.invalid%2Fa.png&w=128&q=75`,
  );
  assert.equal(unauthorizedImage.status, 400);
  await unauthorizedImage.body.cancel();
  const previousLog = normal.log();
  const stopped = once(normal.child, "exit");
  process.kill(-normal.child.pid, "SIGTERM");
  await stopped;
  normal = await start(fixture, 8788);
  assert.equal(
    (await catalog()).generated,
    snapshot.generated,
    "Durable result did not survive Worker restart",
  );
  await setTimeout(5500);
  await catalog(); // Serve stale and start native ISR in waitUntil.
  let refreshed;
  for (let i = 0; i < 30; i++) {
    await setTimeout(100);
    refreshed = await catalog();
    if (refreshed.generated !== snapshot.generated) break;
  }
  assert.notEqual(
    refreshed.generated,
    snapshot.generated,
    "Native ISR never refreshed the stale public entry",
  );
  const denied = await fetch(`${normal.origin}/__qa-invalidate`, {
    method: "POST",
  });
  assert.equal(denied.status, 403);
  const invalidated = await fetch(`${normal.origin}/__qa-invalidate`, {
    method: "POST",
    headers: { "x-qa-key": invalidateNonce },
  });
  assert.equal(invalidated.status, 204);
  const afterInvalidation = await catalog();
  assert.notEqual(
    afterInvalidation.generated,
    refreshed.generated,
    "Tag invalidation did not force fresh data",
  );
  assert.doesNotMatch(previousLog, /\[ERROR\]|Uncaught|ENOENT/);
  console.log(
    "Durable public catalog passed: promotion, shared use-cache, Worker restart persistence, native ISR and authenticated test-only tag invalidation.",
  );
  const delayed = resolve(artifacts, "delayed");
  await rm(delayed, { recursive: true, force: true });
  await mkdir(delayed, { recursive: true });
  for (const path of ["dist", ".cache/cloudflare", ".output"])
    await cp(resolve(fixture, path), resolve(delayed, path), {
      recursive: true,
    });
  const server = resolve(delayed, "dist/rsc/index.js");
  let source = await readFile(server, "utf8");
  const needle = "async function renderResumeStream(state, postponed) {";
  assert.equal(source.split(needle).length, 2);
  await writeFile(
    server,
    source.replace(
      needle,
      `${needle}\n await new Promise(resolve => setTimeout(resolve,1800));`,
    ),
  );
  const slow = await start(delayed, 8789);
  const t = performance.now();
  const response = await fetch(`${slow.origin}/alice`, {
    headers: {
      "accept-encoding": "gzip, br",
      "x-example-viewer": "delayed-viewer",
    },
  });
  assert.equal(response.headers.get("content-encoding"), "identity");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let initial = "";
  while (!initial.includes("<main")) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    initial += decoder.decode(value, { stream: true });
  }
  const shellMs = Math.round(performance.now() - t);
  assert.match(initial, /Main navigation/);
  assert.ok(shellMs < 1400, `Shell waited for resume: ${shellMs}ms`);
  let complete = initial;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    complete += decoder.decode(value, { stream: true });
  }
  const completeMs = Math.round(performance.now() - t);
  assert.ok(completeMs >= 1750);
  assert.ok(complete.length > initial.length);
  assert.ok(complete.includes("delayed-viewer"));
  assert.doesNotMatch(normal.log() + slow.log(), /\[ERROR\]|Uncaught|ENOENT/);
  console.log(JSON.stringify({ shellMs, completeMs }));
  console.log(
    "Packed consumer passed: native PPR, dynamic viewer isolation, private artifacts, CSRF, HTML/RSC separation and delayed React resume.",
  );
} finally {
  for (const child of workers)
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
}
