import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Plugin } from "vite";
import { createRequire } from "node:module";
import { patchRscTrailer } from "./compatibility.js";

const virtualArtifacts = "virtual:rebask-cloudflare/artifacts";

/** Dedicated Workers adapter for pinned Rebask0.2.0's native PPR cache/resume path. */
export function cloudflarePpr(): Plugin {
  let root: string;
  let artifactFile: string;
  return {
    name: "rebask-cloudflare:ppr",
    enforce: "pre",
    config() {
      // The cache factory imports a virtual build artifact; never externalize it
      // when the consumer installs this adapter from npm rather than local source.
      return {
        ssr: { noExternal: ["@hipdev/rebask-cloudflare"] },
        environments: {
          rsc: { resolve: { noExternal: ["@hipdev/rebask-cloudflare"] } },
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
    },
    resolveId(id) {
      if (id === virtualArtifacts) return { id: artifactFile, external: true };
    },
    transform(code, id) {
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
        if (
          chunk.type !== "chunk" ||
          !chunk.code.includes(JSON.stringify(artifactFile))
        )
          continue;
        let path = relative(
          dirname(resolve(outDir, chunk.fileName)),
          artifactFile,
        ).replaceAll("\\", "/");
        if (!path.startsWith(".")) path = `./${path}`;
        chunk.code = chunk.code.replaceAll(
          JSON.stringify(artifactFile),
          JSON.stringify(path),
        );
      }
    },
    buildApp: {
      order: "post",
      async handler() {
        const server = await readFile(
          resolve(root, "dist/rsc/index.js"),
          "utf8",
        );
        const deploymentId = server.match(/var deploymentId = "([^"]+)"/)?.[1];
        assert.ok(deploymentId, "Missing pinned Rebask deployment identifier");
        const manifest = JSON.parse(
          await readFile(
            resolve(root, "dist/.rebask/prerendered-paths.json"),
            "utf8",
          ),
        );
        const entries: Record<string, unknown> = {};
        for (const file of await readdir(
          resolve(root, "dist/.rebask/cache/scoped"),
        )) {
          if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
          const entry = JSON.parse(
            await readFile(
              resolve(root, "dist/.rebask/cache/scoped", file),
              "utf8",
            ),
          );
          if (entry.type !== 1 && entry.type !== 2) continue;
          assert.ok(
            !entry.tags?.length,
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
          `export const artifacts = ${JSON.stringify({ deploymentId, manifest, entries })};\n`,
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
export default {
  async fetch(request) {
    const response = await app.fetch(request);
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
            },
            null,
            2,
          ),
        );
        console.log(
          `[rebask-cloudflare] Packaged ${Object.keys(entries).length} immutable HTML/RSC entries with the build manifest.`,
        );
      },
    },
  };
}
