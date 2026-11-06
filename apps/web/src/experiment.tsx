"use client";

import {
  Anchor,
  Button,
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
import { useToken } from "./shell";
import { useResource } from "./use-resource";

const stages = ["diagnose", "propose", "screen", "validate", "report"];
const running = (value: ExperimentDetail) => active(value.experiment.status);

export function Experiment({ id }: { id: string }) {
  const token = useToken();
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
      <div>
        <div className="eyebrow">Investigation run</div>
        <h1 className="page-title">Experiment {id.slice(0, 8)}</h1>
        {experiment && (
          <Group>
            <Mode mode={experiment.mode} />
            <Status status={experiment.status} />
          </Group>
        )}
      </div>
      {result.error && <Problem message={result.error} />}
      {!detail && !result.error && (
        <Pending label="Loading experiment progress" />
      )}
      {detail && experiment && (
        <>
          <section className="panel" aria-label="Experiment progress">
            <Group justify="space-between" align="flex-start" mb="md">
              <div>
                <Title order={2}>Progress</Title>
                <Text size="sm" c="dimmed">
                  {time(experiment.created_at)} · Pinned baseline{" "}
                  <HarnessLink hash={experiment.baseline_hash} />
                </Text>
              </div>
              <Button
                component={Link}
                href={`/experiments/${id}/compare`}
                variant="light"
              >
                Open comparison
              </Button>
            </Group>
            <Group gap="xs" mb="sm">
              {stages.map((stage) => (
                <Text
                  key={stage}
                  size="sm"
                  fw={stage === experiment.stage ? 800 : 400}
                  aria-current={stage === experiment.stage ? "step" : undefined}
                >
                  {human(stage)}
                </Text>
              ))}
            </Group>
            <Text size="sm" aria-live="polite">
              {experiment.terminal_runs} of {experiment.scheduled_runs}{" "}
              scheduled runs complete
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
                  {proposal.patch?.map((patch) => (
                    <Text size="sm" key={patch.path} className="wrap">
                      <Code>{patch.path}</Code> → {JSON.stringify(patch.value)}
                    </Text>
                  ))}
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
