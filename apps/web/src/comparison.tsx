"use client";

import {
  Anchor,
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
import { useCallback, useState } from "react";
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
import { useToken } from "./shell";
import { Trace } from "./trace";
import { useResource } from "./use-resource";

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

function Metrics({ report }: { report: EvaluationReport }) {
  const uncertainty = report.uncertainty;
  return (
    <section className="panel" id="paired-results">
      <Group justify="space-between">
        <Title order={2}>Paired results</Title>
        <Status status={report.complete ? "complete" : "incomplete"} />
      </Group>
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
              <div className="pair-grid">
                <Trace
                  label="Baseline"
                  run={pair?.baseline}
                  highlight={
                    pair?.baseline?.run_id === runId ? event : undefined
                  }
                />
                <Trace
                  label="Candidate"
                  run={pair?.candidate}
                  highlight={
                    pair?.candidate?.run_id === runId ? event : undefined
                  }
                />
              </div>
            ) : (
              <Text size="sm" c="dimmed" className="panel">
                There are no per-task runs available for this comparison.
              </Text>
            )}
          </section>
          {report ? (
            <>
              <Metrics report={report} />
              <section className="panel">
                <Title order={2}>Promotion gate</Title>
                <Text size="sm">
                  Baseline <HarnessLink hash={report.baseline_hash} /> ·
                  Candidate <HarnessLink hash={report.candidate_hash} />
                </Text>
                <Text size="xs" c="dimmed" className="wrap">
                  Report digest · {report.report_digest}
                </Text>
                <Text size="sm" mt="sm" fw={700}>
                  {report.winner
                    ? "Eligible for operator review"
                    : report.mode === "fixture"
                      ? "Ineligible for promotion · Fixture model"
                      : "No qualifying candidate in this comparison"}
                </Text>
                {report.gates.map((gate) => (
                  <Group key={gate.gate} className="list-item">
                    <Text size="sm">{human(gate.gate)}</Text>
                    <Status status={gate.status} />
                    <Text size="sm">{human(gate.reason)}</Text>
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
