"use client";

import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Progress,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import type { ExperimentDetail } from "@harnesslab/schemas/types";
import Link from "next/link";
import { useCallback, useState } from "react";
import { active, api } from "./api";
import { Graph } from "./graph";
import {
  HarnessLink,
  human,
  Mode,
  Pending,
  Problem,
  Status,
  time,
} from "./presentation";
import { useToken, useViewMode } from "./shell";
import { useResource } from "./use-resource";

const stages = [
  { id: "diagnose", label: "Diagnose", detail: "Inspect baseline runs", businessLabel: "1. Benchmark Baseline", businessDetail: "Test on 30 business questions" },
  { id: "propose", label: "Propose", detail: "Suggest harness changes", businessLabel: "2. AI Root Cause", businessDetail: "Find bottlenecks & propose fixes" },
  { id: "screen", label: "Screen", detail: "Compare on development tasks", businessLabel: "3. A/B Tournament", businessDetail: "Candidate vs Baseline face-off" },
  { id: "validate", label: "Validate", detail: "Evaluate finalists", businessLabel: "4. Verification", businessDetail: "Test safety & data precision" },
  { id: "report", label: "Report", detail: "Record outcomes and gates", businessLabel: "5. Production Decision", businessDetail: "Audit scorecards & promote" },
];
const running = (value: ExperimentDetail) => active(value.experiment.status);

export function Experiment({ id }: { id: string }) {
  const token = useToken();
  const viewMode = useViewMode();
  const isBusiness = viewMode === "business";
  const [refresh, setRefresh] = useState(0);
  const [command, setCommand] = useState("");
  const [commandError, setCommandError] = useState("");
  const load = useCallback(
    (signal: AbortSignal) =>
      api<ExperimentDetail>(`experiments/${id}?graph=1`, token, { signal }),
    [id, token],
  );
  const result = useResource(`${id}/${refresh}`, load, running);
  const detail = result.value;
  const experiment = detail?.experiment;
  async function act(action: "cancel" | "publish") {
    setCommand(action);
    setCommandError("");
    try {
      await api(`experiments/${id}/${action}`, token, { body: {} });
      setRefresh((n) => n + 1);
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "Command failed.",
      );
    } finally {
      setCommand("");
    }
  }
  return (
    <Stack gap="lg">
      <Anchor component={Link} href="/">
        All experiments
      </Anchor>
      <header className="page-banner">
        <div className="eyebrow">{isBusiness ? "Enterprise AI Optimization Trial" : "Investigation run"}</div>
        <h1 className="page-title">
          {isBusiness
            ? `${experiment?.mode === "live" ? "Claude 4.5 Live Investigation" : "Simulation Trial"} #${id.slice(0, 8)}`
            : `Experiment ${id.slice(0, 8)}`}
        </h1>
        {experiment && (
          <Group>
            <Mode mode={experiment.mode} />
            <Status status={experiment.status} />
            {isBusiness && (
              <Badge color="blue" variant="outline">
                {experiment.scheduled_runs} Business Questions
              </Badge>
            )}
          </Group>
        )}
      </header>

      {isBusiness && experiment && (
        <Card padding="md" radius="md" withBorder bg="var(--mantine-color-blue-0)">
          <Text fw={700} size="sm" c="blue.9">
            📋 Executive Summary: Continuous Agent Optimization
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            HarnessLab tests the production baseline AI against real PostgreSQL business scenarios.
            If Claude runs out of turns or tokens, our AI Optimizer analyzes the exact root cause
            and proposes a targeted configuration patch before running a verified side-by-side tournament.
          </Text>
        </Card>
      )}

      {result.error && <Problem message={result.error} />}
      {!detail && !result.error && (
        <Pending label="Loading experiment progress" />
      )}
      {detail && experiment && (
        <>
          <section className="panel" aria-label="Experiment progress">
            <Group justify="space-between" align="flex-start" mb="md">
              <div>
                <Title order={2}>{isBusiness ? "Pipeline Progression" : "Progress"}</Title>
                <Text size="sm" c="dimmed">
                  {time(experiment.created_at)} · {isBusiness ? "Production Baseline v1.0" : <>Pinned baseline <HarnessLink hash={experiment.baseline_hash} /></>}
                </Text>
              </div>
              <Button
                component={Link}
                href={`/experiments/${id}/compare`}
                variant="light"
                color="teal"
              >
                {isBusiness ? "View A/B Scorecard & Promotion" : "Open comparison"}
              </Button>
            </Group>
            <ol className="stage-track" aria-label="Experiment stages">
              {stages.map((stage, index) => {
                const current = stage.id === experiment.stage;
                const skipped =
                  stage.id === "validate" && experiment.mode === "fixture";
                const label = isBusiness ? stage.businessLabel : stage.label;
                const detailText = isBusiness ? stage.businessDetail : stage.detail;
                return (
                  <li
                    key={stage.id}
                    aria-current={current ? "step" : undefined}
                    data-skipped={skipped || undefined}
                  >
                    <span className="stage-index" aria-hidden="true">
                      0{index + 1}
                    </span>
                    <strong>{label}</strong>
                    <span className="stage-detail">
                      {current
                        ? running(detail)
                          ? "In Progress"
                          : "Completed"
                        : skipped
                          ? "Skipped in fixture"
                          : detailText}
                    </span>
                  </li>
                );
              })}
            </ol>
            <Text size="sm" aria-live="polite">
              {experiment.terminal_runs} of {experiment.scheduled_runs}{" "}
              {isBusiness ? "investigation questions completed" : "scheduled runs complete"}
            </Text>
            <Progress
              mt="sm"
              aria-label="Runs completed"
              value={
                experiment.scheduled_runs
                  ? (100 * experiment.terminal_runs) / experiment.scheduled_runs
                  : 0
              }
            />
            {commandError && <Problem message={commandError} />}
            <Group mt="sm">
              {running(detail) && (
                <Button
                  variant="subtle"
                  color="red"
                  size="compact-sm"
                  loading={command === "cancel"}
                  onClick={() => void act("cancel")}
                >
                  Cancel experiment
                </Button>
              )}
              {detail.active_revision !== undefined &&
                !detail.published &&
                ["completed", "failed"].includes(experiment.status) && (
                  <Button
                    variant="subtle"
                    size="compact-sm"
                    loading={command === "publish"}
                    onClick={() => void act("publish")}
                  >
                    Publish example
                  </Button>
                )}
              {detail.published && <Text size="sm">Published example</Text>}
            </Group>
          </section>
          <section className="panel">
            <Title order={2} mb="sm">
              Diagnosis and proposals
            </Title>
            {detail.clusters?.map((cluster) => (
              <div className="list-item" key={cluster.signature}>
                <Text fw={650}>
                  {human(cluster.signature)} · {cluster.count} affected tasks
                </Text>
                <Group gap="sm">
                  {cluster.evidence_refs.map((ref) => (
                    <Anchor
                      key={`${ref.run_id}/${ref.seq}`}
                      component={Link}
                      href={`/experiments/${id}/compare?run=${ref.run_id}&event=${ref.seq}`}
                    >
                      Failure event {ref.seq}
                    </Anchor>
                  ))}
                </Group>
              </div>
            ))}
            <Graph
              kind="Optimizer"
              graph={detail.optimizer_graph}
              proposal={<Anchor href="#proposals">Proposal decisions</Anchor>}
            />
            <div id="proposals">
              {!detail.proposals.length && (
                <Text size="sm" c="dimmed" mt="md">
                  {running(detail)
                    ? "Proposals appear after diagnosis."
                    : "This experiment produced no proposals."}
                </Text>
              )}
              {detail.proposals.map((proposal) => (
                <div className="list-item" key={proposal.ordinal}>
                  <Group justify="space-between">
                    <Title order={3}>Proposal {proposal.ordinal + 1}</Title>
                    <Status status={proposal.status} />
                  </Group>
                  {proposal.candidate_hash && (
                    <HarnessLink hash={proposal.candidate_hash} />
                  )}
                  {proposal.reason && (
                    <Text size="sm">Reason · {human(proposal.reason)}</Text>
                  )}
                  {proposal.rationale && (
                    <Text size="sm" className="wrap">
                      {proposal.rationale}
                    </Text>
                  )}
                  {proposal.patch?.map((patch) => {
                    const isInspection = patch.path === "/workflow/schema_inspection";
                    const isGuidance = patch.path === "/prompt/task_guidance";
                    const isVerify = patch.path === "/workflow/verify_numeric_answers";
                    return (
                      <div key={patch.path} style={{ marginTop: 4, marginBottom: 4 }}>
                        {isBusiness ? (
                          <Text size="sm">
                            <span style={{ fontWeight: 650, color: "var(--mantine-color-teal-7)" }}>
                              {isInspection
                                ? "💡 Automated Table Inspection"
                                : isGuidance
                                  ? "📝 Updated Guidance Policy"
                                  : isVerify
                                    ? "🔢 Mandatory Calculation Verification"
                                    : patch.path}
                              :
                            </span>{" "}
                            {isInspection && patch.value === "before_first_sql"
                              ? "Pre-fetch database catalog upfront to eliminate redundant exploration turns and prevent budget exhaustion."
                              : JSON.stringify(patch.value)}
                          </Text>
                        ) : (
                          <Text size="sm" className="wrap">
                            <Code>{patch.path}</Code> → {JSON.stringify(patch.value)}
                          </Text>
                        )}
                      </div>
                    );
                  })}
                  <Group gap="sm">
                    {proposal.evidence_refs.map((ref) => (
                      <Anchor
                        key={`${ref.run_id}/${ref.seq}`}
                        component={Link}
                        href={`/experiments/${id}/compare?run=${ref.run_id}&event=${ref.seq}`}
                      >
                        Evidence event {ref.seq}
                      </Anchor>
                    ))}
                  </Group>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <Title order={2}>Arms and review history</Title>
            {detail.arms.map((arm) => (
              <Group key={arm.hash} className="list-item">
                <Text fw={650}>{human(arm.role)}</Text>
                <HarnessLink hash={arm.hash} />
                <Status status={arm.disposition} />
              </Group>
            ))}
            {detail.decisions.map((decision, i) => (
              <div key={i} className="list-item">
                <Text size="sm">
                  {human(decision.kind)} · revision {decision.current_revision}{" "}
                  · {time(decision.created_at)}
                </Text>
                <Text size="sm" className="wrap">
                  {decision.reason}
                </Text>
                <Group>
                  <HarnessLink hash={decision.from_hash} />
                  <span aria-hidden="true">→</span>
                  <HarnessLink hash={decision.to_hash} />
                </Group>
              </div>
            ))}
          </section>
        </>
      )}
    </Stack>
  );
}
