# Read-only monitor and GitHub Issues notifications

This operational companion consumes the adapter0.5.0 private `adapterHealth()` RPC
through a Cloudflare service binding. It is a separate Worker, not part of the
application or npm runtime. It exposes only authenticated aggregate health plus two
public synthetic page checks. It cannot purge through HTTP and forwards no user
cookies or credentials to the application. Its token grants no account access.

1. Copy this directory outside the package source. Set APP service to your managed
   Rebask Worker and APP_ORIGIN to its exact public HTTPS origin. Review/change
   the two public paths in worker.mjs for your application.
2. Deploy with `npx wrangler deploy --config wrangler.jsonc`. Set a random32-byte
   or longer MONITOR_TOKEN using `wrangler secret put MONITOR_TOKEN`. Do not put
   the value in source, command arguments or logs. Store only the monitor's copy.
3. Configure repository Actions secrets ADAPTER_MONITOR_URL (HTTPS /health) and
   ADAPTER_MONITOR_TOKEN. Enable the repository's alerts.yml workflow. GitHub's
   ephemeral GITHUB_TOKEN needs contents:read, checks:read and issues:write; no
   GitHub token or Cloudflare account token is stored in the monitor/GitHub pair.
4. Dispatch Adapter alerts with test_mode=failure, then recovery. Confirm the
   clearly marked Delivery test issue opens once and closes. Dispatch none to
   validate real health. Missing/bad tokens and unavailable services fail health.

The workflow checks production health and the latest main Cloudflare remote CI
check every15 minutes, best effort. GitHub can delay cron runs or disable inactive
public-repository schedules; this is not a real-time paging SLA. Pending/cancelled
CI checks preserve the existing incident state. Monitor transport failures, a
durable purge backlog alert, public non-200 pages or full public checks taking5s
or longer open one incident. Recovery closes it; unchanged failure adds no comments
or duplicate issues. Test incidents are separate from production and CI incidents.
Only aggregate flags and a link to the Actions run are posted. Email/push delivery
depends on your GitHub notification/watch settings.

The monitor calls the app's private RPC and fetches two public pages each run;
these are real billable service/Worker requests. It does not inspect private
permissions/media/backend data and does not expose fault-injection controls. Keep
nonce-based remote CI testing in its separate ignored standalone QA fixture.
