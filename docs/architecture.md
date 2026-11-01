# Architecture and scope (0.3.0)

`rebask-cloudflare-adapter` is the new unscoped package name. The original
`@hipdev/rebask-cloudflare@0.1.0` remains available with its original immutable behavior.

## One native build

The Vite plugin packages the current Rebask0.2.0 manifest, deployment ID and matching
prerender snapshots privately. Only dist/client becomes public assets. It reuses
native React PPR/resume and preserves HTML/RSC separation and action CSRF.

`cloudflarePpr()` keeps the immutable, build-only cache. Opt in to runtime persistence
with `cloudflarePpr({ durableCache: true })`; the paired `createCacheHandler()` reads
that choice from the generated artifact. The plugin exports RebaskCache, adds the
reserved REBASK_CACHE binding and rebask-cache-v1 SQLite migration, and preserves
other bindings/migrations. Conflicting reserved configuration fails explicitly.
A tiny private runtime module is shared by Vite output and the Worker so both use
one request AsyncLocalStorage. The output remains portable with its cache directory.

## Durable caching and ISR

Sixteen independently named SQLite Durable Objects partition keys by SHA256's first
hex digit. This avoids a single object coordinating every request. Each partition
owns its entries, tag generations and regeneration leases, using synchronous SQL
transactions with no external I/O inside them. Raw URL keys are hashed before RPC.
The partition count/name format is a storage protocol; do not change it in place.

The adapter accepts only native key/type pairs: ph/HTML, pr+ps/RSC, pm/Markdown,
du/use-cache and dd/durableCache. All but dd must match the current deployment ID.
Durable dd keys retain Rebask's source/input-based cross-deployment identity.
Runtime entries take precedence over bundled snapshots. Reads return independent
values. Stale entries remain servable while native Rebask regenerates them; expired
entries are never served. Only framework-eligible, shareable results belong here.
Request-sensitive uncached continuations are not captured as shared page responses.

A generation baseline is captured before a computation, on its cache read or
regeneration claim. A later tag invalidation increments a durable generation.
Writes whose tags changed after their baseline are rejected, even if their final
timestamp is newer. The earliest baseline is retained for the whole request/task:
a second concurrent read cannot authorize an earlier computation's stale write.
A write without a preceding baseline is conservatively skipped.

Revalidation fans out to all16 partitions and resolves only after all acknowledge;
failure is reported and the operation can be retried. Reads after acknowledgment
cannot use invalidated entries. Tagged build snapshots lack runtime generations,
so after any recorded invalidation of a tag they are conservatively excluded,
including across deployments; native runtime generation replaces them. Tombstones
prevent deleted/expired/invalidated runtime entries from resurrecting older seeds.

Native background refresh/promotion claims are atomic, expire after30 seconds and
use random ownership tokens. Old writers and releases are fenced after expiration
or replacement. Each background task gets its own request context. A pinned native
Rebask scheduling bridge attaches it to Workers waitUntil; cache writes are also
kept alive. No public fill/resume/invalidation endpoint is introduced.

## Bounds and operations

Per partition: payload at most1,000,000 UTF-8 bytes; at most512 live payloads and
16,000,000 payload bytes; at most4096 entry/tombstone rows and10000 tag rows.
Entries are evicted by oldest write to enforce payload budgets. Oversized/full
payload writes are skipped; invalidation/delete capacity errors are explicit.
Tags: at most64 per entry,256 characters each. TTL is capped to365 days. Expiration
is checked on reads and lazy/alarm cleanup; tags persist to preserve invalidation.
Applications with larger workloads should measure RPC latency, object placement,
storage usage and capacity, and plan namespace/schema migrations. This is an early
bounded implementation, not a claim of unlimited scale or automatic global locality.

## Streaming and deployment

Browser app responses remain private/no-store. Opt-in exact public paths can store
fresh complete HTML in Cache API behind a durable generation gate. PPR continuations
and viewer responses never enter that cache. Assets retain normal caching.
Resumed HTML uses identity/manual encoding to avoid compression buffering the shell.
The generated config pins the production renderer, including Wrangler preview.
Native Node24 RSC trailer compatibility remains included.

Keep .output, dist and .cache/cloudflare together until Wrangler bundles the Worker.
Durable mode provisions SQLite Durable Objects through Wrangler migrations and has
Cloudflare storage/RPC costs. Immutable mode needs no storage binding. See
[testing](testing.md) and the runnable example.

## Remaining limits

Core0.2.0/Vite8.3.5 and the standard build layout remain pinned. Named Wrangler
environments and advanced relative binding paths are unsupported. Optional CDN HTML caching, signed adapter Draft Mode and public local image
optimization are documented in [platform features](platform-features.md). There is no
queue/WebSocket handler or automatic private-data policy. Authorization, backend
queries, media access and origin allowlists remain the application's responsibility.
Never cache auth tokens, permissions, private media grants or viewer-specific data.
Use local Suspense boundaries before runtime APIs to retain an initial static shell.

## References

- [SQLite Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Storage coordination](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Workers response encoding](https://developers.cloudflare.com/workers/runtime-apis/response/)
- [Rebask](https://www.rebask.com/) and published core0.2.0 source
- [react-ppr-workers inspiration](https://github.com/threepointone/react-ppr-workers)
