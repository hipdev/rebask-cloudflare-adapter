import type { CacheNamespace } from "./runtime.js";

export interface PageCacheOptions {
  /** Exact paths. Only native, fresh, complete public HTML can be stored. */
  paths: string[];
  /** cache-api preserves 0.3 semantics; workers-cache uses the managed front cache. */
  mode?: "cache-api" | "workers-cache";
  /** Maximum edge lifetime in seconds, further capped by native entry freshness. */
  maxAge?: number;
}
export function pageCacheEligible(
  request: Request,
  options?: PageCacheOptions,
): boolean {
  const url = new URL(request.url);
  return (
    !!options?.paths.includes(url.pathname) &&
    request.method === "GET" &&
    !url.search &&
    ![
      "cookie",
      "authorization",
      "range",
      "if-none-match",
      "if-modified-since",
      "x-rsc-action",
      "x-rebask-tree",
      "x-rebask-shell",
      "x-rebask-tail",
      "x-rebask-resume",
    ].some((h) => request.headers.has(h)) &&
    !request.headers.get("accept")?.toLowerCase().includes("text/x-component")
  );
}
export function pageCacheTTL(
  response: Response,
  freshUntil: number,
  maxAge = 60,
): number {
  if (!Number.isFinite(freshUntil)) return 0;
  const h = response.headers,
    control = h.get("cache-control") ?? "";
  if (
    response.status !== 200 ||
    h.has("set-cookie") ||
    h.has("x-rebask-prerender") ||
    h.get("x-rebask-cache") !== "HIT" ||
    !h.get("content-type")?.startsWith("text/html") ||
    /private|no-store|no-cache/i.test(control) ||
    (h.get("vary") ?? "")
      .split(",")
      .some(
        (v) =>
          v.trim() &&
          !["accept", "x-rebask-tree", "accept-encoding"].includes(
            v.trim().toLowerCase(),
          ),
      )
  )
    return 0;
  const native = Number(/(?:^|[,\s])s-maxage=(\d+)/i.exec(control)?.[1] ?? 0);
  return Math.max(
    0,
    Math.floor(Math.min(maxAge, native, (freshUntil - Date.now()) / 1000)),
  );
}
/** Every acknowledged tag invalidation advances every shard. A single epoch fences CDN keys. */
export async function edgeGeneration(
  namespace: CacheNamespace,
): Promise<number> {
  return namespace.getByName("rebask-cache-v1-0").generation();
}
export function edgeKey(
  request: Request,
  deployment: string,
  generation: number,
): Request {
  const url = new URL(request.url);
  url.pathname = `/_rebask_cdn/${deployment}/${generation}${url.pathname}`;
  return new Request(url, { method: "GET" });
}
