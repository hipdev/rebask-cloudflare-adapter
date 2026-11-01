# Operations, durable purge retries and remote CI (0.5.0)

## Persistent purge outbox

Managed `pageCache.mode: "workers-cache"` now generates a SQLite `RebaskPurge`
Durable Object (`REBASK_PURGE`), migration `rebask-purge-v1`, and a same-Worker
`REBASK_SELF` service binding. Keep these generated resources paired with the
Worker. Preserve existing cache shards and migration history when upgrading.
No external queue, account token or public HTTP management endpoint is required.

After durable tag fanout and generation advancement, invalidation records a
monotonic purge ticket in one bounded SQL row. An alarm is armed before intent is
persisted. Calls coalesce; completing an older ticket cannot clear newer work.
The coordinator invokes private `purgePageCache()` RPC on the default Worker
entrypoint, because native Workers Cache purges are scoped to that entrypoint.
Failures remain pending across restarts and deployments, retrying with exponential
backoff (1 second through 5 minutes, plus up to 1 second jitter), without an
application retry exhaustion limit. A 30-second owner-fenced lease recovers crashes
and duplicate delivery. One final empty alarm is harmless and does not rearm.
Cloudflare's own finite alarm retry budget is not the retry queue.

If the native purge is not yet confirmed, invalidation throws explicitly even
though the intent is safely queued. Do not report the mutation as globally fresh
or blindly retry an entire business transaction: keep business mutations
idempotent and handle cache invalidation errors separately. Successful retries
mean provider acceptance, not a globally atomic purge. During an outage native
cached pages can remain visible until their bounded TTL or purge propagation;
select `cache-api` mode if every origin hit must check generation.

## Metrics and alert events

Enable `telemetry: { slowHeadersMs: 5000 }` in `cloudflareAdapter(...)`. This enables
Workers observability and emits structured `rebask.request` records: method,
status, header latency, PPR/draft flags and cache strategy. No URL, query, cookies,
authentication header, exception message, actor or application tag is logged by
these records. Header latency is not full streamed-response time. Regular
Cloudflare invocation metadata is controlled separately by Cloudflare.

`rebask.alert` events flag request errors, exceptions and slow headers. The durable
purge coordinator always emits `rebask.purge` counters and `purge_backlog` alert
transitions: firing after 3 failures or 60 seconds pending, resolved after the
backlog clears. The alert state survives restarts and suppresses unchanged
transitions. `adapterHealth()` is private service RPC returning aggregate durable
purge counters/state, never an unauthenticated HTTP health/purge endpoint.

These are log events, not outbound email/webhook delivery. In Workers Logs filter
`event = rebask.alert`; inspect `kind`, `state`, `attempts`, `pendingAgeMs`. Route
them through your chosen Cloudflare monitor/destination for notifications. Do not
assume someone receives a notification until that destination is configured and
tested. Native managed HITs bypass user code and therefore produce no
`rebask.request` record: use Cloudflare's native cache/request metrics and traces
for HIT ratios, total traffic and proof of skipped execution.

## Remote CI

GitHub Actions runs the clean packed-consumer suite on Node24/26, without account
credentials, for pushes and PRs. Cloudflare Workers Builds runs a separate
**trusted main only** suite on a dedicated QA Worker. Do not enable preview/fork
builds or provide account credentials to untrusted PR code. Reuse a stored Build
token with the required Worker/DO/Images permissions; do not commit it or export
Wrangler login/refresh credentials to GitHub.

Build command:

```sh
npm ci && npm test && npm run typecheck && npm run test:integration
```

Deploy/test command (replace the URL with your dedicated QA Worker):

```sh
QA_ORIGIN=https://rebask-adapter-ci.YOUR-SUBDOMAIN.workers.dev node scripts/remote-ci.mjs
```

Use Node24+, repository root `/`, production branch `main`, preview builds off.
`QA_WORKER_NAME` defaults to `rebask-adapter-ci`; it must match the Worker linked
to the build. Provision its workers.dev URL on the first deployment. Avoid
parallel builds targeting the same QA Worker. This suite deploys twice and makes
real platform requests, using billable Workers/DO/Images/build resources.

The script regenerates nonce-protected controls only in ignored QA output, checks
native HIT execution IDs, auth/RSC/Draft bypass, real tag purging, late-fill fencing,
viewer isolation and delayed PPR. It injects purge failure, queues three requests,
waits for an alert, deploys another version, confirms durable pending state, then
removes the fault and waits for automatic recovery/alert resolution. A failed
assertion fails the remote Build check. Sanitized `.artifacts/remote-ci.json` is
local evidence. Production adapter output has none of these QA controls.

Maintainer platform test on 2026-11-01 passed retry/restart/coalescing and
firing/resolved state, real native purge, all bypass tests and delayed PPR
(shell128ms, completion1930ms). This is evidence from one Cloudflare location,
not a global propagation SLA or a load/cost benchmark.

## GitHub Issues delivery companion

The repository now includes [the read-only companion monitor](../examples/monitor/README.md)
and `.github/workflows/alerts.yml`. It polls aggregate purge health and public
synthetic checks, plus the latest trusted-main Cloudflare Build check, every15
minutes and deduplicates failures into GitHub Issues that close on recovery.
A monitor-only secret protects HTTP health; no account credential is given to
GitHub and no GitHub credential is given to Cloudflare. Outbound issue delivery
uses GitHub Actions' short-lived repository token with issues:write. Test failure/
recovery dispatches use a separate clearly marked synthetic incident. These are
optional operational resources outside the published npm runtime. Read the
companion README for setup, billing and GitHub schedule/notification limitations.

Issue monitoring samples current durable backlog state and two public paths;
short incidents between polls can remain visible only in Workers Logs. Per-request
error/slow-header events also remain in Logs unless a separate log destination is
configured. The monitor is not a global per-route error-rate or real-time pager.
