// Trusted-main Cloudflare Builds only. Never run untrusted PR code with account access.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
const root = resolve(import.meta.dirname, "..");
const name = process.env.QA_WORKER_NAME || "rebask-adapter-ci";
assert.match(name, /^[a-z0-9-]+$/);
const node = process.execPath;
const run = (file, args = [], options = {}) =>
  execFileSync(node, [resolve(root, file), ...args], {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
run("scripts/prepare-workers-cache-qa.mjs", [], {
  env: { ...process.env, QA_WORKER_NAME: name },
});
const fixture = resolve(root, ".artifacts/managed");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const args = ["--config", resolve(fixture, ".output/server/wrangler.json")];
const deploy = () => run(wrangler, ["deploy", ...args]);
deploy();
const secret = (await readFile(resolve(fixture, "draft.key"), "utf8")).trim();
execFileSync(
  node,
  [wrangler, "secret", "put", "REBASK_DRAFT_SECRET", ...args],
  { cwd: fixture, input: secret, stdio: ["pipe", "inherit", "inherit"] },
);
// Do not infer the account subdomain from a potentially different account.
const origin = process.env.QA_ORIGIN;
assert.ok(
  origin?.startsWith("https://"),
  "Set QA_ORIGIN to the dedicated QA Worker URL",
);
const key = (await readFile(resolve(fixture, "qa.key"), "utf8")).trim();
const headers = { "x-qa-key": key };
async function control(value) {
  const r = await fetch(new URL("/__qa-control", origin), {
    method: value ? "POST" : "GET",
    headers,
    body: value,
  });
  assert.equal(r.status, 200);
  return r.json();
}
async function until(predicate) {
  const end = Date.now() + 100000;
  while (Date.now() < end) {
    const h = await control();
    if (predicate(h)) return h;
    await setTimeout(1000);
  }
  throw Error("Durable purge state did not reach the expected condition");
}
await control("ok");
run("scripts/verify-workers-cache.mjs", [
  origin,
  resolve(fixture, "qa.key"),
  resolve(fixture, "draft.key"),
]);
await control("fail");
const before = await control();
for (let i = 0; i < 3; i++) {
  const r = await fetch(new URL("/__qa-invalidate", origin), {
    method: "POST",
    headers,
  });
  assert.equal(r.status, 500, "Unconfirmed purge must not falsely succeed");
  await r.body?.cancel();
}
const pending = await until(
  (h) => h.pending && h.attempts >= 3 && h.alertActive,
);
assert.ok(pending.requested >= before.requested + 3);
// A new deployed Worker version must recover the same durable outbox.
deploy();
const restarted = await control();
assert.ok(
  restarted.pending &&
    restarted.failures >= pending.failures &&
    restarted.alertActive,
);
await control("ok");
const recovered = await until(
  (h) => !h.pending && !h.alertActive && h.completed >= pending.requested,
);
assert.ok(recovered.purges > pending.purges);
run("scripts/verify-workers-cache.mjs", [
  origin,
  resolve(fixture, "qa.key"),
  resolve(fixture, "draft.key"),
]);
const evidence = {
  worker: name,
  persistentRetries: true,
  coalesced: 3,
  restartRecovery: true,
  alertFired: pending.alertActive,
  alertResolved: !recovered.alertActive,
  pendingFailures: pending.failures,
  final: recovered,
};
await mkdir(resolve(root, ".artifacts"), { recursive: true });
await writeFile(
  resolve(root, ".artifacts/remote-ci.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence, null, 2));
