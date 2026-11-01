# Instructions for coding agents

This repository publishes rebask-cloudflare-adapter, a community MIT adapter for
Rebask 0.2.0 on Cloudflare Workers. This is React Server Components + Vite, not Next.js.
Read README.md, docs/platform-features.md and docs/architecture.md before changing cache/build/runtime code.

## Start here

- npm ci (Node 24+); npm test; npm run typecheck; npm run test:integration.
- src/plugin.ts: Vite manifest bridge, private artifact packaging, Worker generation.
- src/cache.ts: paired Rebask config storage factory; virtual module requires plugin.
- src/storage.ts: immutable build-only cache storage.
- src/durable-storage.ts, shard.ts, durable-object.ts: bounded durable cache and SQL coordination.
- src/runtime.ts: per-request/task scopes and Workers background lifetime.
- src/compatibility.ts: pinned RSC trailer request-state compatibility transform.
- examples/basic: public, standalone consumer; no application-specific dependencies.
- scripts/integration.mjs: packs/installs consumer, builds, tests real Workerd/resume.

## Invariants

1. One native Rebask build produces manifest, cache entries, assets and deployment ID.
   Never seed snapshots with another build's output. Do not substitute full SSR and
   call it PPR, or use hidden resumed navigation as initial-shell evidence.
2. Immutable mode reads build artifacts only. Durable mode may retain only native
   framework-eligible public entries, with deployment/type validation, SQL generation
   fences, cloned reads and bounded storage. Never retain runtime viewer data,
   auth or permissions globally. Keep invalidation fanout, owner-fenced leases,
   tombstones and Workers waitUntil. Do not change the16-shard identity in place.
3. Public assets contain dist/client only. Manifest and cache files stay in the
   private Worker bundle. Do not add a public resume endpoint or weaken action CSRF.
4. Reuse native React resume. Preserve Response streaming; no body buffering.
   Manual identity encoding on resumed HTML prevents Workerd compression buffering.
5. Pin supported core/Vite versions; fail on unknown internal formats. An upgrade
   requires tests against actual upstream source plus a fresh packed-consumer build
   on Node 24, not just mocked unit tests. Keep trailer state request-local and late
   reads intact; never replace missing context with an empty object.
6. Keep output directories paired (.output, dist, .cache/cloudflare). Generated
   files are ignored. No credentials, real account IDs, private app fixtures or
   production backend URLs belong in source, examples, npm tarballs or test logs.

## Verification and publishing

Every runtime/build change needs npm test, npm run typecheck and
npm run test:integration. The integration test modifies only a copied QA build to
inject delay; never expose a public test-delay control. Review npm pack --dry-run
and inspect the archive. CI tests Node 24 and26 without Cloudflare credentials.
Document limitations and measured evidence; a cache HIT alone proves neither
stream timing nor browser hydration. Run browser smoke QA when UI behavior changes.

Do not publish or create a release unless the task authorizes it. For authorized
releases follow docs/releasing.md. Never print tokens or commit .npmrc credentials.
Avoid changing a consuming application's backend or authorization to make tests pass.

New platform services: src/edge.ts (complete public HTML only; generation fencing),
src/draft.ts (signed cookie, never auth), src/images.ts (public ASSETS only, no remote
fetch/queries/SVG). Keep Draft Mode bypass bridges for both core cache-function
runtimes; storage-only bypass does not prevent native in-flight cache sharing.
Never cache personalized PPR continuations. Preserve remaining-freshness caps.

Managed mode (src/workers-cache.ts): never infer bypass from code that only runs on
a miss. Vary must separate Cookie/Authorization/Accept/protocol fields before
lookup. Keep browser no-store, edge-only bounded TTL, must-revalidate, version
isolation and explicit native purge success checks. Do not claim Cache API HITs
skip execution or that purge acceptance is an atomic global transaction. Every
invocation must regenerate the diagnostic ID, including all bypass branches.
Remote tests must run only in an explicitly prepared disposable QA deployment;
never add test invalidation/delay endpoints to a consuming application's backend.
