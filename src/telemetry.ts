export interface TelemetryOptions {
  slowHeadersMs?: number;
}
/** Execution metrics only: managed cache HITs do not run this code. */
export async function observeRequest(
  request: Request,
  options: TelemetryOptions | undefined,
  task: () => Promise<Response>,
): Promise<Response> {
  if (!options) return task();
  const start = performance.now();
  try {
    const response = await task(),
      headersMs = Math.round(performance.now() - start);
    const metric = {
      event: "rebask.request",
      method: request.method,
      status: response.status,
      headersMs,
      ppr: response.headers.get("x-rebask-prerender") === "1",
      draft: response.headers.get("x-rebask-draft") === "1",
      cacheMode: response.headers.get("x-rebask-cdn") ?? "none",
    };
    console.log(metric);
    if (response.status >= 500)
      console.error({
        event: "rebask.alert",
        kind: "request_error",
        status: response.status,
      });
    if (headersMs >= (options.slowHeadersMs ?? 5000))
      console.warn({ event: "rebask.alert", kind: "slow_headers", headersMs });
    return response;
  } catch (error) {
    console.error({
      event: "rebask.alert",
      kind: "request_exception",
      headersMs: Math.round(performance.now() - start),
    });
    throw error;
  }
}
