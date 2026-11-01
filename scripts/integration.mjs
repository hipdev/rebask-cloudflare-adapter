import assert from "node:assert/strict";
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
pkg.dependencies["@hipdev/rebask-cloudflare"] =
  `file:${resolve(artifacts, pack.filename)}`;
await writeFile(resolve(fixture, "package.json"), JSON.stringify(pkg, null, 2));
execFileSync(
  "npm",
  ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
  { cwd: fixture, stdio: "inherit" },
);
execFileSync(
  process.execPath,
  [resolve(fixture, "node_modules/vite/bin/vite.js"), "build"],
  { cwd: fixture, stdio: "inherit" },
);
execFileSync("npm", ["run", "typecheck"], { cwd: fixture, stdio: "inherit" });
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
      if (r.ok) return { origin, log: () => log };
    } catch {}
    await setTimeout(250);
  }
  throw Error(`Workerd startup failed: ${log}`);
}
try {
  const normal = await start(fixture, 8788);
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
