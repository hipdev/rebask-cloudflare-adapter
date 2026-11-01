import test from "node:test";
import assert from "node:assert/strict";
import worker from "../examples/monitor/worker.mjs";
const secret = "a".repeat(48);
test("monitor rejects missing/wrong tokens and non-GET before invoking private RPC", async () => {
  let calls = 0;
  const env = {
    MONITOR_TOKEN: secret,
    APP: {
      adapterHealth() {
        calls++;
        throw Error("must not execute");
      },
    },
  };
  for (const request of [
    new Request("https://monitor.example/health"),
    new Request("https://monitor.example/health", {
      headers: { authorization: "Bearer wrong" },
    }),
    new Request("https://monitor.example/health", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
  ])
    assert.equal((await worker.fetch(request, env)).status, 404);
  assert.equal(calls, 0);
});
test("monitor exposes only aggregate health and never purges or forwards credentials", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (request, options) => {
    calls++;
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    return new Response("public HTML");
  };
  try {
    const env = {
      MONITOR_TOKEN: secret,
      APP_ORIGIN: "https://app.example",
      APP: {
        adapterHealth: async () => ({
          pending: false,
          alertActive: false,
          attempts: 0,
          pendingAgeMs: 0,
          private: "never expose",
        }),
        purgePageCache() {
          throw Error("must not purge");
        },
      },
    };
    const req = new Request("https://monitor.example/health", {
      headers: { authorization: `Bearer ${secret}` },
    });
    const good = await worker.fetch(req, env);
    assert.equal(good.status, 200);
    assert.match(good.headers.get("cache-control"), /no-store/);
    assert.doesNotMatch(await good.text(), /private|public HTML|https:|Bearer/);
    assert.equal(calls, 2);
    env.APP.adapterHealth = async () => ({
      pending: true,
      alertActive: true,
      attempts: 3,
      pendingAgeMs: 60000,
    });
    assert.equal((await worker.fetch(req, env)).status, 503);
    env.APP.adapterHealth = async () => {
      throw Error("private exception");
    };
    assert.doesNotMatch(
      await (await worker.fetch(req, env)).text(),
      /private exception/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("GitHub alert delivery deduplicates failures and closes recovery without sending secrets", async () => {
  const original = globalThis.fetch,
    keys = [
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY",
      "GITHUB_RUN_ID",
      "ADAPTER_MONITOR_URL",
      "ADAPTER_MONITOR_TOKEN",
      "ALERT_CATEGORY",
      "ALERT_TEST_MODE",
    ];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    GITHUB_TOKEN: "fake-gh-secret",
    GITHUB_REPOSITORY: "example/adapter",
    GITHUB_RUN_ID: "1",
    ADAPTER_MONITOR_URL: "https://monitor.example/health",
    ADAPTER_MONITOR_TOKEN: "fake-monitor-secret",
    ALERT_CATEGORY: "production",
    ALERT_TEST_MODE: "none",
  });
  let healthy = false,
    incident = null,
    created = 0,
    closed = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith("https://monitor.example/"))
      return Response.json(
        {
          ok: healthy,
          purge: { alertActive: !healthy },
          checks: [{ status: healthy ? 200 : 503, ms: 10 }],
          private: "never disclose",
        },
        { status: healthy ? 200 : 503 },
      );
    assert.ok(
      String(url).startsWith("https://api.github.com/repos/example/adapter/"),
    );
    if (!options.method || options.method === "GET")
      return Response.json(incident ? [incident] : []);
    const body = JSON.parse(options.body);
    assert.doesNotMatch(
      options.body,
      /fake-gh-secret|fake-monitor-secret|never disclose/,
    );
    if (options.method === "POST") {
      created++;
      incident = { ...body, number: 5 };
      return Response.json(incident, { status: 201 });
    }
    closed++;
    assert.equal(body.state, "closed");
    incident = null;
    return Response.json(body);
  };
  try {
    for (let n = 0; n < 2; n++)
      await import(`../scripts/monitor-alert.mjs?failure=${n}`);
    assert.equal(created, 1);
    healthy = true;
    await import("../scripts/monitor-alert.mjs?recovery");
    assert.equal(closed, 1);
  } finally {
    globalThis.fetch = original;
    for (const k of keys)
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
  }
});
