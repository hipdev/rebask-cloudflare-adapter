import assert from "node:assert/strict";
import test from "node:test";
import {
  createDraftCookie,
  verifyDraftCookie,
  clearDraftCookie,
} from "../dist/draft.js";
import {
  pageCacheEligible,
  pageCacheTTL,
  edgeKey,
  edgeGeneration,
} from "../dist/edge.js";
import { imageParameters, optimizeImage } from "../dist/images.js";
const secret = "test-only-random-secret-01234567890123456789";
test("draft cookies are signed, bounded, host-only and tamper/expiry/duplicate safe", async () => {
  const signed = await createDraftCookie(secret);
  assert.match(signed, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600/);
  const cookie = signed.split(";")[0],
    req = (value) =>
      new Request("https://example.com", { headers: { cookie: value } });
  assert.equal(await verifyDraftCookie(req(cookie), secret), true);
  for (const value of [
    cookie + "a",
    cookie.replace(/=\d+/, "=1000000000"),
    cookie + "; " + cookie,
  ])
    assert.equal(await verifyDraftCookie(req(value), secret), false);
  assert.equal(
    await verifyDraftCookie(req(cookie), secret + "different"),
    false,
  );
  assert.equal(await verifyDraftCookie(req(cookie)), false);
  await assert.rejects(createDraftCookie("short"));
  await assert.rejects(createDraftCookie(secret, 86401));
  assert.match(clearDraftCookie(), /Max-Age=0/);
});
test("CDN admits only exact anonymous HTML; freshness never outlives native entry", () => {
  const options = { paths: ["/public"] },
    make = (path = "/public", headers = {}) =>
      new Request("https://example.com" + path, { headers });
  assert.equal(pageCacheEligible(make(), options), true);
  for (const r of [
    make("/private"),
    make("/public?q=x"),
    ...[
      "cookie",
      "authorization",
      "range",
      "x-rebask-tail",
      "x-rebask-tree",
    ].map((h) => make("/public", { [h]: "1" })),
    make("/public", { accept: "text/x-component" }),
  ])
    assert.equal(pageCacheEligible(r, options), false);
  const headers = {
    "content-type": "text/html",
    "cache-control": "s-maxage=300",
    "x-rebask-cache": "HIT",
    vary: "accept, x-rebask-tree",
  };
  const ttl = pageCacheTTL(
    new Response("public", { headers }),
    Date.now() + 3000,
    60,
  );
  assert.ok(ttl > 0 && ttl <= 3);
  for (const extra of [
    { "x-rebask-prerender": "1" },
    { "set-cookie": "private" },
    { "cache-control": "private, no-store" },
    { "x-rebask-cache": "STALE" },
    { vary: "Cookie" },
    { "content-type": "text/x-component" },
  ])
    assert.equal(
      pageCacheTTL(
        new Response("private", { headers: { ...headers, ...extra } }),
        Date.now() + 3000,
      ),
      0,
    );
  assert.equal(
    pageCacheTTL(new Response("old", { headers }), Date.now() - 1000),
    0,
  );
  assert.notEqual(
    edgeKey(make(), "deployment", 1).url,
    edgeKey(make(), "deployment", 2).url,
  );
});
test("image optimizer refuses remote/private/traversal/SVG/parameter amplification", () => {
  const options = { localPrefixes: ["/images/"] },
    parse = (src) =>
      imageParameters(
        new Request(
          "https://example.com/_rebask/image?" +
            new URLSearchParams({ url: src, w: "128", q: "75" }),
        ),
        options,
      );
  assert.ok(parse("/images/public.png"));
  for (const src of [
    "https://example.com/images/a.png",
    "//evil/a.png",
    "/private/a.png",
    "/images/../secret.png",
    "/images/%2e%2e/a.png",
    "/images/a.svg",
    "/images/a.png?token=secret",
    "/images/\\evil.png",
  ])
    assert.equal(parse(src), null, src);
  assert.equal(
    imageParameters(
      new Request(
        "https://example.com/_rebask/image?url=/images/a.png&w=1&q=75",
      ),
      options,
    ),
    null,
  );
});
test("image binding receives only public asset bytes and caches transformed representations", async () => {
  let calls = 0;
  const entries = new Map(),
    pending = [];
  const cache = {
    match: async (key) => entries.get(key.url)?.clone(),
    put: async (key, value) => {
      entries.set(key.url, value);
    },
  };
  const env = {
    ASSETS: {
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, "/images/public.png");
        assert.equal(request.headers.has("cookie"), false);
        return new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/png" },
        });
      },
    },
    REBASK_IMAGES: {
      input: (stream) => ({
        transform: (opts) => {
          assert.equal(opts.width, 128);
          return {
            output: async (opts) => {
              calls++;
              assert.equal(opts.format, "image/webp");
              await new Response(stream).arrayBuffer();
              return {
                response: () =>
                  new Response("transformed", {
                    headers: { "content-type": opts.format },
                  }),
              };
            },
          };
        },
      }),
    },
  };
  const request = new Request(
    "https://example.com/_rebask/image?url=/images/public.png&w=128&q=75",
    { headers: { accept: "image/webp", cookie: "private=1" } },
  );
  const run = () =>
    optimizeImage(
      request,
      env,
      { localPrefixes: ["/images/"] },
      "build",
      cache,
      (p) => pending.push(p),
    );
  const first = await run();
  assert.equal(first.headers.get("x-rebask-image-cache"), "MISS");
  await Promise.all(pending);
  const second = await run();
  assert.equal(second.headers.get("x-rebask-image-cache"), "HIT");
  assert.equal(calls, 1);
  assert.equal(await second.text(), "transformed");
});

test("managed cache headers isolate auth/draft/protocol variants before execution", async () => {
  const {
    workersCacheHeaders,
    PAGE_CACHE_VARY,
    PAGE_CACHE_TAG,
    purgeWorkersPages,
  } = await import("../dist/workers-cache.js");
  const response = new Response("public", {
    headers: {
      "content-type": "text/html",
      "cache-control": "s-maxage=300",
      "x-rebask-cache": "HIT",
    },
  });
  const h = workersCacheHeaders(
    response,
    true,
    Date.now() + 30_000,
    20,
    "origin-a",
  );
  assert.match(
    h.get("cloudflare-cdn-cache-control"),
    /^public, max-age=\d+, must-revalidate$/,
  );
  assert.equal(h.get("cache-control"), "private, no-store");
  for (const name of [
    "cookie",
    "authorization",
    "accept",
    "x-rebask-tail",
    "x-rebask-shell",
    "x-rebask-tree",
    "x-rebask-resume",
    "host",
  ])
    assert.ok(PAGE_CACHE_VARY.split(", ").includes(name));
  assert.equal(h.get("cache-tag"), PAGE_CACHE_TAG);
  const bypass = workersCacheHeaders(
    response,
    false,
    Date.now() + 30_000,
    20,
    "origin-b",
  );
  assert.equal(bypass.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(bypass.get("cache-tag"), null);
  assert.notEqual(
    h.get("x-rebask-worker-execution"),
    bypass.get("x-rebask-worker-execution"),
  );
  let called = false;
  await purgeWorkersPages({
    purge: async (options) => {
      called = true;
      assert.deepEqual(options, { tags: [PAGE_CACHE_TAG] });
      return { success: true, errors: [] };
    },
  });
  assert.ok(called);
  await assert.rejects(purgeWorkersPages(undefined), /unavailable/);
  await assert.rejects(
    purgeWorkersPages({
      purge: async () => ({
        success: false,
        errors: [{ code: 1, message: "unavailable" }],
      }),
    }),
    /failed/,
  );
});
