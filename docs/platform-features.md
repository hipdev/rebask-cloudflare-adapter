# CDN pages, Draft Mode and images (0.5.0)

This is a community **Rebask deployment adapter**, covering SSR, RSC, streaming PPR,
public durable data/ISR, invalidation and optional platform services. It is not an
official Rebask or Cloudflare integration. Core 0.2.0 and Vite 8.3.5 remain pinned.

```ts
import { cloudflareAdapter } from "rebask-cloudflare-adapter";
cloudflareAdapter({
  durableCache: true,
  pageCache: { mode: "workers-cache", paths: ["/en/terms", "/es/terms"], maxAge: 60 },
  draftMode: true,
  images: { localPrefixes: ["/assets/"] },
});
```

`cloudflarePpr` remains a compatible alias. Keep the paired `createCacheHandler()`
Rebask configuration. Options are opt-in; a bare adapter keeps immutable snapshots.

## CDN pages

### Cache API mode (default, backwards compatible)

Workers Cache API stores **complete public HTML only**, per Cloudflare data center.
It is not Tiered Cache, cross-region prewarming, or a Vercel CDN implementation.
The Worker still runs and checks a Durable Object generation on a hit. Measure RPC
latency/cost before enabling broadly. No account cache rule is required.

Declare exact public paths, not user/account prefixes. Only GET without search,
cookies, authorization, conditional/range headers or RSC/tree/shell/tail/action
headers is eligible. HTML must be a native fresh cache HIT, complete (no resumed
PPR), status 200, have positive s-maxage, no Set-Cookie/private/no-store and only
supported Vary fields. RSC, PPR continuations, auth and viewer permissions stay out.
The consumer remains responsible for declaring genuinely public content.

The edge TTL is the smallest of maxAge (1–3600s), native s-maxage, and the actual
remaining freshness of the HTML cache entry. Stale HTML is never filled. Browser
responses remain private/no-store so browsers cannot bypass the invalidation gate.
`x-rebask-cdn: HIT | MISS | BYPASS` describes this adapter's cache, not CF-Cache-Status.
Cache writes are best-effort, retained with waitUntil. MISS is an eligible origin
response; it does not promise that Cache API accepted the write.

Keys include deployment ID, pathname and durable generation. Tag invalidation fans
out to all16 shards; shard0's epoch fences CDN keys. After ALL shards acknowledge, a final shard0
generation advance makes any HTML filled during a partially completed fanout
unreachable. Failure to complete that barrier fails the invalidation operation. Generation is checked before
lookup, after a hit, and before a fill. After acknowledged invalidation, new reads
cannot reach an old CDN generation. Concurrent requests already in flight may still
finish. Failed generation RPCs bypass CDN. Unrelated tags conservatively evict the
whole page CDN generation; old entries expire naturally. No public purge API exists.
Revalidation failure must be retried; it is never reported as successful.

### Managed Workers Cache mode (0.4.0)

Select `pageCache: { mode: "workers-cache", paths: [...], maxAge: 60 }`.
The generated Wrangler config enables Workers Cache with cross-version reuse
explicitly disabled. A new Worker version gets an independent cache. Conflicting
cache/default-entrypoint configuration fails. Use Wrangler4.156.0 as tested.

Cloudflare checks its managed lower/upper cache tiers **before invoking the Worker**.
A fresh `Cf-Cache-Status: HIT` does not invoke the generated fetch handler, Rebask,
or the Durable Object generation checks. On a miss, the Worker checks generation,
reads/renders Rebask, caps freshness as above, and checks generation again before
returning a cacheable complete public HTML response. This mode does not also store
the page through Cache API. Function/data ISR and private PPR remain unchanged.

The browser still receives `Cache-Control: private, no-store`. The edge-only
`Cloudflare-CDN-Cache-Control` header grants a bounded TTL and `must-revalidate`;
Cloudflare consumes that header. Stale-while-revalidate and stale-on-error are not
used for managed page responses. Dynamic/API/image responses explicitly return an
edge no-store directive, overriding inherited CDN-specific headers.

**Bypass must work before code runs.** A public fill includes Vary on Cookie,
Authorization, Accept, Accept-Encoding, Host and Rebask action/tree/shell/tail/resume
headers (plus conditional validators). The anonymous variant therefore cannot
satisfy a credentialed or protocol-variant request. Its request reaches the Worker
and is returned no-store. This also covers signed AND malformed Draft Mode cookies;
only a valid signed cookie enables the draft flag. Never remove that Vary merely
to improve hit rate. Headers are compared literally, which can reduce sharing
between different browser Accept/encoding values. Cloudflare owns GET/HEAD sharing
and conditional/range HTTP handling; those platform behaviors differ from the
legacy Cache API eligibility rules.

**Invalidation:** all managed page variants share the reserved `rebask-pages-v1`
Cache-Tag. After durable tag fanout and the final generation barrier,
`revalidateTag()` awaits `ctx.cache.purge({tags:[...]})` and checks success. Missing
APIs, rejected purges or RPC failures are explicit errors, never acknowledged as
success; a durable alarm retries the pending purge automatically (see operations.md). Purging is conservatively page-wide. It is scoped to
the current Worker's default entrypoint; no zone purge or account token is used.

Managed invalidation uses Cloudflare's native global purge propagation semantics.
The returned result acknowledges acceptance, not a distributed transaction with
every edge and every in-flight response. Already-running requests can finish.
Generation checks fence origin computations that overlap an invalidation before
the final check. Do not describe this as a linearizable global cache or claim the
legacy per-hit DO generation gate still executes on a managed HIT. Applications
requiring that stronger lookup gate should keep `mode: "cache-api"`.

**Evidence:** `x-rebask-cdn: WORKERS-CACHE` identifies the strategy, not this
request's hit status. Read the platform's `Cf-Cache-Status`. The generated handler
creates `x-rebask-worker-execution` anew on EVERY fetch invocation, even when other
internal caches hit. Repeated platform HITs preserve the fill's ID; cookie/auth/RSC
bypasses produce different IDs. This is a public diagnostic, not a credential.
Use traces/observability alongside it where available; a legacy x-rebask-cache:HIT
or x-rebask-image-cache:HIT alone does not prove that the Worker was skipped.

Image derivative caching remains Cache API-based in this release. It does not
silently opt public image requests into the new managed page cache.

References: [Workers Cache](https://developers.cloudflare.com/workers/cache/),
[configuration and Vary](https://developers.cloudflare.com/workers/cache/configuration/),
[purge semantics](https://developers.cloudflare.com/workers/cache/purge/).

## Adapter Draft Mode

Rebask 0.2.0 has no built-in Draft Mode API. This adapter supplies signed preview
state and cache bypass, not a Next.js-compatible API or an unpublished-content ACL.

1. Enable `draftMode: true` and provision a unique runtime secret:
   `npx wrangler secret put REBASK_DRAFT_SECRET --config .output/server/wrangler.json`.
   Use at least32 random characters. Never a VITE_ variable or a committed value.
2. In an application-owned POST handler, authenticate the editor, check permission
   and CSRF, then call `createDraftCookie(secret)` from
   `rebask-cloudflare-adapter/draft` and append it to Set-Cookie. Return no-store.
   Do not expose an unauthenticated enable endpoint. How a handler accesses its
   runtime binding is application-specific; the adapter does not expose secrets.
3. Read `isDraftMode()` from `rebask-cloudflare-adapter/runtime` within request
   rendering; authorize and choose published/draft data through your backend.
4. `clearDraftCookie()` returns the deletion Set-Cookie value. Hard reload after
   enabling/disabling: existing client router/Convex caches are outside this API.

The __Host cookie is Secure, HttpOnly, SameSite=Lax, Path=/, host-only, HMAC-SHA256
signed, expires in1h by default (maximum24h) and contains no content or credentials.
Invalid/expired/duplicate cookies do not enable preview. Any cookie bypasses CDN.
Verified preview bypasses immutable and durable reads, writes and regeneration
claims. Pinned bridges also bypass native use-cache/durableCache in-flight sharing;
preview results cannot poison public function entries. Responses are private/no-store
and have x-rebask-draft:1. Secret rotation revokes existing cookies. This is a bearer
preview flag; do not treat possession as the right to read a specific private post.

UHH already renders owner drafts through authenticated Convex/client preview.
Adapter Draft Mode does not replace that workflow or grant new backend access.

## Images

Enabling `images` adds the REBASK_IMAGES Cloudflare Images binding and handles
`/_rebask/image?url=%2Fassets%2Fphoto.png&w=640&q=75`, compatible with Rebask's
`<Image>` default loader. Keep the default image endpoint/config, or configure a
custom consumer loader explicitly. The adapter intercepts the endpoint before RSC.
The standard widths are32,48,64,96,128,256,384,640,750,828,1080,1200,1920,2048,3840;
quality defaults to75. Optional widths/qualities must also match Rebask image config.

Sources come ONLY from public local assets via ASSETS, with configured directory
prefixes; there is no arbitrary remote fetch, signed URL proxy, SVG support or private
media optimization. Reject traversal, encoded paths, queries/fragments, duplicate
parameters, unlisted widths/qualities, non-raster MIME and input beyond8MB. Supported
inputs: PNG/JPEG/WebP/AVIF. Animated inputs become still images. Output uses AVIF or
WebP if advertised, otherwise JPEG, with scale-down to avoid upscaling. Transparent
images should be requested with WebP/AVIF support (JPEG has no alpha).

Derivatives use Cache API, keyed by source, deployment, width, quality and format.
They have public max-age3600, Vary:Accept and x-rebask-image-cache:HIT/MISS. Images
binding output is not implicitly cached; this layer stores it explicitly. A missing
binding is503; a rejected source is400; an invalid asset is404; transform failure is502.
Binding transformations have Cloudflare Images usage/billing; enabling the binding
does not turn existing img elements into optimized components. Consumers choose
which public images to render with `<Image>`. Private Convex photos and Stream video
must retain their existing authenticated delivery paths.

References: [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/),
[Images binding](https://developers.cloudflare.com/images/optimization/binding/),
[Images pricing](https://developers.cloudflare.com/images/pricing/).


## Operations (0.5.0)

See [operations](operations.md) for the persistent purge outbox, migrations,
private same-entrypoint RPC, telemetry, alert events and trusted-main remote CI.
Never ship QA fault/control endpoints in a consuming application.
