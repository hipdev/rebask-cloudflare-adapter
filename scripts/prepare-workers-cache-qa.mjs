// Explicit operator-only remote QA preparation. Contains no real account IDs or public enable endpoint.
import { cp, readFile, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, ".artifacts/managed");
await rm(fixture, { recursive: true, force: true });
await mkdir(fixture, { recursive: true });
await cp(resolve(root, "examples/basic"), fixture, { recursive: true });
await symlink(
  resolve(root, ".artifacts/basic/node_modules"),
  resolve(fixture, "node_modules"),
  "dir",
);
let config = await readFile(resolve(fixture, "vite.config.ts"), "utf8");
config = config.replace("pageCache: {", 'pageCache: { mode: "workers-cache",');
await writeFile(resolve(fixture, "vite.config.ts"), config);
let catalog = await readFile(resolve(fixture, "lib/catalog.ts"), "utf8");
await writeFile(
  resolve(fixture, "lib/catalog.ts"),
  catalog.replace("revalidate: 5, expire: 30", "revalidate: 60, expire: 300"),
);
const qaKey = randomBytes(32).toString("hex"),
  draft = randomBytes(48).toString("hex");
await writeFile(resolve(fixture, "qa.key"), qaKey, { mode: 0o600 });
await writeFile(resolve(fixture, "draft.key"), draft, { mode: 0o600 });
await mkdir(resolve(fixture, "app/__qa-invalidate"), { recursive: true });
await writeFile(
  resolve(fixture, "app/__qa-invalidate/route.ts"),
  `import { revalidateTag } from "@rebask/core/cache";
export async function POST(request: Request) {
 if(request.headers.get("x-qa-key")!==${JSON.stringify(qaKey)})return new Response(null,{status:403});
 await revalidateTag("catalog");return new Response(null,{status:204});
}`,
);
execFileSync(
  process.execPath,
  [resolve(fixture, "node_modules/vite/bin/vite.js"), "build"],
  { cwd: fixture, stdio: "inherit" },
);
const workerFile = resolve(fixture, ".output/server/worker.mjs");
let worker = await readFile(workerFile, "utf8");
worker = worker.replace(
  "const response = await app.fetch(request);",
  `const response = await app.fetch(request);
        if(request.headers.get("x-qa-late-fill")===${JSON.stringify(qaKey)})await new Promise(resolve=>setTimeout(resolve,1800));`,
);
await writeFile(workerFile, worker);
const server = resolve(fixture, "dist/rsc/index.js");
let code = await readFile(server, "utf8");
const needle = "async function renderResumeStream(state, postponed) {";
if (code.split(needle).length !== 2) throw Error("Resume function changed");
code = code.replace(
  needle,
  `${needle}\n if(state.request.headers.get("x-qa-delay")===${JSON.stringify(qaKey)})await new Promise(resolve=>setTimeout(resolve,1800));`,
);
await writeFile(server, code);
console.log(
  "Prepared ignored managed-cache QA fixture; supply an account/name in its generated Wrangler config before remote deployment.",
);
