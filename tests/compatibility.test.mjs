import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { patchRscTrailer } from "../dist/compatibility.js";
const require = createRequire(import.meta.url);
const source = await readFile(
  `${dirname(require.resolve("@rebask/core/package.json"))}/dist/lib/rsc-request.js`,
  "utf8",
);
test("Node24 compatibility targets actual pinned core and is idempotent", () => {
  const patched = patchRscTrailer(source);
  assert.ok(patched.includes("const usedSearch = requestState.usedSearch;"));
  assert.equal(patchRscTrailer(patched), patched);
  assert.throws(() => patchRscTrailer("changed upstream"), /changed/);
});
