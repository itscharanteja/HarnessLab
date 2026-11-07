import { expect, test } from "@playwright/test";

test("a visitor starts a fixture and follows diagnosis into paired traces", async ({
  page,
}) => {
  test.skip(
    !process.env.HL_E2E_BASE_URL,
    "Use make dev and make test-e2e for the fixture stack",
  );
  test.setTimeout(150000);
  await page.goto("/");
  await page.getByRole("button", { name: "Run fixture experiment" }).click();
  await expect(page).toHaveURL(/\/experiments\/[0-9a-f-]{36}$/, {
    timeout: 20000,
  });
  await expect(page.getByText(/scheduled runs complete/)).toBeVisible();
  await expect(page.getByText("completed", { exact: true })).toBeVisible({
    timeout: 125000,
  });
  await expect(
    page.getByRole("heading", { name: "Optimizer Graph" }),
  ).toBeVisible();
  await expect(
    page.getByText(/schema before discovery · 2 affected tasks/i),
  ).toBeVisible();
  await page
    .locator("summary")
    .filter({ hasText: "Ordered graph events" })
    .click();
  await expect(
    page.getByRole("link", { name: "Proposal decisions" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: /Failure event/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/compare\?run=.*&event=\d+/);
  await expect(
    page.getByRole("heading", { name: "Paired results" }),
  ).toBeVisible();
  await expect(
    page.getByText("Ineligible for promotion · Fixture model"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Operator review" }),
  ).toHaveCount(0);
  const baseline = page.getByRole("region", { name: "Baseline trace" });
  const candidate = page.getByRole("region", { name: "Candidate trace" });
  await expect(
    baseline.getByRole("heading", { name: "Worker Graph" }),
  ).toBeVisible();
  await expect(
    candidate.getByRole("heading", { name: "Worker Graph" }),
  ).toBeVisible();
  const failure = baseline.locator('[data-highlight="true"]');
  await expect(failure).toBeVisible();
  const failureSeq = new URL(page.url()).searchParams.get("event");
  await expect(
    baseline.getByRole("link", {
      name: `Trace event ${failureSeq}`,
      exact: true,
    }),
  ).toBeVisible();
  const path = baseline.getByRole("list", { name: "Worker Graph path" });
  const steps = path.getByRole("button");
  await steps.first().click();
  await expect(steps.first()).toHaveAttribute("aria-current", "step");
  await baseline.getByRole("button", { name: "Next graph step" }).click();
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await baseline.getByRole("button", { name: "Previous graph step" }).click();
  await expect(steps.first()).toHaveAttribute("aria-current", "step");
  await baseline.getByRole("button", { name: "Replay" }).click();
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await baseline.getByRole("button", { name: "Pause" }).click();
  await expect(baseline.getByRole("button", { name: "Replay" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await baseline
    .locator("summary")
    .filter({ hasText: "Ordered graph events" })
    .click();
  await baseline
    .getByRole("link", { name: /Trace event/ })
    .first()
    .click();
  await expect(page).toHaveURL(/#trace-/);
  const version = page
    .getByRole("heading", { name: "Promotion gate" })
    .locator("..")
    .getByRole("link")
    .last();
  await version.click();
  await expect(
    page.getByRole("heading", { name: "Changes from parent" }),
  ).toBeVisible();
  await expect(
    page.getByText("Development only", { exact: true }),
  ).toBeVisible();
});

const id = "67cf8d62-a69d-440e-aee0-3451430099cd";
const runId = "81cf8d62-a69d-440e-aee0-3451430099cd";
const baseline = "1".repeat(64);
const candidate = "2".repeat(64);
const reportDigest = "3".repeat(64);
const baseExperiment = {
  id,
  mode: "fixture",
  scope: "demo_fixture",
  status: "completed",
  stage: "report",
  baseline_hash: baseline,
  created_at: "2026-11-06T08:00:00Z",
  completed_at: "2026-11-06T08:01:00Z",
  scheduled_runs: 1,
  terminal_runs: 1,
};
const detail = {
  experiment: baseExperiment,
  published: false,
  channel_revision: 1,
  arms: [],
  proposals: [
    {
      ordinal: 0,
      status: "rejected",
      reason: "invalid_patch",
      evidence_refs: [],
    },
  ],
  decisions: [],
  optimizer_graph: null,
  clusters: [],
};
const legacy = {
  run_id: runId,
  task_key: "synthetic-business-v1/dev/d01/schema_discovery/001",
  stage: "diagnose",
  repeat: 1,
  harness_hash: baseline,
  result: "unable",
  grade: { schema_version: 1, success: false, reasons: ["unable"] },
};

test("rejected proposals and legacy traces are inspectable", async ({
  page,
}) => {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/comparisons"))
      return route.fulfill({ json: { items: [] } });
    if (path.endsWith("/runs"))
      return route.fulfill({ json: { items: [legacy], next_cursor: null } });
    if (path.endsWith("/trace"))
      return route.fulfill({
        json: {
          run: legacy,
          items: [
            {
              kind: "policy_decision",
              seq: 1,
              outcome_code: "schema_error",
              elapsed_ms: 10,
              payload: { reason: "schema_error" },
            },
          ],
          next_cursor: null,
          worker_graph: null,
        },
      });
    return route.fulfill({ json: detail });
  });
  await page.goto(`/experiments/${id}`);
  await expect(page.getByText("rejected", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open comparison" }).click();
  await expect(
    page.getByText(
      "Graph events unavailable. The stored records are shown below.",
    ),
  ).toBeVisible();
  await expect(page.getByText(/schema error/)).toBeVisible();
});

test("an operator confirms the reviewed digest and revision and rolls back", async ({
  page,
}) => {
  let revision = 2;
  const metric = {
    successes: 1,
    scheduled: 1,
    success_rate: "1",
    tool_calls_per_success: "2",
    mean_calls_successful: "2",
    worker_cost_per_success: "100",
    invalid_sql_attempts: 0,
    sql_attempts: 1,
    recovered_faults: 0,
    scheduled_recoverable_faults: 0,
    p50_ms: 100,
    p95_ms: 100,
  };
  const report = {
    report_digest: reportDigest,
    scope: "validation",
    mode: "live",
    complete: true,
    winner: true,
    baseline_hash: baseline,
    candidate_hash: candidate,
    baseline: metric,
    candidate: metric,
    paired: {
      wins: 1,
      losses: 0,
      ties: 0,
      success_delta: "1",
      cost_reduction: "0.3",
    },
    categories: [],
    uncertainty: null,
    gates: [{ gate: "quality", status: "passed", reason: "ok" }],
  };
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const authorized =
      request.headers().authorization === "Bearer local-browser-operator";
    if (request.method() === "POST") {
      expect(authorized).toBe(true);
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      if (path.endsWith("/reject")) {
        expect(request.postDataJSON()).toEqual({
          candidate_hash: candidate,
          report_digest: reportDigest,
          expected_revision: 2,
          reason: "Reviewed report",
        });
      } else {
        expect(path.endsWith("/channels/production/rollback")).toBe(true);
        expect(request.postDataJSON()).toEqual({
          expected_revision: 2,
          reason: "Restore previous harness",
        });
        revision++;
      }
      return route.fulfill({ json: { code: "ok", decision_id: id, revision } });
    }
    if (path.endsWith("/comparisons"))
      return route.fulfill({ json: { items: [report] } });
    if (path.endsWith("/runs"))
      return route.fulfill({ json: { items: [], next_cursor: null } });
    return route.fulfill({
      json: {
        ...detail,
        experiment: { ...baseExperiment, mode: "live", scope: "full_live" },
        ...(authorized
          ? { active_revision: revision, channel: "production" }
          : {}),
      },
    });
  });
  await page.goto(`/experiments/${id}/compare`);
  await expect(
    page.getByRole("heading", { name: "Paired results" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Operator review" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Operator access" }).click();
  await page.getByLabel("Operator access token").fill("local-browser-operator");
  await page.getByRole("button", { name: "Use token" }).click();
  await page.getByRole("button", { name: "Reject candidate" }).click();
  await expect(
    page.getByRole("dialog").getByText(`Report digest · ${reportDigest}`),
  ).toBeVisible();
  await page.getByLabel("Review reason").fill("Reviewed report");
  await page.getByRole("button", { name: "Confirm reject" }).click();
  await expect(page.getByText("Decision recorded · revision 2")).toBeVisible();
  await page.getByRole("button", { name: "Roll back active harness" }).click();
  await page.getByLabel("Review reason").fill("Restore previous harness");
  await page.getByRole("button", { name: "Confirm rollback" }).click();
  await expect(page.getByText("Decision recorded · revision 3")).toBeVisible();
});
