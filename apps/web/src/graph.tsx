import { Badge, Group, Text, Title } from "@mantine/core";
import type { GraphProjection } from "@harnesslab/schemas/types";
import type { ReactNode } from "react";
import { human } from "./presentation";

const supportedNodes: Record<string, string[]> = {
  worker_v1: ["model_turn", "route_action", "dispatch"],
  optimizer_v1: ["suggest", "validate", "finish"],
};

export function Graph({
  graph,
  kind,
  evidence,
  proposal,
}: {
  graph: GraphProjection | null | undefined;
  kind: "Worker" | "Optimizer";
  evidence?: (seq: number) => ReactNode;
  proposal?: ReactNode;
}) {
  const heading = kind + " Graph";
  if (!graph?.events.length)
    return (
      <div>
        <Title order={4}>{heading}</Title>
        <Text size="sm" c="dimmed">
          Graph events unavailable. The stored records are shown below.
        </Text>
      </div>
    );
  const known = supportedNodes[graph.graph_version] ?? [];
  const visited = new Set(graph.events.map((event) => event.node_id));
  return (
    <div>
      <Group justify="space-between">
        <Title order={4}>{heading}</Title>
        <Badge variant="outline">{graph.graph_version}</Badge>
      </Group>
      <ol aria-label={heading + " path"} className="graph-flow">
        {graph.events.map((event) => (
          <li key={event.seq}>
            <span className="graph-node">{human(event.node_id)}</span>
          </li>
        ))}
      </ol>
      {known.some((node) => !visited.has(node)) && (
        <Text size="xs" c="dimmed">
          Skipped on this path ·{" "}
          {known
            .filter((node) => !visited.has(node))
            .map(human)
            .join(", ")}
        </Text>
      )}
      <details>
        <summary>Ordered graph events</summary>
        <ol className="event-list">
          {graph.events.map((event, i) => (
            <li key={event.seq}>
              <Text size="sm">
                <strong>{human(event.node_id)}</strong> ·{" "}
                {human(event.outcome_code)} · +{event.elapsed_ms} ms
              </Text>
              <Text size="xs" c="dimmed">
                Edge {event.edge_id}
                {i === graph.events.length - 1 ? " · End of recorded path" : ""}
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
