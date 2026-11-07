"use client";

import { Anchor, Group, Stack, Tabs, Text, Title } from "@mantine/core";
import type {
  RunTracePage,
  TaskRunSummary,
  TraceEvent,
} from "@harnesslab/schemas/types";
import { useCallback, useEffect, useRef } from "react";
import { api } from "./api";
import { eventTone, Graph } from "./graph";
import { LiveDataView } from "./live-data";
import { human, Pending, Problem, Status } from "./presentation";
import { useToken, useViewMode } from "./shell";
import { useResource } from "./use-resource";

export async function loadTrace(id: string, token: string, signal: AbortSignal) {
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
  const viewMode = useViewMode();
  const isBusiness = viewMode === "business";

  const tool =
    event.kind === "tool_request"
      ? event.payload.call.name
      : event.kind === "tool_result" && event.payload.status === "ok"
        ? event.payload.name
        : undefined;

  let businessTitle = human(event.kind);
  if (isBusiness) {
    if (event.kind === "start") businessTitle = "🚀 AI Started Task Investigation";
    else if (event.kind === "model_usage") businessTitle = "⚡ Claude Generated Reasoning & Turn";
    else if (event.kind === "tool_request") {
      if (tool === "list_tables") businessTitle = "🔍 AI Discovered Available Database Tables";
      else if (tool === "describe_schema") businessTitle = "📋 AI Inspected Table Schema & Relations";
      else if (tool === "execute_readonly_sql") businessTitle = "📊 AI Executed Read-Only SQL Query";
      else if (tool === "get_business_definition") businessTitle = "📖 AI Looked Up Business Definition";
      else if (tool === "validate_calculation") businessTitle = "🔢 AI Validated Financial Calculation";
      else if (tool === "inspect_query_error") businessTitle = "⚠️ AI Analyzed Database Query Error";
      else businessTitle = `🛠️ Action: ${human(tool || "")}`;
    } else if (event.kind === "tool_result") {
      businessTitle = `✅ Data Retrieved from PostgreSQL`;
    } else if (event.kind === "policy_decision") {
      businessTitle = `🛡️ Enterprise Safety & Budget Guardrail`;
    }
  }

  return (
    <>
      <Group gap={6} align="baseline">
        <Text size="sm" fw={700}>
          {businessTitle}
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
        {tool && !isBusiness && " · " + human(tool)}
        {event.correlation_id && !isBusiness && " · " + event.correlation_id}
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
            <Tabs defaultValue="live-data" variant="outline" radius="md">
              <Tabs.List mb="xs">
                <Tabs.Tab value="live-data">📊 Live Output & Data</Tabs.Tab>
                <Tabs.Tab value="technical">⚙️ Technical Trace & Graph</Tabs.Tab>
              </Tabs.List>

              <Tabs.Panel value="live-data">
                <LiveDataView items={result.value.items} armLabel={label} />
              </Tabs.Panel>

              <Tabs.Panel value="technical">
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
                <Group justify="space-between" gap="xs" mt="sm">
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
              </Tabs.Panel>
            </Tabs>
          )}
        </Stack>
      )}
    </section>
  );
}
