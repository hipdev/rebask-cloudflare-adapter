# Testing and troubleshooting

Run npm ci, npm test, npm run typecheck and npm run test:integration on Node 24+.
The unit tests use the actual pinned Rebask base storage and trailer source. The
integration runner builds an npm tarball, installs it into a clean example, runs
Vite against unpatched core, then starts real local Workerd processes. No account
or deployment token is needed. Ports8788 and8789 must be free.

Acceptance checks: initial visible navigation; native HIT/prerender headers;
request-specific viewer markers isolated on the same URL; correct HTML/RSC MIME;
private artifact 404s; cross-origin forged resume 403; delayed actual React resume
with the shell delivered before the1800ms continuation. The delay is injected only
into a copied .artifacts output. The deployable example is not modified.

For a consumer, inspect raw HTML before hidden Fizz segments and before scripts;
then hard reload in a browser, verify hydration/console, mobile chrome and retained
navigation state. Network fragmentation means one transport read is not necessarily
one logical shell. A full response or HIT alone does not prove early shell delivery.

- **Unknown manifest/trailer/version:** do not remove the assertions. Use the exact
  supported versions or contribute a compatibility change with packed-consumer proof.
- **Virtual artifact module unresolved:** use both cloudflarePpr() and the paired
  createCacheHandler() config; do not import the cache factory in arbitrary Node scripts.
- **No cached shell:** check Suspense boundaries above headers/routeParams/session
  reads, that snapshots exist, and that all build directories came from one build.
- **Shell waits for data:** check content-encoding and proxies for buffering; test
  with gzip/br as a browser would. Keep identity/manual encoding for resumed HTML.
- **Private content leaks:** stop publishing and inspect application SSR/cache
  boundaries. The adapter never intentionally stores runtime viewer responses.
- **Binding/config paths:** this release does not rebase advanced relative paths or
  named environments. Keep configs simple and inspect generated Wrangler output.
- **Permission/CSRF errors:** fix the consuming app's exact origin configuration;
  never disable authorization or action CSRF checks to make deployment pass.

CI runs the same clean tarball flow on Node 24 and26. Local timings are controlled
streaming evidence, not production latency guarantees or a universal zero-CLS claim.

## Initial release evidence (2026-11-01)

Six unit regressions passed, including the actual core RSC trailer function with
request-context loss and concurrent late search reads. The clean tarball consumer
passed on Node24.22.1 and Node26.5.0. A controlled Node24 run measured a3ms shell
and1826ms completion with the1800ms React resume delay; these are local timings.

Chrome smoke QA: /alice→/bob, hard reload and Back rendered the matching runtime
content. The final build produced no console warnings/errors. This check caught a
Wrangler development-renderer/production-client Flight mismatch (React504), now
prevented by defining process.env.NODE_ENV as production in the generated Wrangler
configuration. The integration guard asserts that setting. The source Vite dev
server remains a development server; this definition applies to packaged output.


## Durable release 0.2.0 evidence

Fifteen unit tests cover SQL expiry/tombstones, generation fencing for same-millisecond
invalidations and late writers, atomic lease ownership/expiry, payload bounds,
key/type/deployment isolation, invalidation fanout/failure/retry, cross-deployment
durableCache identity and Workers background lifetime. Existing actual RSC trailer
and immutable-mode regressions remain active.

The packed consumer runs native core0.2.0 without external patches in Workerd.
Its public catalog verifies pathname HTML promotion, shared use-cache reuse,
persistence after restarting the Worker, native stale-while-revalidate regeneration
and immediate fresh reads after acknowledged tag invalidation. An authenticated
invalidation route is injected only into the ignored QA copy; no public endpoint
or credential ships in the example/package. Request-specific viewer markers remain
isolated and forged cross-origin resume requests are still rejected.

Controlled streaming measurements: Node24 shell5ms/completion1827ms, Node26
shell4ms/completion1826ms with1800ms injected into actual React resume. These are
local protocol tests, not production latency guarantees. Browser and consuming-app
production evidence are recorded with the release/deployment after publication.
