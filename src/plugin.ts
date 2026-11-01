import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { patchRscTrailer } from "./compatibility.js";

import type { PageCacheOptions } from "./edge.js";
import type { TelemetryOptions } from "./telemetry.js";
import type { ImageOptions } from "./images.js";

export interface CloudflareAdapterOptions {
  durableCache?: boolean;
  pageCache?: PageCacheOptions;
  draftMode?: boolean;
  images?: ImageOptions;
  telemetry?: TelemetryOptions;
}

const virtualArtifacts = "virtual:rebask-cloudflare/artifacts";

/** Community deployment adapter for pinned Rebask 0.2.0. */
export function cloudflareAdapter(
  options: CloudflareAdapterOptions = {},
): Plugin {
  assert.ok(
    !options.pageCache || options.durableCache,
    "CDN pages require durableCache for invalidation fencing",
  );
  assert.ok(
    !options.pageCache?.mode ||
      ["cache-api", "workers-cache"].includes(options.pageCache.mode),
    "Unknown page cache mode",
  );
  assert.ok(
    !options.telemetry ||
      (Number.isFinite(options.telemetry.slowHeadersMs ?? 5000) &&
        (options.telemetry.slowHeadersMs ?? 5000) >= 0),
    "Telemetry slowHeadersMs must be a finite nonnegative number",
  );
  for (const path of options.pageCache?.paths ?? [])
    assert.ok(
      /^\/(?!\/)[^?#%\\]*$/.test(path),
      "CDN paths must be exact absolute local paths",
    );
  assert.ok(
    !options.pageCache ||
      (Number.isInteger(options.pageCache.maxAge ?? 60) &&
        (options.pageCache.maxAge ?? 60) > 0 &&
        (options.pageCache.maxAge ?? 60) <= 3600),
    "CDN maxAge must be 1–3600 seconds",
  );
  for (const prefix of options.images?.localPrefixes ?? [])
    assert.ok(
      prefix.startsWith("/") &&
        !prefix.startsWith("//") &&
        prefix.endsWith("/") &&
        !/[?#%\\]/.test(prefix),
      "Image prefixes must be absolute public directory paths ending in /",
    );
  let runtimeFile: string;
  let root: string;
  let artifactFile: string;
  return {
    name: "rebask-cloudflare:ppr",
    enforce: "pre",
    config() {
      // The cache factory imports a virtual build artifact; never externalize it
      // when the consumer installs this adapter from npm rather than local source.
      return {
        ssr: { noExternal: ["rebask-cloudflare-adapter"] },
        environments: {
          rsc: { resolve: { noExternal: ["rebask-cloudflare-adapter"] } },
        },
      };
    },
    async configResolved(config) {
      root = config.root;
      const require = createRequire(resolve(root, "package.json"));
      const core = JSON.parse(
        await readFile(require.resolve("@rebask/core/package.json"), "utf8"),
      );
      assert.equal(
        core.version,
        "0.2.0",
        "This adapter supports @rebask/core 0.2.0 only; review compatibility before upgrading",
      );
      assert.ok(
        !config.build.ssr,
        "Use the native Rebask multi-environment build",
      );
      artifactFile = resolve(root, ".cache/cloudflare/ppr-artifacts.mjs");
      await mkdir(resolve(root, ".cache/cloudflare"), { recursive: true });
      // The Node build/prerender uses filesystem storage. After it completes,
      // replace this external module with the generated immutable artifacts.
      await writeFile(artifactFile, "export const artifacts = null;\n");
      runtimeFile = resolve(root, ".cache/cloudflare/runtime.mjs");
      await cp(
        fileURLToPath(new URL("./runtime.js", import.meta.url)),
        runtimeFile,
      );
    },
    resolveId(id, importer) {
      if (
        id === "rebask-cloudflare-adapter/runtime" ||
        (id === "./runtime.js" &&
          importer
            ?.replaceAll("\\", "/")
            .match(
              /\/rebask-cloudflare-adapter\/dist\/(?:durable-storage|storage)\.js$/,
            ))
      )
        return { id: runtimeFile, external: true };
      if (id === virtualArtifacts) return { id: artifactFile, external: true };
    },
    transform(code, id) {
      if (
        options.draftMode &&
        /\/@rebask\/core\/dist\/lib\/(use-cache-runtime|durable-cache)\.js$/.test(
          id.replaceAll("\\", "/"),
        )
      ) {
        const condition = id.includes("use-cache-runtime")
          ? "if (isDevelopment) {"
          : "if (import.meta.env.DEV) {";
        assert.equal(
          code.split(condition).length,
          2,
          "Rebask cache bypass changed; review Draft Mode compatibility",
        );
        return {
          code:
            'import { isDraftMode } from "rebask-cloudflare-adapter/runtime";\n' +
            code.replace(
              condition,
              condition.replace(")", " || isDraftMode())"),
            ),
          map: null,
        };
      }
      if (
        options.durableCache &&
        id
          .replaceAll("\\", "/")
          .endsWith("/@rebask/core/dist/lib/background-revalidation.js")
      ) {
        assert.equal(
          code.split("    runRevalidation();").length,
          2,
          "Rebask background scheduling changed; review Workers lifetime bridge",
        );
        return {
          code:
            'import { runCacheTask } from "rebask-cloudflare-adapter/runtime";\n' +
            code.replace(
              "    runRevalidation();",
              "    runCacheTask(runRevalidation);",
            ),
          map: null,
        };
      }
      if (
        id
          .replaceAll("\\", "/")
          .endsWith("/@rebask/core/dist/lib/rsc-request.js")
      ) {
        return { code: patchRscTrailer(code), map: null };
      }
      if (
        !id
          .replaceAll("\\", "/")
          .endsWith("/@rebask/core/dist/lib/prerender-paths.js")
      )
        return;
      const original =
        'const raw = await readFile(manifestPath, "utf8");\n                const manifest = JSON.parse(raw);';
      assert.ok(
        code.includes(original),
        "Rebask prerender manifest loader changed; review the Workers adapter",
      );
      return {
        code:
          `import { artifacts as workerArtifacts } from ${JSON.stringify(virtualArtifacts)};\n` +
          code.replace(
            original,
            'const manifest = workerArtifacts?.manifest ?? JSON.parse(await readFile(manifestPath, "utf8"));',
          ),
        map: null,
      };
    },
    generateBundle(_options, bundle) {
      const outDir = resolve(root, this.environment.config.build.outDir);
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const file of [artifactFile, runtimeFile]) {
          if (!chunk.code.includes(JSON.stringify(file))) continue;
          let path = relative(
            dirname(resolve(outDir, chunk.fileName)),
            file,
          ).replaceAll("\\", "/");
          if (!path.startsWith(".")) path = `./${path}`;
          chunk.code = chunk.code.replaceAll(
            JSON.stringify(file),
            JSON.stringify(path),
          );
        }
      }
    },
    buildApp: {
      order: "post",
      async handler() {
        const rscRoot = resolve(root, "dist/rsc");
        const scripts = (await readdir(rscRoot, { recursive: true })).filter(
          (file) => file.endsWith(".js"),
        );
        const ids = new Set<string>();
        for (const file of scripts) {
          const code = await readFile(resolve(rscRoot, file), "utf8");
          for (const match of code.matchAll(/var deploymentId = "([^"]+)"/g))
            ids.add(match[1]!);
        }
        assert.equal(
          ids.size,
          1,
          "Expected one pinned Rebask deployment identifier across RSC chunks",
        );
        const deploymentId = [...ids][0]!;
        const manifest = JSON.parse(
          await readFile(
            resolve(root, "dist/.rebask/prerendered-paths.json"),
            "utf8",
          ),
        );
        const entries: Record<string, unknown> = {};
        const cacheRoot = resolve(root, "dist/.rebask/cache");
        const cacheFiles: { directory: string; file: string }[] = [];
        for (const directory of options.durableCache
          ? ["scoped", "durable"]
          : ["scoped"]) {
          for (const file of await readdir(resolve(cacheRoot, directory)))
            cacheFiles.push({ directory, file });
        }
        for (const { directory, file } of cacheFiles) {
          if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
          const entry = JSON.parse(
            await readFile(resolve(cacheRoot, directory, file), "utf8"),
          );
          if (!options.durableCache && entry.type !== 1 && entry.type !== 2)
            continue;
          assert.ok(
            options.durableCache || !entry.tags?.length,
            "Tagged cache entries need durable invalidation; do not bundle them as immutable output",
          );
          entries[file.slice(0, -5)] = entry;
        }
        assert.ok(
          Object.keys(entries).length,
          "Worker cannot deploy without generated PPR artifacts",
        );
        await writeFile(
          artifactFile,
          `export const artifacts = ${JSON.stringify({ deploymentId, manifest, entries, durableCache: !!options.durableCache })};\n`,
        );
        const output = resolve(root, ".output");
        await rm(output, { recursive: true, force: true });
        await mkdir(resolve(output, "server"), { recursive: true });
        await cp(resolve(root, "dist/client"), resolve(output, "public"), {
          recursive: true,
        });
        await writeFile(
          resolve(output, "server/worker.mjs"),
          `import { WorkerEntrypoint } from "cloudflare:workers";
import app from "../../dist/rsc/index.js";
import { withCacheRequest, pageFreshUntil } from "../../.cache/cloudflare/runtime.mjs";
import { verifyDraftCookie } from "rebask-cloudflare-adapter/draft";
import { pageCacheEligible, pageCacheTTL, edgeGeneration, edgeKey } from "rebask-cloudflare-adapter/edge";
import { optimizeImage } from "rebask-cloudflare-adapter/images";
import { observeRequest } from "rebask-cloudflare-adapter/telemetry";
import { workersCacheHeaders, purgeWorkersPages, persistPagePurge } from "rebask-cloudflare-adapter/workers-cache";
${options.durableCache ? 'export { RebaskCache } from "rebask-cloudflare-adapter/durable-object";' : ""}
const options = ${JSON.stringify(options)};
const deployment = ${JSON.stringify(deploymentId)};
export default class RebaskWorker extends WorkerEntrypoint {
  fetch(request) { return observeRequest(request, options.telemetry, () => handle(request, this.env, this.ctx)); }
  async purgePageCache() { await purgeWorkersPages(this.ctx.cache); }
  async adapterHealth() { return this.env.REBASK_PURGE?.getByName("pages-v1").health(); }
}
${options.pageCache?.mode === "workers-cache" ? 'export { RebaskPurge } from "rebask-cloudflare-adapter/purge-object";' : ""}
async function handle(request, env, ctx) {
    const managed = options.pageCache?.mode === "workers-cache";
    // Fresh on EVERY invocation, including internal Cache API HITs. A managed HIT
    // preserves the previous ID because the platform never calls this handler.
    const execution = managed ? crypto.randomUUID() : undefined;
    if (options.images && new URL(request.url).pathname === "/_rebask/image") {
      const response = await optimizeImage(request, env, options.images, deployment, caches.default, p => ctx.waitUntil(p));
      if (!managed) return response;
      const headers = new Headers(response.headers);
      headers.set("cloudflare-cdn-cache-control", "no-store");
      headers.delete("cdn-cache-control");
      headers.set("x-rebask-worker-execution", execution);
      return new Response(response.body, {status:response.status, headers});
    }
    const draft = options.draftMode && await verifyDraftCookie(request, env.REBASK_DRAFT_SECRET);
    return withCacheRequest(env.REBASK_CACHE, p => ctx.waitUntil(p), async () => {
      const eligible = !draft && pageCacheEligible(request, options.pageCache);
      if (managed) {
        let generation;
        if (eligible && ctx.cache?.purge) {
          try { generation = await edgeGeneration(env.REBASK_CACHE); } catch { /* Fail closed for fills. */ }
        }
        const response = await app.fetch(request);
        let mayCache = false;
        if (generation !== undefined) {
          try { mayCache = generation === await edgeGeneration(env.REBASK_CACHE); } catch { /* Origin only. */ }
        }
        const headers = workersCacheHeaders(response, mayCache, pageFreshUntil(), options.pageCache.maxAge ?? 60, execution);
        if (draft) headers.set("x-rebask-draft", "1");
        return streamingResponse(response, headers);
      }
      // Generation is checked before a lookup and again after rendering before a fill.
      // Failed RPCs fail closed: no serving a potentially invalidated CDN entry.
      let generation, key;
      if (eligible) {
        try {
          generation = await edgeGeneration(env.REBASK_CACHE);
          key = edgeKey(request, deployment, generation);
          const hit = await caches.default.match(key);
          if (hit) {
            if (generation === await edgeGeneration(env.REBASK_CACHE)) return outgoing(hit, "HIT", draft);
          }
        } catch { key = undefined; }
      }
      const response = await app.fetch(request);
      const ttl = key ? pageCacheTTL(response, pageFreshUntil(), options.pageCache.maxAge) : 0;
      if (ttl > 0) {
        try {
          if (generation === await edgeGeneration(env.REBASK_CACHE)) {
            const copy = response.clone();
            copy.headers.set("cache-control", "public, max-age=" + ttl);
            ctx.waitUntil(caches.default.put(key, copy).catch(() => {}));
          }
        } catch { /* Origin remains available if edge storage fails. */ }
      }
      return outgoing(response, ttl > 0 ? "MISS" : "BYPASS", draft);
    }, !!draft, managed ? () => persistPagePurge(env.REBASK_PURGE.getByName("pages-v1")) : undefined);
}
function outgoing(response, cdn, draft) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-rebask-cdn", cdn);
  if (draft) headers.set("x-rebask-draft", "1");
  return streamingResponse(response, headers);
}
function streamingResponse(response, headers) {
  const streamingPpr = headers.get("x-rebask-prerender") === "1";
  if (streamingPpr) headers.set("content-encoding", "identity");
  return new Response(response.body, {status:response.status, statusText:response.statusText, headers, ...(streamingPpr ? {encodeBody:"manual"} : {})});
}\n`,
        );
        // Preserve the checked-in Wrangler configuration, including JSONC comments.
        const { parse, printParseErrorCode } = await import("jsonc-parser");
        const errors: import("jsonc-parser").ParseError[] = [];
        const config = parse(
          await readFile(resolve(root, "wrangler.jsonc"), "utf8"),
          errors,
          { allowTrailingComma: true },
        );
        assert.equal(
          errors.length,
          0,
          `Invalid wrangler.jsonc: ${errors.map((e) => printParseErrorCode(e.error)).join(", ")}`,
        );
        assert.ok(
          config?.name && config?.compatibility_date,
          "wrangler.jsonc needs name and compatibility_date",
        );
        assert.ok(
          config.compatibility_flags?.includes("nodejs_compat"),
          "Rebask on Workers requires nodejs_compat",
        );
        assert.ok(
          !config.env || Object.keys(config.env).length === 0,
          "Named Wrangler environments are not supported in 0.1.0; use a separate build/config per deployment",
        );
        if (options.durableCache) {
          const binding = config.durable_objects?.bindings?.find(
            (b: { name: string }) => b.name === "REBASK_CACHE",
          );
          assert.ok(
            !binding ||
              (binding.class_name === "RebaskCache" && !binding.script_name),
            "REBASK_CACHE is reserved for this adapter; refusing to replace another binding",
          );
          const migration = config.migrations?.find(
            (m: { tag: string }) => m.tag === "rebask-cache-v1",
          );
          assert.ok(
            !migration ||
              (migration.new_sqlite_classes?.length === 1 &&
                migration.new_sqlite_classes[0] === "RebaskCache" &&
                Object.keys(migration).length === 2),
            "rebask-cache-v1 is reserved; refusing to change an existing migration",
          );
        }
        assert.ok(
          !options.images ||
            !config.images ||
            config.images.binding === "REBASK_IMAGES",
          "Images binding is reserved when adapter image optimization is enabled",
        );
        const managed = options.pageCache?.mode === "workers-cache";
        assert.ok(
          !config.cache?.enabled || managed,
          "Configure pageCache.mode=workers-cache instead of enabling an unmanaged response cache",
        );
        assert.ok(
          !managed || !config.cache?.cross_version_cache,
          "Cross-version Workers Cache is unsafe for deployment-bound Rebask artifacts",
        );
        assert.ok(
          !managed ||
            !config.exports?.default?.cache ||
            config.exports.default.cache.enabled,
          "Default entrypoint cache conflicts with managed page caching",
        );
        if (managed) {
          const binding = config.durable_objects?.bindings?.find(
            (b: { name: string }) => b.name === "REBASK_PURGE",
          );
          assert.ok(
            !binding ||
              (binding.class_name === "RebaskPurge" && !binding.script_name),
            "REBASK_PURGE is reserved",
          );
          const self = config.services?.find(
            (b: { binding: string }) => b.binding === "REBASK_SELF",
          );
          assert.ok(
            !self || (self.service === config.name && !self.entrypoint),
            "REBASK_SELF is reserved for private purge RPC",
          );
          const migration = config.migrations?.find(
            (m: { tag: string }) => m.tag === "rebask-purge-v1",
          );
          assert.ok(
            !migration ||
              (migration.new_sqlite_classes?.length === 1 &&
                migration.new_sqlite_classes[0] === "RebaskPurge" &&
                Object.keys(migration).length === 2),
            "rebask-purge-v1 migration is reserved",
          );
        }
        const { $schema, ...workerConfig } = config;
        await writeFile(
          resolve(output, "server/wrangler.json"),
          JSON.stringify(
            {
              ...workerConfig,
              cache: { enabled: managed, cross_version_cache: false },
              ...(options.telemetry
                ? {
                    observability: {
                      ...workerConfig.observability,
                      enabled: true,
                    },
                  }
                : {}),
              ...(managed
                ? {
                    services: [
                      ...(workerConfig.services ?? []).filter(
                        (b: { binding: string }) => b.binding !== "REBASK_SELF",
                      ),
                      { binding: "REBASK_SELF", service: workerConfig.name },
                    ],
                  }
                : {}),
              // This output was prerendered for production. Wrangler dev must not
              // switch the runtime Flight protocol to a development renderer.
              define: {
                ...workerConfig.define,
                "process.env.NODE_ENV": JSON.stringify("production"),
              },
              main: "worker.mjs",
              ...(options.images
                ? { images: { binding: "REBASK_IMAGES" } }
                : {}),
              assets: { directory: "../public", binding: "ASSETS" },
              ...(options.durableCache
                ? {
                    durable_objects: {
                      bindings: [
                        ...(
                          workerConfig.durable_objects?.bindings ?? []
                        ).filter(
                          (b: { name: string }) =>
                            b.name !== "REBASK_CACHE" &&
                            (!managed || b.name !== "REBASK_PURGE"),
                        ),
                        { name: "REBASK_CACHE", class_name: "RebaskCache" },
                        ...(managed
                          ? [
                              {
                                name: "REBASK_PURGE",
                                class_name: "RebaskPurge",
                              },
                            ]
                          : []),
                      ],
                    },
                    migrations: [
                      ...(workerConfig.migrations ?? []).filter(
                        (m: { tag: string }) =>
                          m.tag !== "rebask-cache-v1" &&
                          (!managed || m.tag !== "rebask-purge-v1"),
                      ),
                      {
                        tag: "rebask-cache-v1",
                        new_sqlite_classes: ["RebaskCache"],
                      },
                      ...(managed
                        ? [
                            {
                              tag: "rebask-purge-v1",
                              new_sqlite_classes: ["RebaskPurge"],
                            },
                          ]
                        : []),
                    ],
                  }
                : {}),
            },
            null,
            2,
          ),
        );
        console.log(
          `[rebask-cloudflare] Packaged ${Object.keys(entries).length} private build snapshots; durable cache: ${!!options.durableCache}.`,
        );
      },
    },
  };
}

/** Backwards-compatible name; prefer cloudflareAdapter for new integrations. */
export const cloudflarePpr = cloudflareAdapter;
