"use client";

import {
  Anchor,
  Card,
  Grid,
  Group,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import type {
  ArmMetrics,
  EvaluationReport,
  ExperimentComparisons,
  ExperimentDetail,
  RunPage,
  TaskRunSummary,
} from "@harnesslab/schemas/types";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { active, api } from "./api";
import {
  decimal,
  HarnessLink,
  human,
  Mode,
  pct,
  Pending,
  Problem,
  shortHash,
  Status,
} from "./presentation";
import { Review } from "./review";
import { useToken, useViewMode } from "./shell";
import {
  HeadToHeadOutputComparison,
  computeDivergenceStep,
  extractInvestigationSteps,
} from "./live-data";
import { loadTrace, Trace } from "./trace";
import { useResource } from "./use-resource";
import { WorkbenchControls } from "./workbench";

async function loadComparison(id: string, token: string, signal: AbortSignal) {
  const [detail, reports, first] = await Promise.all([
    api<ExperimentDetail>(`experiments/${id}`, token, { signal }),
    api<ExperimentComparisons>(`experiments/${id}/comparisons`, token, {
      signal,
    }),
    api<RunPage>(`experiments/${id}/runs?limit=100`, token, { signal }),
  ]);
  const runs = [...first.items];
  let cursor = first.next_cursor;
  for (let page = 0; cursor && page < 5; page++) {
    const next = await api<RunPage>(
      `experiments/${id}/runs?limit=100&cursor=${cursor}`,
      token,
      { signal },
    );
    runs.push(...next.items);
    cursor = next.next_cursor;
  }
  return { detail, reports: reports.items, runs };
}
const running = (value: Awaited<ReturnType<typeof loadComparison>>) =>
  active(value.detail.experiment.status);

const metricRows: [string, (arm: ArmMetrics) => string | number][] = [
  ["Successes / scheduled", (a) => `${a.successes} / ${a.scheduled}`],
  ["Success rate", (a) => pct(a.success_rate)],
  ["Tool calls / success", (a) => decimal(a.tool_calls_per_success)],
  ["Calls among successes", (a) => decimal(a.mean_calls_successful)],
  ["Worker cost / success (µUSD)", (a) => decimal(a.worker_cost_per_success)],
  [
    "Invalid SQL attempts",
    (a) => `${a.invalid_sql_attempts} / ${a.sql_attempts}`,
  ],
  [
    "Recovered injections",
    (a) => `${a.recovered_faults} / ${a.scheduled_recoverable_faults}`,
  ],
  ["p50 / p95 latency (ms)", (a) => `${a.p50_ms ?? "—"} / ${a.p95_ms ?? "—"}`],
];

function Metrics({
  report,
  isBusiness,
}: {
  report: EvaluationReport;
  isBusiness?: boolean;
}) {
  const uncertainty = report.uncertainty;
  return (
    <section className="panel" id="paired-results">
      <Group justify="space-between">
        <Title order={2}>
          {isBusiness
            ? "Executive Scorecard: Baseline vs Candidate"
            : "Paired results"}
        </Title>
        <Status status={report.complete ? "complete" : "incomplete"} />
      </Group>

      {isBusiness && (
        <Grid mt="md" mb="md">
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Card
              padding="md"
              radius="md"
              withBorder
              bg="var(--mantine-color-green-0)"
            >
              <Text size="xs" c="dimmed" fw={600}>
                🏆 HEAD-TO-HEAD OUTCOME
              </Text>
              <Text fw={800} size="xl" c="green.9" mt={4}>
                {report.paired.wins} Wins · {report.paired.ties} Ties
              </Text>
              <Text size="xs" c="green.8">
                Candidate outperformed Baseline on {report.paired.wins} matched
                business scenarios
              </Text>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Card
              padding="md"
              radius="md"
              withBorder
              bg="var(--mantine-color-teal-0)"
            >
              <Text size="xs" c="dimmed" fw={600}>
                📈 ACCURACY GAIN
              </Text>
              <Text fw={800} size="xl" c="teal.9" mt={4}>
                {pct(report.paired.success_delta)}
              </Text>
              <Text size="xs" c="teal.8">
                Net improvement in question answer accuracy
              </Text>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Card
              padding="md"
              radius="md"
              withBorder
              bg="var(--mantine-color-blue-0)"
            >
              <Text size="xs" c="dimmed" fw={600}>
                💰 COST EFFICIENCY
              </Text>
              <Text fw={800} size="xl" c="blue.9" mt={4}>
                {pct(report.paired.cost_reduction)}
              </Text>
              <Text size="xs" c="blue.8">
                Reduction in LLM tokens & query execution costs
              </Text>
            </Card>
          </Grid.Col>
        </Grid>
      )}

      <Text size="sm" c="dimmed" mb="md">
        {report.paired.wins} wins · {report.paired.losses} losses ·{" "}
        {report.paired.ties} ties
        {" · "}Success change {pct(report.paired.success_delta)} · Cost
        reduction {pct(report.paired.cost_reduction)}
      </Text>
      <div className="scroll-table">
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Measure</Table.Th>
              <Table.Th scope="col">Baseline</Table.Th>
              <Table.Th scope="col">Candidate</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {metricRows.map(([label, measure]) => (
              <Table.Tr key={label}>
                <Table.Th scope="row">{label}</Table.Th>
                <Table.Td>{measure(report.baseline)}</Table.Td>
                <Table.Td>{measure(report.candidate)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      <details>
        <summary>Per-category outcomes</summary>
        <div className="scroll-table">
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">Category</Table.Th>
                <Table.Th scope="col">Baseline successes</Table.Th>
                <Table.Th scope="col">Candidate successes</Table.Th>
                <Table.Th scope="col">Change</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {report.categories.map((group) => (
                <Table.Tr key={group.category}>
                  <Table.Th scope="row">{human(group.category)}</Table.Th>
                  <Table.Td>
                    {group.baseline.successes}/{group.baseline.scheduled}
                  </Table.Td>
                  <Table.Td>
                    {group.candidate.successes}/{group.candidate.scheduled}
                  </Table.Td>
                  <Table.Td>{pct(group.paired.success_delta)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      </details>
      <Title order={3} mt="md">
        Uncertainty
      </Title>
      {uncertainty ? (
        <Stack gap="xs">
          <Text size="sm">
            95% success change ·{" "}
            {uncertainty.success_delta_95
              ? `${pct(uncertainty.success_delta_95.low)} to ${pct(uncertainty.success_delta_95.high)}`
              : "Unavailable"}
          </Text>
          <Text size="sm">
            95% cost reduction ·{" "}
            {uncertainty.cost_reduction_95
              ? `${pct(uncertainty.cost_reduction_95.low)} to ${pct(uncertainty.cost_reduction_95.high)}`
              : "Unavailable"}
          </Text>
          <Text size="sm">
            One-sided lower bounds · success{" "}
            {pct(uncertainty.success_delta_lower)} · cost{" "}
            {pct(uncertainty.cost_reduction_lower)}
          </Text>
          <details>
            <summary>Leave-one-variant-out sensitivity</summary>
            <ul>
              {uncertainty.leave_one_variant_out.map((row) => (
                <li key={row.variant_id}>
                  {row.variant_id} · success {pct(row.paired.success_delta)} ·
                  cost {pct(row.paired.cost_reduction)}
                </li>
              ))}
            </ul>
          </details>
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          Confidence intervals are unavailable for this comparison.
        </Text>
      )}
    </section>
  );
}

function matched(
  runs: TaskRunSummary[],
  baseline: string,
  candidate: string | undefined,
  validation: boolean,
) {
  const cells = new Map<
    string,
    { baseline?: TaskRunSummary; candidate?: TaskRunSummary }
  >();
  for (const run of runs) {
    if (validation !== (run.stage === "validate")) continue;
    if (run.harness_hash !== baseline && run.harness_hash !== candidate)
      continue;
    const key = `${run.task_key}|${run.repeat}`;
    const pair = cells.get(key) ?? {};
    if (run.harness_hash === baseline) {
      if (!pair.baseline || run.stage === "screen") pair.baseline = run;
    } else {
      pair.candidate = run;
    }
    cells.set(key, pair);
  }
  return cells;
}

function PairedExecutionSection({
  baselineRun,
  candidateRun,
  taskKey,
  runId,
  event,
  isBusiness,
}: {
  baselineRun?: TaskRunSummary;
  candidateRun?: TaskRunSummary;
  taskKey?: string;
  runId?: string;
  event?: number;
  isBusiness: boolean;
}) {
  const token = useToken();
  const baseId = baselineRun?.run_id ?? "";
  const candId = candidateRun?.run_id ?? "";

  const loadBase = useCallback(
    (signal: AbortSignal) =>
      baseId ? loadTrace(baseId, token, signal) : Promise.resolve(null),
    [baseId, token],
  );
  const loadCand = useCallback(
    (signal: AbortSignal) =>
      candId ? loadTrace(candId, token, signal) : Promise.resolve(null),
    [candId, token],
  );

  const baseResult = useResource(baseId, loadBase);
  const candResult = useResource(candId, loadCand);

  const [sharedSqlOnly, setSharedSqlOnly] = useState(false);
  const [expandAllTrigger, setExpandAllTrigger] = useState(0);
  const [collapseAllTrigger, setCollapseAllTrigger] = useState(0);

  const divergence = useMemo(
    () =>
      computeDivergenceStep(baseResult.value?.items, candResult.value?.items),
    [baseResult.value?.items, candResult.value?.items],
  );

  const baseSteps = useMemo(
    () =>
      baseResult.value?.items
        ? extractInvestigationSteps(baseResult.value.items)
        : [],
    [baseResult.value?.items],
  );
  const candSteps = useMemo(
    () =>
      candResult.value?.items
        ? extractInvestigationSteps(candResult.value.items)
        : [],
    [candResult.value?.items],
  );
  const baseSqlCount = baseSteps.filter((s) => s.kind === "sql_query").length;
  const candSqlCount = candSteps.filter((s) => s.kind === "sql_query").length;

  return (
    <>
      {isBusiness && (
        <HeadToHeadOutputComparison
          baselineItems={baseResult.value?.items}
          candidateItems={candResult.value?.items}
          taskKey={taskKey}
        />
      )}

      {!isBusiness && (
        <WorkbenchControls
          sqlOnly={sharedSqlOnly}
          onToggleSqlOnly={setSharedSqlOnly}
          onExpandAll={() => setExpandAllTrigger((n) => n + 1)}
          onCollapseAll={() => setCollapseAllTrigger((n) => n + 1)}
          sqlCount={Math.max(baseSqlCount, candSqlCount)}
          totalSteps={Math.max(baseSteps.length, candSteps.length)}
          divergenceSeq={divergence?.baseSeq ?? divergence?.candSeq}
        />
      )}

      <div className="pair-grid">
        <Trace
          label="Baseline"
          run={baselineRun}
          highlight={baselineRun?.run_id === runId ? event : undefined}
          divergenceSeq={divergence?.baseSeq}
          sqlOnly={sharedSqlOnly}
          onToggleSqlOnly={setSharedSqlOnly}
          expandAllTrigger={expandAllTrigger}
          collapseAllTrigger={collapseAllTrigger}
          hideControls={!isBusiness}
          traceResource={baseResult}
        />
        <Trace
          label="Candidate"
          run={candidateRun}
          highlight={candidateRun?.run_id === runId ? event : undefined}
          divergenceSeq={divergence?.candSeq}
          sqlOnly={sharedSqlOnly}
          onToggleSqlOnly={setSharedSqlOnly}
          expandAllTrigger={expandAllTrigger}
          collapseAllTrigger={collapseAllTrigger}
          hideControls={!isBusiness}
          traceResource={candResult}
        />
      </div>
    </>
  );
}

export function Comparison({
  id,
  runId,
  event,
}: {
  id: string;
  runId?: string;
  event?: number;
}) {
  const token = useToken();
  const viewMode = useViewMode();
  const isBusiness = viewMode === "business";
  const [reportId, setReportId] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [reviewStatus, setReviewStatus] = useState("");
  const load = useCallback(
    (signal: AbortSignal) => loadComparison(id, token, signal),
    [id, token],
  );
  const result = useResource(`${id}/${version}`, load, running);
  const data = result.value;
  const detail = data?.detail;
  const targetRun = data?.runs.find((row) => row.run_id === runId);
  const report =
    data?.reports.find((row) => row.report_digest === reportId) ??
    data?.reports.find(
      (row) =>
        targetRun &&
        (row.scope === "validation") === (targetRun.stage === "validate") &&
        [row.baseline_hash, row.candidate_hash].includes(
          targetRun.harness_hash,
        ),
    ) ??
    data?.reports.find((row) => row.winner) ??
    data?.reports[0];
  const candidate =
    report?.candidate_hash ??
    detail?.arms.find((arm) => arm.role === "candidate")?.hash;
  const cells =
    data && detail
      ? matched(
          data.runs,
          detail.experiment.baseline_hash,
          candidate,
          report?.scope === "validation",
        )
      : new Map();
  const targetCell = targetRun
    ? `${targetRun.task_key}|${targetRun.repeat}`
    : null;
  const selection =
    selectedCell && cells.has(selectedCell)
      ? selectedCell
      : targetCell && cells.has(targetCell)
        ? targetCell
        : [...cells.keys()].sort()[0];
  const pair = selection ? cells.get(selection) : undefined;
  return (
    <Stack gap="lg">
      <Anchor component={Link} href={`/experiments/${id}`}>
        Back to experiment
      </Anchor>
      <header className="page-banner">
        <div className="eyebrow">Matched trial</div>
        <h1 className="page-title">Comparison</h1>
        <p>Follow the baseline and candidate through the same investigation.</p>
        {detail && (
          <Group>
            <Mode mode={detail.experiment.mode} />
            <Status status={detail.experiment.status} />
            {report && (
              <Anchor href="#paired-results">Jump to paired results ↓</Anchor>
            )}
          </Group>
        )}
      </header>
      {result.error && <Problem message={result.error} />}
      {reviewStatus && <Text role="status">{reviewStatus}</Text>}
      {!detail && !result.error && <Pending label="Loading comparisons" />}
      {detail && data && (
        <>
          <section
            aria-labelledby="paired-traces-heading"
            className="trace-workspace"
          >
            <div className="panel trace-workspace-header">
              <div className="eyebrow">Execution replay</div>
              <Title id="paired-traces-heading" order={2}>
                Paired traces
              </Title>
              <Text size="sm" c="dimmed" mb="md">
                Select a step or replay the recorded path. Each arm opens its
                own evidence.
              </Text>
              <div className="trace-filters">
                {cells.size > 0 && (
                  <Select
                    label="Matched task and repeat"
                    searchable
                    allowDeselect={false}
                    value={selection}
                    onChange={setSelectedCell}
                    data={[...cells.keys()].sort().map((value) => {
                      const [task, repeat] = value.split("|");
                      const [, , variant, category, slot] = task!.split("/");
                      return {
                        value,
                        label: `${human(category ?? task!)} · ${variant ?? ""}/${slot ?? ""} · repeat ${repeat}`,
                      };
                    })}
                  />
                )}
                {data.reports.length > 0 && (
                  <Select
                    label="Candidate comparison"
                    allowDeselect={false}
                    value={report?.report_digest ?? null}
                    data={data.reports.map((row) => ({
                      value: row.report_digest,
                      label: `${shortHash(row.candidate_hash)} · ${human(row.scope)}`,
                    }))}
                    onChange={(next) => {
                      setReportId(next);
                      setSelectedCell(null);
                    }}
                  />
                )}
              </div>
            </div>
            {cells.size ? (
              <PairedExecutionSection
                baselineRun={pair?.baseline}
                candidateRun={pair?.candidate}
                taskKey={selection ?? undefined}
                runId={runId}
                event={event}
                isBusiness={isBusiness}
              />
            ) : (
              <Text size="sm" c="dimmed" className="panel">
                There are no per-task runs available for this comparison.
              </Text>
            )}
          </section>
          {report ? (
            <>
              <Metrics report={report} isBusiness={isBusiness} />
              <section className="panel">
                <Title order={2}>
                  {isBusiness
                    ? "Enterprise Quality & Safety Verdict"
                    : "Promotion gate"}
                </Title>
                <Text size="sm">
                  {isBusiness ? (
                    <>Tested: Current Baseline vs Proposed Candidate</>
                  ) : (
                    <>
                      Baseline <HarnessLink hash={report.baseline_hash} /> ·
                      Candidate <HarnessLink hash={report.candidate_hash} />
                    </>
                  )}
                </Text>
                {!isBusiness && (
                  <Text size="xs" c="dimmed" className="wrap">
                    Report digest · {report.report_digest}
                  </Text>
                )}
                <Text size="sm" mt="sm" fw={700}>
                  {report.winner
                    ? isBusiness
                      ? "✅ All Quality & Safety Gates Passed — Ready for Production Promotion"
                      : "Eligible for operator review"
                    : report.mode === "fixture"
                      ? isBusiness
                        ? "Simulation Complete — Fixture mode only (Live model needed for deployment)"
                        : "Ineligible for promotion · Fixture model"
                      : isBusiness
                        ? "Candidate did not beat baseline on accuracy/cost gates"
                        : "No qualifying candidate in this comparison"}
                </Text>
                {report.gates.map((gate) => (
                  <Group key={gate.gate} className="list-item">
                    <Text size="sm" fw={600}>
                      {human(gate.gate)}
                    </Text>
                    <Status status={gate.status} />
                    <Text size="sm" c="dimmed">
                      {human(gate.reason)}
                    </Text>
                  </Group>
                ))}
              </section>
            </>
          ) : (
            <section className="panel">
              <Title order={2}>Comparison pending</Title>
              <Text size="sm">
                {running(data)
                  ? "Paired reports appear after screening or validation."
                  : "This experiment ended without a paired report."}
              </Text>
            </section>
          )}
          <Review
            detail={detail}
            report={report}
            refresh={(message) => {
              setReviewStatus(message);
              setVersion((n) => n + 1);
            }}
          />
        </>
      )}
    </Stack>
  );
}
