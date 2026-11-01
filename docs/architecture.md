# Architecture and scope

## Build

1. The Vite plugin creates a private external artifact module exporting null.
2. During the native Rebask build/prerender, createCacheHandler uses filesystem
   storage. The pinned Node24 trailer transform captures each request's mutable
   state before stream callbacks can lose AsyncLocalStorage context.
3. The manifest-loader transform reads the bundled manifest when artifacts exist,
   otherwise falls back to Rebask's normal Node filesystem path.
4. After Rebask finishes, the plugin reads its deployment ID, manifest and scoped
   type1(RSC)/type2(HTML) cache entries. Tagged entries are rejected. It replaces
   the external artifact module with those immutable snapshots.
5. Only dist/client goes into .output/public. The Worker imports dist/rsc/index.js;
   Wrangler bundles the server and private snapshots together. Generated JSON
   config points to that Worker and ASSETS. It preserves top-level source options,
   excludes the source-relative schema, and requires nodejs_compat.

## Request

Workers serves client assets normally. App requests reach the native Rebask handler.
The cache handler matches the deployment ID and ph/pr/ps namespace, hashes the key,
then returns a clone of a build artifact. Rebask uses its own manifest, postponed
React state and stream orchestration to emit the shell and resume the dynamic tail.
The continuation gets the real request. No alternate client/resume protocol exists.

App responses are private/no-store; Cloudflare's CDN is not a shared viewer cache.
The immutable shell is reused inside the Worker. Resumed HTML uses
content-encoding:identity and Workers encodeBody:manual, preventing automatic
compression from buffering a small shell until resume completes. This sends more
HTML bytes; assets and complete static HTML keep automatic compression.

## Limits

- Version0.1.0 supports core0.2.0/Vite8.3.5 and the standard dist layout only.
- Immutable snapshots are refreshed by deployment; their native expiry metadata
  still applies. Runtime promotion, durable ISR, tag invalidation, use-cache data
  persistence and distributed cache coordination are not implemented.
- The app must return Suspense before awaiting runtime APIs. The adapter cannot
  create a static shell from an application that suspends above its layout.
- Only wrangler.jsonc at the Vite root and top-level deployment settings are
  supported. Named environments and path-bearing advanced binding configuration
  need separate adapter work; nested relative paths are not rebased by this release.
- This fetch-only adapter does not implement scheduled/queue/WebSocket handlers or
  dependency injection of bindings into application code.
- Deployable Worker size/startup limits depend on the application and your plan.
  Run Wrangler dry-run and validate deployment; this package grants no platform quota.
- Development uses normal Rebask/Vite. Workerd parity is exercised after building.
- Auth, backend data, origin allowlists, secrets and media permissions belong to the
  consumer. No credentials are required by the adapter itself.

## References

- [Rebask](https://www.rebask.com/) and its published @rebask/core0.2.0 source.
- [Workers response encoding](https://developers.cloudflare.com/workers/runtime-apis/response/).
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
- [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/).
- [react-ppr-workers inspiration](https://github.com/threepointone/react-ppr-workers).
