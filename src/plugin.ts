import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { patchRscTrailer } from "./compatibility.js";

const virtualArtifacts = "virtual:rebask-cloudflare/artifacts";

/** Dedicated Workers adapter for pinned Rebask0.2.0's native PPR cache/resume path. */
export function cloudflarePpr(
  options: { durableCache?: boolean } = {},
): Plugin {
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
            .endsWith("/rebask-cloudflare-adapter/dist/durable-storage.js"))
      )
        return { id: runtimeFile, external: true };
      if (id === virtualArtifacts) return { id: artifactFile, external: true };
    },
    transform(code, id) {
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
          `import app from "../../dist/rsc/index.js";
${options.durableCache ? 'import { withCacheRequest } from "../../.cache/cloudflare/runtime.mjs";\nexport { RebaskCache } from "rebask-cloudflare-adapter/durable-object";' : ""}
export default {
  async fetch(request, env, ctx) {
    const response = await ${options.durableCache ? "withCacheRequest(env.REBASK_CACHE, promise => ctx.waitUntil(promise), () => app.fetch(request))" : "app.fetch(request)"};
    const headers = new Headers(response.headers);
    // The immutable shell is reused internally; its resumed response is per-request.
    headers.set("cache-control", "private, no-store");
    // Automatic compression can hold the small shell until the resume finishes.
    // Only resumed HTML is sent uncompressed; normal assets/static HTML retain compression.
    const streamingPpr = headers.get("x-rebask-prerender") === "1";
    if (streamingPpr) headers.set("content-encoding", "identity");
    return new Response(response.body, {status:response.status, statusText:response.statusText, headers, ...(streamingPpr ? {encodeBody:"manual"} : {})});
  }
};\n`,
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
        const { $schema, ...workerConfig } = config;
        await writeFile(
          resolve(output, "server/wrangler.json"),
          JSON.stringify(
            {
              ...workerConfig,
              // This output was prerendered for production. Wrangler dev must not
              // switch the runtime Flight protocol to a development renderer.
              define: {
                ...workerConfig.define,
                "process.env.NODE_ENV": JSON.stringify("production"),
              },
              main: "worker.mjs",
              assets: { directory: "../public", binding: "ASSETS" },
              ...(options.durableCache
                ? {
                    durable_objects: {
                      bindings: [
                        ...(
                          workerConfig.durable_objects?.bindings ?? []
                        ).filter(
                          (b: { name: string }) => b.name !== "REBASK_CACHE",
                        ),
                        { name: "REBASK_CACHE", class_name: "RebaskCache" },
                      ],
                    },
                    migrations: [
                      ...(workerConfig.migrations ?? []).filter(
                        (m: { tag: string }) => m.tag !== "rebask-cache-v1",
                      ),
                      {
                        tag: "rebask-cache-v1",
                        new_sqlite_classes: ["RebaskCache"],
                      },
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
