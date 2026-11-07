"use client";

import { Button, Group, Stack, Text, Title } from "@mantine/core";
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
import { useToken } from "../src/shell";
import { useResource } from "../src/use-resource";

export default function Home() {
  const token = useToken();
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

  return (
    <Stack gap="xl">
      <section className="hero">
        <div>
          <div className="eyebrow">DataOps evaluation workspace</div>
          <h1>HarnessLab</h1>
          <Text className="hero-description" mb="md" maw={550}>
            Follow an investigation from SQL evidence to a proposed harness
            change, then compare the two on the same tasks.
          </Text>
          <Group mb="lg">
            <Mode mode="fixture" />
          </Group>
          <Group gap="md">
            <Button
              onClick={() => void start("full_live")}
              loading={working}
              color="teal"
            >
              Run Live Claude Sonnet 4.5 (AWS Bedrock)
            </Button>
            <Button
              onClick={() => void start("demo_fixture")}
              loading={working}
              variant="default"
            >
              Run fixture experiment
            </Button>
          </Group>
        </div>
        <div className="panel">
          <div className="eyebrow">Active baseline</div>
          {result.value?.baseline ? (
            <Text mt="xs">
              <HarnessLink hash={result.value.baseline.hash} />
            </Text>
          ) : (
            <Text size="sm" mt="xs">
              The pinned baseline appears with your experiment.
            </Text>
          )}
          <Text size="sm" c="dimmed" mt="sm">
            The fixture uses a preset development roster and genuine PostgreSQL
            tool execution.
          </Text>
        </div>
      </section>
      {error && <Problem message={error} />}
      <section className="panel">
        <Group justify="space-between" mb="sm">
          <div>
            <Title order={2}>Experiment history</Title>
            <Text size="sm" c="dimmed">
              Published examples and experiments from this session.
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
              <Link href={`/experiments/${experiment.id}`}>
                Experiment {experiment.id.slice(0, 8)}
              </Link>
              <Status status={experiment.status} />
            </Group>
            <Group gap="sm" mt="xs">
              <Mode mode={experiment.mode} />
              <Text size="xs" c="dimmed">
                {time(experiment.created_at)} · {experiment.terminal_runs}/
                {experiment.scheduled_runs} runs
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
