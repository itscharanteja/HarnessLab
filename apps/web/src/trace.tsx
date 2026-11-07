"use client";

import { Anchor, Group, Stack, Text, Title } from "@mantine/core";
import type {
  RunTracePage,
  TaskRunSummary,
  TraceEvent,
} from "@harnesslab/schemas/types";
import { useCallback, useEffect, useRef } from "react";
import { api } from "./api";
import { eventTone, Graph } from "./graph";
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
  const sql =
    event.kind === "tool_request" &&
    event.payload.call.name === "execute_readonly_sql"
      ? event.payload.call.arguments.sql
      : null;
  return (
    <details>
      <summary>
        {sql !== null
          ? "SQL query"
          : event.kind === "tool_result"
            ? "Tool result and evidence"
            : "Event details"}
      </summary>
      <pre className="data-code">
        {sql ?? JSON.stringify(event.payload, null, 2)}
      </pre>
    </details>
  );
}

function EventSummary({ event }: { event: TraceEvent }) {
  const tool =
    event.kind === "tool_request"
      ? event.payload.call.name
      : event.kind === "tool_result" && event.payload.status === "ok"
        ? event.payload.name
        : undefined;
  return (
    <>
      <Group gap={6} align="baseline">
        <Text size="sm" fw={700}>
          {human(event.kind)}
        </Text>
        <span
          className="outcome-pill"
          data-tone={eventTone(event.outcome_code)}
        >
          {human(event.outcome_code)}
        </span>
      </Group>
      <Text size="xs" c="dimmed" className="wrap">
        +{event.elapsed_ms} ms
        {tool && " · " + human(tool)}
        {event.correlation_id && " · " + event.correlation_id}
      </Text>
      <EventBody event={event} />
    </>
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
  const log = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const target = document.getElementById(`trace-${id}-${highlight}`);
    if (target && log.current) log.current.scrollTop = target.offsetTop;
  }, [highlight, result.value, id]);
  return (
    <section
      className="panel trace-panel"
      data-arm={label.toLowerCase()}
      aria-label={label + " trace"}
    >
      <div className="trace-header">
        <span className="eyebrow">
          {label === "Baseline" ? "Arm 01" : "Arm 02"}
        </span>
        <Title order={3}>{label} trace</Title>
      </div>
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
                key={`${id}/${highlight ?? ""}`}
                kind="Worker"
                graph={result.value.worker_graph}
                initialEvidence={highlight}
                evidence={(seq) => (
                  <Anchor size="xs" href={`#trace-${id}-${seq}`}>
                    Trace event {seq}
                  </Anchor>
                )}
                inspectEvidence={(seq) => {
                  const event = result.value?.items.find(
                    (row) => row.seq === seq,
                  );
                  return event && <EventSummary event={event} />;
                }}
              />
              <Group justify="space-between" gap="xs">
                <Title order={4}>Recorded trace</Title>
                <Text size="xs" c="dimmed">
                  {result.value.items.length} events
                </Text>
              </Group>
              {!result.value.items.length && (
                <Text size="sm" c="dimmed">
                  This run has no recorded trace events.
                </Text>
              )}
              <ol
                ref={log}
                className="event-list trace-log"
                aria-label={label + " trace events"}
              >
                {result.value.items.map((event) => (
                  <li
                    id={`trace-${id}-${event.seq}`}
                    key={event.seq}
                    data-highlight={highlight === event.seq}
                  >
                    <span className="trace-sequence">#{event.seq}</span>
                    <div>
                      <EventSummary event={event} />
                    </div>
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
