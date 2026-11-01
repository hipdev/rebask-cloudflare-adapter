// Operational companion: no purge API, user credentials, cookies or application data.
const response = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", vary: "Authorization" },
  });
async function authorized(request, secret) {
  if (typeof secret !== "string" || secret.length < 32) return false;
  const digest = async (value) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    );
  const [a, b] = await Promise.all([
    digest(request.headers.get("authorization") ?? ""),
    digest(`Bearer ${secret}`),
  ]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export default {
  async fetch(request, env) {
    if (
      new URL(request.url).pathname !== "/health" ||
      request.method !== "GET" ||
      !(await authorized(request, env.MONITOR_TOKEN))
    )
      return response({ error: "Not found" }, 404);
    try {
      const health = await env.APP.adapterHealth();
      if (!health || typeof health.alertActive !== "boolean")
        throw Error("Missing health RPC");
      const checks = [];
      for (const path of ["/en/terms", "/es/dashboard/explore"]) {
        const start = performance.now();
        const result = await fetch(new URL(path, env.APP_ORIGIN), {
          headers: { accept: "text/html" },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        await result.arrayBuffer();
        checks.push({
          status: result.status,
          ms: Math.round(performance.now() - start),
        });
      }
      const ok =
        !health.alertActive &&
        checks.every((check) => check.status === 200 && check.ms < 5000);
      return response(
        {
          ok,
          purge: {
            pending: !!health.pending,
            alertActive: health.alertActive,
            attempts: health.attempts,
            pendingAgeMs: health.pendingAgeMs,
          },
          checks,
        },
        ok ? 200 : 503,
      );
    } catch {
      return response(
        { ok: false, error: "adapter-or-public-route-unavailable" },
        503,
      );
    }
  },
};
