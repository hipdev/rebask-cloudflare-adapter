// GitHub Actions owns its short-lived GITHUB_TOKEN. Cloudflare gets no GitHub token.
const env = process.env;
const category = env.ALERT_CATEGORY || "production";
const testMode = env.ALERT_TEST_MODE || "none";
const marker = `<!-- rebask-alert:${testMode === "none" ? category : "delivery-test"} -->`;
const title = `[Rebask alert] ${testMode !== "none" ? "Delivery test" : category === "ci" ? "Remote CI" : "UHH adapter health"}`;
let healthy, summary;
if (testMode !== "none") {
  healthy = testMode === "recovery";
  summary =
    "Synthetic delivery test; this does not indicate a production outage.";
} else if (category === "ci") {
  const checks = await github("/commits/main/check-runs?per_page=100");
  const check = checks.check_runs.find(
    (item) => item.name === "Workers Builds: rebask-adapter-ci",
  );
  if (
    !check ||
    check.status !== "completed" ||
    !["success", "failure", "timed_out", "action_required"].includes(
      check.conclusion,
    )
  ) {
    console.log("Remote CI pending or cancelled; retain the incident state.");
    process.exit(0);
  }
  healthy = check.conclusion === "success";
  summary =
    "The trusted-main Cloudflare remote CI check " +
    (healthy ? "recovered." : "failed.");
} else {
  try {
    const url = new URL(env.ADAPTER_MONITOR_URL);
    if (url.protocol !== "https:") throw Error("HTTPS required");
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${env.ADAPTER_MONITOR_TOKEN}` },
      signal: AbortSignal.timeout(25000),
      redirect: "error",
    });
    const data = await r.json();
    healthy = r.status === 200 && data.ok === true;
    // Send only fixed aggregate flags; never copy server errors, URLs or response bodies.
    summary = healthy
      ? "Adapter health recovered."
      : `Adapter health failed. Purge backlog alert: ${data.purge?.alertActive === true}; public checks failed: ${(data.checks ?? []).filter((c) => c.status !== 200 || c.ms >= 5000).length}.`;
  } catch {
    healthy = false;
    summary =
      "The authenticated adapter monitor could not be reached or validated.";
  }
}
if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY)
  throw Error("GitHub Actions credentials/repository required");
async function github(path, method = "GET", body) {
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!r.ok) throw Error(`GitHub API status ${r.status}`);
  return r.status === 204 ? null : r.json();
}
const issues = await github(
  "/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100",
);
const incident = issues.find(
  (issue) =>
    !issue.pull_request &&
    issue.title === title &&
    issue.body?.includes(marker),
);
const body = `${marker}\n\n${summary}\n\n[Monitor run](https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID})\n\nAutomatically deduplicated; recovery closes this incident. Scheduled checks run approximately every 15 minutes and may be delayed by GitHub.`;
if (!healthy && !incident) {
  await github("/issues", "POST", { title, body });
  console.log("Opened alert incident.");
} else if (healthy && incident) {
  await github(`/issues/${incident.number}`, "PATCH", {
    state: "closed",
    state_reason: "completed",
    body,
  });
  console.log("Closed recovered alert incident.");
} else
  console.log(
    healthy
      ? "Healthy; no open incident."
      : "Incident already open; duplicate suppressed.",
  );
