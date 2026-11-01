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
test("captured request states retain late reads across lost callback context", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const context = new AsyncLocalStorage();
  const capture = Function(
    "RequestStorage",
    `return function(){${patchRscTrailer(`    if (trailer && rscStream) {\n const usedSearch = getUsedSearch();\n return () => usedSearch;\n}`).replace("const usedSearch = requestState.usedSearch;", "return () => requestState.usedSearch;").replace("if (trailer && rscStream)", "if (true)")}}`,
  )(context);
  const a = { state: { usedSearch: new Map() } },
    b = { state: { usedSearch: new Map() } };
  const fa = context.run(a, capture),
    fb = context.run(b, capture);
  a.state.usedSearch.set("q", ["late"]);
  b.state.usedSearch.set("q", "other");
  assert.deepEqual(fa().get("q"), ["late"]);
  assert.equal(fb().get("q"), "other");
  assert.equal(context.getStore(), undefined);
});
