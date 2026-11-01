import test from "node:test";
import assert from "node:assert/strict";
import { observeRequest } from "../dist/telemetry.js";
test("metrics and alerts never include request secrets or exception contents", async () => {
  const events = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  for (const level of Object.keys(original))
    console[level] = (event) => events.push({ level, ...event });
  try {
    const req = new Request(
      "https://private.example/secret?token=private-value",
      { headers: { cookie: "secret-cookie", authorization: "secret-auth" } },
    );
    await observeRequest(
      req,
      { slowHeadersMs: 0 },
      async () =>
        new Response(null, {
          status: 503,
          headers: { "x-rebask-prerender": "1" },
        }),
    );
    await assert.rejects(
      observeRequest(req, {}, async () => {
        throw Error("private-exception");
      }),
    );
    assert.ok(events.some((e) => e.kind === "request_error"));
    assert.ok(events.some((e) => e.kind === "slow_headers"));
    assert.ok(events.some((e) => e.kind === "request_exception"));
    assert.ok(events.some((e) => e.event === "rebask.request" && e.ppr));
    assert.doesNotMatch(
      JSON.stringify(events),
      /private|secret|token|authorization/,
    );
  } finally {
    Object.assign(console, original);
  }
});
