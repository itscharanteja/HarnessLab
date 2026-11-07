"use client";

import { Badge, Button, Group, Text, Title } from "@mantine/core";
import type { GraphProjection } from "@harnesslab/schemas/types";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { human } from "./presentation";

const nodeLabels: Record<string, string> = {
  model_turn: "Model turn",
  route_action: "Route action",
  dispatch: "Tool dispatch",
  suggest: "Suggest changes",
  validate: "Validate proposals",
  finish: "Finalize",
};
const supportedNodes: Record<string, string[]> = {
  worker_v1: ["model_turn", "route_action", "dispatch"],
  optimizer_v1: ["suggest", "validate", "finish"],
};

const nodeLabel = (id: string) => nodeLabels[id] ?? human(id);

export function eventTone(code: string) {
  if (code === "recovered") return "recovery";
  if (
    [
      "ok",
      "started",
      "requested",
      "answered",
      "clarified",
      "passed",
      "schema_preflight",
    ].includes(code)
  )
    return "normal";
  return "attention";
}

export function Graph({
  graph,
  kind,
  initialEvidence,
  evidence,
  inspectEvidence,
  proposal,
}: {
  graph: GraphProjection | null | undefined;
  kind: "Worker" | "Optimizer";
  initialEvidence?: number;
  evidence?: (seq: number) => ReactNode;
  inspectEvidence?: (seq: number) => ReactNode;
  proposal?: ReactNode;
}) {
  const heading = kind + " Graph";
  const [selected, setSelected] = useState<number>();
  const [playing, setPlaying] = useState(false);
  const track = useRef<HTMLOListElement>(null);
  const events = graph?.events;
  const count = events?.length ?? 0;
  const linkedStep = events?.findIndex(
    (step) =>
      initialEvidence !== undefined &&
      step.evidence_seq !== null &&
      step.evidence_seq >= initialEvidence,
  );
  const index = Math.min(
    Math.max(0, count - 1),
    selected ?? Math.max(0, linkedStep ?? 0),
  );
  const current = events?.[index];
  const atEnd = index >= count - 1;
  const replaying = playing && !atEnd;
  const evidenceSeq =
    (selected === undefined ? initialEvidence : undefined) ??
    current?.evidence_seq;

  useEffect(() => {
    if (!replaying) return;
    const timer = setTimeout(() => {
      setSelected(index + 1);
      if (index + 1 === count - 1) setPlaying(false);
    }, 850);
    return () => clearTimeout(timer);
  }, [count, index, replaying]);

  useEffect(() => {
    const list = track.current;
    const item = list?.children[index] as HTMLElement | undefined;
    if (!list || !item) return;
    if (
      item.offsetLeft < list.scrollLeft ||
      item.offsetLeft + item.offsetWidth > list.scrollLeft + list.clientWidth
    ) {
      list.scrollLeft = item.offsetLeft - 8;
    }
  }, [count, index]);

  function select(next: number) {
    setPlaying(false);
    setSelected(next);
  }

  if (!graph || !events || !current)
    return (
      <div className="graph-empty">
        <Title order={4}>{heading}</Title>
        <Text size="sm" c="dimmed">
          Graph events unavailable. The stored records are shown below.
        </Text>
      </div>
    );

  const known = supportedNodes[graph.graph_version] ?? [];
  const visited = new Set(events.map((event) => event.node_id));
  const skipped = known.filter((node) => !visited.has(node));

  return (
    <div className="graph-explorer">
      <Group justify="space-between" gap="xs">
        <Title order={4}>{heading}</Title>
        <Badge variant="light" color="gray" tt="none">
          {graph.graph_version}
        </Badge>
      </Group>
      <div className="graph-toolbar">
        <Text size="xs" fw={700} className="step-count">
          Step {index + 1} of {count}
        </Text>
        <Group gap={5} wrap="nowrap">
          <Button
            size="compact-sm"
            variant="default"
            aria-label="Previous graph step"
            disabled={index === 0}
            onClick={() => select(index - 1)}
          >
            <span aria-hidden="true">←</span>
          </Button>
          <Button
            size="compact-sm"
            variant="light"
            disabled={count < 2}
            onClick={() => {
              if (!replaying && atEnd) setSelected(0);
              setPlaying(!replaying);
            }}
          >
            {replaying ? "Pause" : "Replay"}
          </Button>
          <Button
            size="compact-sm"
            variant="default"
            aria-label="Next graph step"
            disabled={atEnd}
            onClick={() => select(index + 1)}
          >
            <span aria-hidden="true">→</span>
          </Button>
        </Group>
      </div>
      <ol aria-label={heading + " path"} className="graph-track" ref={track}>
        {events.map((event, i) => (
          <li key={event.seq} data-past={i < index || undefined}>
            <button
              type="button"
              className="graph-step"
              aria-current={i === index ? "step" : undefined}
              data-tone={eventTone(event.outcome_code)}
              onClick={() => select(i)}
            >
              <span className="step-index">{i + 1}</span>
              <strong>{nodeLabel(event.node_id)}</strong>
              <span className="step-outcome">{human(event.outcome_code)}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="step-inspector">
        <div aria-live={replaying ? "off" : "polite"}>
          <div className="step-meta">
            <span>
              Step {index + 1} / {count}
            </span>
            <span>+{current.elapsed_ms} ms</span>
          </div>
          <Group gap="xs" mt={4}>
            <Text fw={750}>{nodeLabel(current.node_id)}</Text>
            <span
              className="outcome-pill"
              data-tone={eventTone(current.outcome_code)}
            >
              {human(current.outcome_code)}
            </span>
          </Group>
          <Text size="xs" c="dimmed" className="wrap">
            {current.edge_id.split("_to_").map(nodeLabel).join(" → ")}
            {atEnd ? " · End of recorded path" : ""}
          </Text>
        </div>
        {evidenceSeq != null && (
          <div className="step-evidence" key={evidenceSeq}>
            {inspectEvidence?.(evidenceSeq)}
            {evidence?.(evidenceSeq)}
          </div>
        )}
        {current.node_id === "validate" && proposal}
      </div>
      {skipped.length > 0 && (
        <Text size="xs" c="dimmed" mt="xs">
          Skipped on this path · {skipped.map(nodeLabel).join(", ")}
        </Text>
      )}
      <details className="graph-order">
        <summary>Ordered graph events</summary>
        <ol className="event-list">
          {events.map((event) => (
            <li key={event.seq}>
              <Text size="sm">
                <strong>{nodeLabel(event.node_id)}</strong> ·{" "}
                {human(event.outcome_code)} · +{event.elapsed_ms} ms
              </Text>
              <Text size="xs" c="dimmed" className="wrap">
                Edge {event.edge_id}
              </Text>
              {event.evidence_seq !== null && evidence?.(event.evidence_seq)}
              {event.node_id === "validate" && proposal}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
