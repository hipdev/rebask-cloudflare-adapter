import { pageCacheTTL } from "./edge.js";

/** One purge identity for every managed page variant; never include viewer data. */
export const PAGE_CACHE_TAG = "rebask-pages-v1";
/** Vary is evaluated by Cloudflare BEFORE the Worker. Missing values are the public variant. */
export const PAGE_CACHE_VARY = [
  "accept",
  "accept-encoding",
  "host",
  "cookie",
  "authorization",
  "x-rsc-action",
  "x-rebask-tree",
  "x-rebask-shell",
  "x-rebask-tail",
  "x-rebask-resume",
  "if-none-match",
  "if-modified-since",
].join(", ");

export async function purgeWorkersPages(
  cache: Pick<CacheContext, "purge"> | undefined,
): Promise<void> {
  if (!cache || typeof cache.purge !== "function")
    throw new Error(
      "Workers Cache purge API unavailable; invalidation was not acknowledged",
    );
  const result = await cache.purge({ tags: [PAGE_CACHE_TAG] });
  if (!result.success)
    throw new Error("Workers Cache page purge failed; retry tag invalidation");
}
/** Browser caches stay disabled. Cloudflare consumes its own cache-control directive. */
export function workersCacheHeaders(
  response: Response,
  eligible: boolean,
  freshUntil: number,
  maxAge: number,
  execution: string,
): Headers {
  const ttl = eligible ? pageCacheTTL(response, freshUntil, maxAge) : 0;
  const headers = new Headers(response.headers);
  // Override every CDN directive inherited from application handlers.
  headers.set("cache-control", "private, no-store");
  headers.delete("cdn-cache-control");
  headers.set(
    "cloudflare-cdn-cache-control",
    ttl > 0 ? `public, max-age=${ttl}, must-revalidate` : "no-store",
  );
  headers.set("x-rebask-worker-execution", execution);
  headers.set("x-rebask-cdn", ttl > 0 ? "WORKERS-CACHE" : "BYPASS");
  if (ttl > 0) {
    headers.set("cache-tag", PAGE_CACHE_TAG);
    headers.set("vary", PAGE_CACHE_VARY);
  } else {
    headers.delete("cache-tag");
  }
  return headers;
}

export interface PurgeCoordinator {
  requestPurge(): Promise<{ confirmed: boolean; pending: boolean }>;
}
export async function persistPagePurge(
  coordinator: PurgeCoordinator,
): Promise<void> {
  const result = await coordinator.requestPurge();
  if (!result.confirmed)
    throw new Error(
      "Page purge is durably queued; automatic retries are scheduled",
    );
}
