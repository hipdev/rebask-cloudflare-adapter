import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { patchRscTrailer } from "../dist/compatibility.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const core = dirname(require.resolve("@rebask/core/package.json"));
const context = await import(pathToFileURL(`${core}/dist/request-context.js`));
const source = patchRscTrailer(
  await readFile(`${core}/dist/lib/rsc-request.js`, "utf8"),
);
const ast = ts.createSourceFile(
  "rsc-request.js",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const fn = ast.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "createRscResponse",
);
assert.ok(fn, "Pinned Rebask RSC response function must exist");
// Exercise the published response function with the actual request AsyncLocalStorage.
// Stub unrelated renderer/platform imports so this regression does not need a Vite build.
// Reproduce the callback context loss observed in Node24 production prerender.
class ContextlessTransformStream extends TransformStream {
  constructor(transformer) {
    super({
      ...transformer,
      flush(controller) {
        return context.RequestStorage.exit(() => transformer.flush(controller));
      },
    });
  }
}
const createResponse = new Function(
  "TransformStream",
  "randomBytes",
  "pprConfig",
  "RebaskCacheStatus",
  "TEXT_ENCODER",
  "getUsedSearch",
  "RequestStorage",
  "mergeResponseHeaders",
  "cacheStatusHeader",
  "getDeploymentIdHeader",
  "REBASK_RSC_VARY_HEADER",
  "REBASK_TAIL_HEADER",
  "REBASK_TRAILER_HEADER",
  `${fn.getText(ast).replace(/^export /, "")}; return createRscResponse;`,
)(
  ContextlessTransformStream,
  randomBytes,
  {},
  { MISS: "MISS" },
  new TextEncoder(),
  context.getUsedSearch,
  context.RequestStorage,
  context.mergeResponseHeaders,
  () => ({}),
  () => ({}),
  "accept",
  "x-rebask-tail",
  "x-rebask-trailer",
);

function responseFor(value) {
  let controller;
  const response = context.withRequestStorage(
    { input: { request: new Request("https://example.test/") } },
    () => {
      const stream = new ReadableStream({
        start(c) {
          controller = c;
        },
      });
      const response = createResponse(stream, { trailer: true });
      // Search reads may happen during rendering, after the response was created.
      if (value !== undefined) context.trackSearchParam("q", value);
      return response;
    },
  );
  return { response, controller };
}
async function consume({ response, controller }) {
  const body = response.text();
  controller.enqueue(new TextEncoder().encode("RSC payload"));
  controller.close();
  const text = await body;
  const nonce = response.headers.get("x-rebask-trailer");
  assert.ok(nonce);
  const [payload, trailer] = text.split(`\r\n--${nonce}\r\n`);
  assert.equal(payload, "RSC payload");
  return JSON.parse(trailer);
}

test("RSC trailers finish outside request context and keep concurrent request search values isolated", async () => {
  const first = responseFor(["one", "two"]);
  const second = responseFor("other");
  assert.equal(context.RequestStorage.getStore(), undefined);
  const [a, b] = await Promise.all([consume(first), consume(second)]);
  assert.deepEqual(a, { used: { q: ["one", "two"] } });
  assert.deepEqual(b, { used: { q: "other" } });
});
test("RSC trailer without search reads contains no other request values", async () => {
  assert.deepEqual(await consume(responseFor()), { used: {} });
});
