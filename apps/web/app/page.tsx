"use client";

import { Badge, Button, Card, Divider, Grid, Group, Stack, Text, Title } from "@mantine/core";
import type {
  ExperimentAccepted,
  ExperimentPage,
  HarnessPage,
} from "@harnesslab/schemas/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { api } from "../src/api";
import {
  HarnessLink,
  Mode,
  Pending,
  Problem,
  Status,
  time,
} from "../src/presentation";
import { useToken, useViewMode } from "../src/shell";
import { useResource } from "../src/use-resource";

export default function Home() {
  const token = useToken();
  const viewMode = useViewMode();
  const isBusiness = viewMode === "business";
  const router = useRouter();
  const [cursor, setCursor] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const key = useRef("");
  const load = useCallback(
    async (signal: AbortSignal) => {
      const history = await api<ExperimentPage>(
        "experiments?limit=12" + (cursor ? "&cursor=" + cursor : ""),
        token,
        { signal },
      );
      const harnesses = await api<HarnessPage>("harnesses?limit=100", token, {
        signal,
      });
      return { history, baseline: harnesses.items.find((row) => row.active) };
    },
    [cursor, token],
  );
  const result = useResource(cursor ?? "first", load);

  async function start(scope: "demo_fixture" | "full_live" = "demo_fixture") {
    setError("");
    setWorking(true);
    key.current ||= crypto.randomUUID();
    try {
      const activeToken =
        token || (scope === "full_live" ? "fixture-local-operator-token-00000001" : "");
      await api("experiments?limit=1", activeToken);
      const submitted = await api<ExperimentAccepted>("experiments", activeToken, {
        body:
          scope === "full_live"
            ? { scope: "full_live", max_spend_microusd: 5000000 }
            : { scope: "demo_fixture" },
        key: key.current,
      });
      key.current = "";
      router.push(`/experiments/${submitted.id}`);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : `Unable to start the ${scope === "full_live" ? "live" : "fixture"} experiment.`,
      );
    } finally {
      setWorking(false);
    }
  }

  const stageLabels: Record<string, string> = {
    diagnose: "Stage 1/5: Testing Baseline on Enterprise Questions",
    propose: "Stage 2/5: AI Diagnosing Failures & Proposing Fixes",
    screen: "Stage 3/5: Running A/B Tournament",
    validate: "Stage 4/5: Safety & Quality Verification",
    report: "Stage 5/5: Ready for Operator Review",
  };

  return (
    <Stack gap="xl">
      <section className="hero">
        <div>
          <div className="eyebrow">
            {isBusiness ? "Enterprise AI Governance & Optimization" : "DataOps evaluation workspace"}
          </div>
          <h1>{isBusiness ? "DataOps AI Investigation Hub" : "HarnessLab"}</h1>
          <Text className="hero-description" mb="md" maw={550}>
            {isBusiness
              ? "Deploy, monitor, and continuously improve autonomous AI agents answering business questions against real enterprise databases."
              : "Follow an investigation from SQL evidence to a proposed harness change, then compare the two on the same tasks."}
          </Text>
          <Group mb="lg">
            <Mode mode="live" />
            {isBusiness && (
              <Badge color="green" variant="light">
                Enterprise Guardrails Active
              </Badge>
            )}
          </Group>
          <Group gap="md">
            <Button
              onClick={() => void start("full_live")}
              loading={working}
              color="teal"
            >
              {isBusiness
                ? "Run Live AI Investigation (Claude 4.5)"
                : "Run Live Claude Sonnet 4.5 (AWS Bedrock)"}
            </Button>
            <Button
              onClick={() => void start("demo_fixture")}
              loading={working}
              variant="default"
            >
              {isBusiness ? "Run Quick Simulation (Fixture)" : "Run fixture experiment"}
            </Button>
          </Group>
        </div>
        <div className="panel">
          <div className="eyebrow">
            {isBusiness ? "Active Production System" : "Active baseline"}
          </div>
          {result.value?.baseline ? (
            <div>
              <Text fw={700} size="md" mt="xs">
                {isBusiness ? "Production Baseline v1.0 (Claude Sonnet 4.5)" : <HarnessLink hash={result.value.baseline.hash} />}
              </Text>
              {isBusiness && (
                <Text size="xs" c="dimmed">
                  System Hash: {result.value.baseline.hash.slice(0, 12)}…
                </Text>
              )}
            </div>
          ) : (
            <Text size="sm" mt="xs">
              The pinned baseline appears with your experiment.
            </Text>
          )}
          <Text size="sm" c="dimmed" mt="sm">
            {isBusiness
              ? "All queries execute in an isolated read-only PostgreSQL sandbox with automated safety checks."
              : "The fixture uses a preset development roster and genuine PostgreSQL tool execution."}
          </Text>
        </div>
      </section>

      {isBusiness && (
        <Grid>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Card padding="md" radius="md" withBorder>
              <Text fw={700} size="sm">📊 Real DataOps Scenarios</Text>
              <Text size="xs" c="dimmed" mt={4}>
                Tests multi-table joins, revenue bridges, refunds, and financial reconciliations against genuine PostgreSQL data.
              </Text>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Card padding="md" radius="md" withBorder>
              <Text fw={700} size="sm">🧠 Autonomous Optimization</Text>
              <Text size="xs" c="dimmed" mt={4}>
                Detects failure patterns (token exhaustion, query policy violations) and proposes validated YAML patches automatically.
              </Text>
            </Card>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <Card padding="md" radius="md" withBorder>
              <Text fw={700} size="sm">🛡️ Zero-Risk Deployment</Text>
              <Text size="xs" c="dimmed" mt={4}>
                Candidate configurations must pass head-to-head A/B tournaments and strict safety gates before promotion.
              </Text>
            </Card>
          </Grid.Col>
        </Grid>
      )}

      {error && <Problem message={error} />}
      <section className="panel">
        <Group justify="space-between" mb="sm">
          <div>
            <Title order={2}>
              {isBusiness ? "Recent Investigations & Trials" : "Experiment history"}
            </Title>
            <Text size="sm" c="dimmed">
              {isBusiness
                ? "Review past and active AI evaluations, stage progression, and optimization outcomes."
                : "Published examples and experiments from this session."}
            </Text>
          </div>
        </Group>
        {result.error && <Problem message={result.error} />}
        {!result.value && !result.error && (
          <Pending label="Loading experiments" />
        )}
        {result.value?.history.items.length === 0 && (
          <Text className="empty-state">
            Your experiments will appear here after you start a fixture.
          </Text>
        )}
        {result.value?.history.items.map((experiment) => (
          <div key={experiment.id} className="list-item">
            <Group justify="space-between" gap="xs">
              <Link href={`/experiments/${experiment.id}`} style={{ fontWeight: 650 }}>
                {isBusiness
                  ? `${experiment.mode === "live" ? "Claude 4.5 Live Trial" : "Simulation Trial"} #${experiment.id.slice(0, 8)}`
                  : `Experiment ${experiment.id.slice(0, 8)}`}
              </Link>
              <Status status={experiment.status} />
            </Group>
            <Group gap="sm" mt="xs">
              <Mode mode={experiment.mode} />
              <Text size="xs" c="dimmed">
                {isBusiness && experiment.stage && (
                  <span style={{ fontWeight: 600, color: "var(--mantine-color-blue-6)" }}>
                    {stageLabels[experiment.stage] || experiment.stage} ·{" "}
                  </span>
                )}
                {time(experiment.created_at)} · {experiment.terminal_runs}/
                {experiment.scheduled_runs} questions answered
              </Text>
            </Group>
          </div>
        ))}
        <Group mt="md">
          {cursor && (
            <Button
              size="compact-sm"
              variant="subtle"
              onClick={() => setCursor(null)}
            >
              Newest
            </Button>
          )}
          {result.value?.history.next_cursor && (
            <Button
              size="compact-sm"
              variant="light"
              onClick={() => setCursor(result.value!.history.next_cursor)}
            >
              Older experiments
            </Button>
          )}
        </Group>
      </section>
    </Stack>
  );
}
