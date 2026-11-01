# Rebask Cloudflare Adapter

[![CI](https://github.com/hipdev/rebask-cloudflare-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/hipdev/rebask-cloudflare-adapter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/rebask-cloudflare-adapter)](https://www.npmjs.com/package/rebask-cloudflare-adapter)

A community **Rebask deployment adapter for Cloudflare Workers**: SSR, React Server
Components, streaming Partial Prerendering, durable caching/ISR, CDN page caching,
signed Draft Mode and public image optimization. MIT licensed. Maintained by [hipdev](https://github.com/hipdev).

**Experimental, version-pinned:** this release targets `@rebask/core@0.2.0` and
`vite@8.3.5`. It is independent of Rebask and Cloudflare and is not their official
adapter. [Español](README.es.md) · [Agent instructions](AGENTS.md) · [Architecture](docs/architecture.md).

## What you get

- Native Rebask HTML/RSC artifacts, manifest lookup and React resume orchestration.
- Static navigation/layouts in initial visible HTML, when your app places runtime
  reads under local Suspense boundaries.
- Existing RSC navigation/prefetch semantics and per-request dynamic content.
- A single build with matching assets, prerender snapshots and deployment ID.
- Private bundled snapshots; public assets contain only the client output.
- A Node 24 RSC trailer compatibility transform, including late request search reads.

Enable **durable runtime caching, native ISR and tag invalidation** with
`cloudflareAdapter({ durableCache: true })`. This adds sixteen SQLite Durable Objects
and owner-fenced regeneration leases. Native `use cache`, `durableCache`, HTML/RSC
promotion and time/tag-based refresh use that storage. The default `cloudflareAdapter()`
keeps build-only immutable storage. Neither mode authorizes users or makes private
data safe to share. [Architecture, budgets and remaining limits](docs/architecture.md).

The new package name is `rebask-cloudflare-adapter`; the original scoped0.1.0 package
remains available. Do not install both adapters in the same build.

## Platform features in 0.3.0

- Opt-in per-data-center CDN caching for fresh complete public HTML, fenced by tag invalidation.
- Signed Draft Mode cookies and request-local bypass of page/function caches.
- Cloudflare Images binding with a Rebask `<Image>`-compatible endpoint for public local raster assets.
- Backwards-compatible `cloudflarePpr` alias.

These services are opt-in and have specific limits. Read [configuration, security,
costs and scope](docs/platform-features.md) before enabling them. PPR continuations,
viewer permissions and private media are never public CDN entries.

## Quick start

Use Node 24 or newer. In an existing Rebask app:

```sh
npm install --save-exact @rebask/core@0.2.0 react@19.3.1 react-dom@19.3.1
npm install -D --save-exact rebask-cloudflare-adapter@0.3.0 vite@8.3.5 @vitejs/plugin-rsc@0.5.38 @vitejs/plugin-react@6.1.1 wrangler@4.156.0
```

`vite.config.ts` (keep the native Rebask build; replace the deployment adapter):

```ts
import { defineConfig } from "vite";
import rsc from "@vitejs/plugin-rsc";
import react from "@vitejs/plugin-react";
import { rebask } from "@rebask/core/vite";
import { cloudflareAdapter } from "rebask-cloudflare-adapter";

export default defineConfig({
  plugins: [rsc(), react(), rebask(), cloudflareAdapter({ durableCache: true })],
});
```

`rebask.config.ts`:

```ts
import type { RebaskConfig } from "@rebask/core";
import { createCacheHandler } from "rebask-cloudflare-adapter/cache";

export default { cacheHandler: createCacheHandler() } satisfies RebaskConfig;
```

`wrangler.jsonc` in the Vite app root:

```jsonc
{
  "name": "my-rebask-app",
  "main": ".output/server/worker.mjs",
  "compatibility_date": "2026-10-30",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
}
```

Build, preview and deploy from that root:

```sh
npx vite build
npx wrangler dev --config .output/server/wrangler.json
npx wrangler deploy --config .output/server/wrangler.json
```

The generated config points to the Worker and client assets. Do not deploy the
source config directly. Keep `.output`, `dist` and `.cache/cloudflare` together
until Wrangler bundles the Worker. Build artifacts are generated, not source files.

For a fresh app, copy [examples/basic](examples/basic), then run `npm install` and
`npm run build`. Its `/alice` and `/bob` routes show a static frame plus a dynamic
continuation. Never put request/session reads above their Suspense boundary.

## Automatic deployment on every push

Connect your GitHub repository in **Cloudflare Workers Builds**, production branch
`main`. Set the root directory to your Vite app's directory. For an npm app:

- Build command: `npm ci && npm run build` (commit its package-lock.json).
- Deploy command: `npx wrangler deploy --config .output/server/wrangler.json`.
- If Cloudflare also installs dependencies, avoid duplicating that step according
  to your chosen build settings. A pnpm app should use its pinned pnpm commands.

Only explicitly public frontend variables belong in client builds. Add your new
frontend origin to your own backend/media allowlists when those services require it.
The adapter does not provision databases, migrate data or configure authorization.

## Verify real PPR

```sh
curl -N -H 'Accept-Encoding: identity' http://localhost:8787/alice
```

Expect `x-rebask-cache: HIT`, `x-rebask-prerender: 1` and navigation **before**
resumed hidden segments/scripts. A HIT header alone is not proof of early delivery.
The packed-consumer test delays the actual React resume by 1800ms and requires the
visible shell to arrive before it completes, with gzip/br negotiation too:

```sh
npm ci
npm test
npm run test:integration
```

Tests cover durable public-page promotion, restart persistence, native ISR, tag
invalidation and race fencing. They also cover distinct request markers on the same URL, CSRF protection,
HTML/RSC separation and private artifact 404s. No Cloudflare account is needed for
local Workerd tests. See [testing and troubleshooting](docs/testing.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Compatibility is
intentionally narrow: upstream internals changing must fail clearly rather than
silently degrade to SSR. [Changelog](CHANGELOG.md) · [MIT license](LICENSE).

Thanks to [Rebask](https://www.rebask.com/) for the native PPR/RSC runtime and to
[threepointone/react-ppr-workers](https://github.com/threepointone/react-ppr-workers)
for demonstrating the shell/continuation approach on Workers. This adapter uses
Rebask's own resume path; it does not copy that experiment's runtime.
