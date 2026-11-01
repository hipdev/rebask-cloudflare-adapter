# Changelog

## 0.3.0

- General `cloudflareAdapter()` entry point, with compatible `cloudflarePpr` alias.
- Opt-in complete-public-HTML CDN cache, per data center, deployment/generation keys,
  native remaining-freshness caps and acknowledged tag-invalidation coherence.
- HMAC-signed adapter Draft Mode; bypasses page/data caches and native in-flight
  function sharing without changing application authorization.
- Rebask Image-compatible public local raster optimization using Cloudflare Images,
  explicit source/parameter limits and cached format-specific derivatives.
- Broader English/Spanish human/agent documentation and platform scope.

## 0.2.0

- New unscoped package name: rebask-cloudflare-adapter (original scoped0.1.0 remains available).
- Opt-in16-shard SQLite Durable Objects cache, native ISR/promotion and use-cache/durableCache persistence.
- Tag invalidation with generation fences, bounded tombstones and owner-fenced30s regeneration leases.
- Workers waitUntil integration and portable shared request context.
- Real Workerd public catalog tests: reuse, restart persistence, ISR, invalidation and viewer isolation.

## 0.1.0

Initial community release for @rebask/core 0.2.0 and Vite 8.3.5.

- Native build-time PPR artifact packaging and React resume on Cloudflare Workers.
- Immutable deployment-scoped HTML/RSC storage; no runtime viewer cache.
- Node 24 RSC trailer compatibility transform and fail-fast upstream guards.
- Manual identity encoding for prompt resumed-shell delivery.
- Production renderer definition prevents mismatched Flight protocols in Wrangler preview.
- Minimal standalone example, English/Spanish guides and agent instructions.
- Real Workerd tests through an installed npm tarball, including delayed resume,
  request isolation, CSRF and HTML/RSC representation checks.

Durable ISR, named Wrangler environments and tagged runtime caches are not included.
