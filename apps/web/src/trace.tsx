"use client";

import { Anchor, Group, Stack, Text, Title } from "@mantine/core";
import type {
  RunTracePage,
  TaskRunSummary,
  TraceEvent,
} from "@harnesslab/schemas/types";
import { useCallback, useEffect } from "react";
import { api } from "./api";
import { Graph } from "./graph";
import { human, Pending, Problem, Status } from "./presentation";
import { useToken } from "./shell";
import { useResource } from "./use-resource";

async function loadTrace(id: string, token: string, signal: AbortSignal) {
  const result = await api<RunTracePage>(
    `runs/${id}/trace?limit=100&graph=1`,
    token,
    { signal },
  );
  let cursor = result.next_cursor;
  const items = [...result.items];
  for (let page = 0; cursor && page < 12; page++) {
    const part = await api<RunTracePage>(
      `runs/${id}/trace?limit=100&cursor=${cursor}`,
      token,
      { signal },
    );
    items.push(...part.items);
    cursor = part.next_cursor;
  }
  return { ...result, items, next_cursor: cursor };
}

function EventBody({ event }: { event: TraceEvent }) {
  if (
    event.kind === "tool_request" &&
    event.payload.call.name === "execute_readonly_sql"
  )
    return <pre className="data-code">{event.payload.call.arguments.sql}</pre>;
  return (
    <details>
      <summary>
        {event.kind === "tool_result"
          ? "Tool result and evidence"
          : "Event details"}
      </summary>
      <pre className="data-code">{JSON.stringify(event.payload, null, 2)}</pre>
    </details>
  );
}

export function Trace({
  label,
  run,
  highlight,
}: {
  label: string;
  run?: TaskRunSummary;
  highlight?: number;
}) {
  const token = useToken();
  const id = run?.run_id ?? "";
  const load = useCallback(
    (signal: AbortSignal) =>
      id ? loadTrace(id, token, signal) : Promise.resolve(null),
    [id, token],
  );
  const result = useResource(id, load);
  useEffect(() => {
    if (highlight !== undefined && result.value)
      document
        .getElementById(`trace-${id}-${highlight}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [highlight, result.value, id]);
  return (
    <section className="panel" aria-label={label + " trace"}>
      <Title order={3} mb="sm">
        {label} trace
      </Title>
      {!run && (
        <Text size="sm" c="dimmed">
          This arm has no stored run for the selected cell.
        </Text>
      )}
      {run && (
        <Stack gap="sm">
          <Group>
            <Status status={run.result} />
            {run.grade && (
              <Status status={run.grade.success ? "passed" : "failed"} />
            )}
            <Text size="xs" c="dimmed">
              {human(run.stage)} · repeat {run.repeat}
            </Text>
          </Group>
          {run.grade?.reasons.length ? (
            <Text size="sm">{run.grade.reasons.map(human).join(" · ")}</Text>
          ) : null}
          {result.error && <Problem message={result.error} />}
          {!result.value && !result.error && <Pending label="Loading trace" />}
          {result.value && (
            <>
              <Graph
                kind="Worker"
                graph={result.value.worker_graph}
                evidence={(seq) => (
                  <Anchor href={`#trace-${id}-${seq}`}>
                    Trace event {seq}
                  </Anchor>
                )}
              />
              <Title order={4}>Recorded trace</Title>
              {!result.value.items.length && (
                <Text size="sm" c="dimmed">
                  This run has no recorded trace events.
                </Text>
              )}
              <ol className="event-list" aria-label={label + " trace events"}>
                {result.value.items.map((event) => (
                  <li
                    id={`trace-${id}-${event.seq}`}
                    key={event.seq}
                    data-highlight={highlight === event.seq}
                  >
                    <Text size="sm" fw={700}>
                      {event.seq} · {human(event.kind)} ·{" "}
                      {human(event.outcome_code)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      +{event.elapsed_ms} ms
                      {event.correlation_id ? " · " + event.correlation_id : ""}
                    </Text>
                    <EventBody event={event} />
                  </li>
                ))}
              </ol>
              {result.value.next_cursor && (
                <Text size="sm">
                  Additional events are available through the run trace API.
                </Text>
              )}
            </>
          )}
        </Stack>
      )}
    </section>
  );
}
