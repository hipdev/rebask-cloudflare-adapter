export interface ImageOptions {
  /** Only public, local raster assets. No remote fetches or authenticated sources. */
  localPrefixes: string[];
  widths?: number[];
  qualities?: number[];
}
const WIDTHS = [
  32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840,
];
export function imageParameters(request: Request, options: ImageOptions) {
  const url = new URL(request.url),
    src = url.searchParams.get("url") ?? "";
  const width = Number(url.searchParams.get("w")),
    quality = Number(url.searchParams.get("q") ?? "75");
  if (
    [...url.searchParams.keys()].some((k) => !["url", "w", "q"].includes(k)) ||
    ["url", "w", "q"].some((k) => url.searchParams.getAll(k).length > 1) ||
    !src.startsWith("/") ||
    src.startsWith("//") ||
    /[%\\?#\u0000-\u0020]/.test(src) ||
    src.split("/").some((s) => s === "." || s === "..") ||
    !options.localPrefixes.some((prefix) => src.startsWith(prefix)) ||
    !/\.(?:png|jpe?g|webp|avif)$/i.test(src) ||
    !(options.widths ?? WIDTHS).includes(width) ||
    !(options.qualities ?? [75]).includes(quality)
  )
    return null;
  const accept = request.headers.get("accept") ?? "";
  const format = accept.includes("image/avif")
    ? "image/avif"
    : accept.includes("image/webp")
      ? "image/webp"
      : "image/jpeg";
  return { src, width, quality, format };
}
export async function optimizeImage(
  request: Request,
  env: { ASSETS: Fetcher; REBASK_IMAGES?: ImagesBinding },
  options: ImageOptions,
  deployment: string,
  cache: Cache,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  const p = imageParameters(request, options);
  if (!p)
    return new Response("Unsupported image source or parameters", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  if (!env.REBASK_IMAGES)
    return new Response("Images binding unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  const url = new URL(request.url);
  url.pathname = `/_rebask_image_cache/${deployment}`;
  url.search = new URLSearchParams({
    src: p.src,
    w: String(p.width),
    q: String(p.quality),
    format: p.format,
  }).toString();
  const cacheKey = new Request(url),
    hit = await cache.match(cacheKey);
  if (hit) return imageResponse(hit, request.method === "HEAD", "HIT");
  const source = await env.ASSETS.fetch(
    new Request(new URL(p.src, request.url)),
  );
  if (
    !source.ok ||
    !source.body ||
    !/^image\/(png|jpeg|webp|avif)(;|$)/i.test(
      source.headers.get("content-type") ?? "",
    )
  )
    return new Response("Image not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  let size = 0;
  const limited = source.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > 8_000_000) throw new Error("Image source exceeds 8 MB");
        controller.enqueue(chunk);
      },
    }),
  );
  try {
    const result = await env.REBASK_IMAGES.input(limited)
      .transform({ width: p.width, fit: "scale-down" })
      .output({
        format: p.format as "image/webp",
        quality: p.quality,
        anim: false,
      });
    const response = result.response();
    response.headers.set("cache-control", "public, max-age=3600");
    response.headers.set("vary", "Accept");
    response.headers.set(
      "content-security-policy",
      "default-src 'none'; sandbox",
    );
    response.headers.set("x-content-type-options", "nosniff");
    waitUntil(cache.put(cacheKey, response.clone()));
    return imageResponse(response, request.method === "HEAD", "MISS");
  } catch {
    return new Response("Image transformation failed", {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }
}
function imageResponse(response: Response, head: boolean, status: string) {
  const headers = new Headers(response.headers);
  headers.set("x-rebask-image-cache", status);
  return new Response(head ? null : response.body, {
    status: response.status,
    headers,
  });
}
