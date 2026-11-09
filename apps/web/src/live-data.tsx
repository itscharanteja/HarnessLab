"use client";

import {
  Badge,
  Card,
  Code,
  Divider,
  Grid,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import type {
  Finding,
  Scalar,
  TraceEvent,
  WorkerAnswer,
} from "@harnesslab/schemas/types";
import { human } from "./presentation";

export interface SqlQueryStep {
  kind: "sql_query";
  seq: number;
  sql: string;
  status: "ok" | "error" | "timeout";
  cumulative_ms: number;
  duration_ms: number;
  columns?: { name: string; type: string }[];
  rows?: Scalar[][];
  error?: string;
}

export interface FinalOutputStep {
  kind: "final_output";
  seq: number;
  answer: WorkerAnswer;
  cumulative_ms: number;
}

export interface NonQueryLogStep {
  kind: "non_query_log";
  seq: number;
  eventKind: TraceEvent["kind"];
  actionName: string;
  summary: string;
  status: "ok" | "warning" | "error" | "denied";
  cumulative_ms: number;
  rawPayload: unknown;
  autoElevate: boolean;
}

export type ExecutionStep = SqlQueryStep | FinalOutputStep | NonQueryLogStep;

function isOutcomeFailure(code?: string): boolean {
  if (!code) return false;
  return ![
    "ok",
    "success",
    "started",
    "requested",
    "answered",
    "clarified",
    "passed",
    "schema_preflight",
    "recovered",
  ].includes(code);
}

export function extractInvestigationSteps(
  items: TraceEvent[],
): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  let pendingSql: { seq: number; sql: string; elapsed_ms: number } | null =
    null;

  for (const item of items) {
    if (item.kind === "tool_request") {
      if (item.payload.call.name === "execute_readonly_sql") {
        if (pendingSql) {
          steps.push({
            kind: "sql_query",
            seq: pendingSql.seq,
            sql: pendingSql.sql,
            status: "error",
            cumulative_ms: pendingSql.elapsed_ms,
            duration_ms: 0,
            error: "aborted_or_incomplete",
          });
        }
        pendingSql = {
          seq: item.seq,
          sql: item.payload.call.arguments.sql,
          elapsed_ms: item.elapsed_ms,
        };
      } else {
        const call = item.payload.call;
        let summary = "";
        if (call.name === "list_tables") {
          summary = "list all tables";
        } else if (call.name === "describe_schema") {
          summary = `tables: [${call.arguments.tables?.join(", ") || ""}]`;
        } else if (call.name === "get_business_definition") {
          summary = `metric: ${call.arguments.metric_id}`;
        } else if (call.name === "validate_calculation") {
          const ops =
            call.arguments.operands
              ?.map((o) =>
                o.source.kind === "cell"
                  ? `${o.source.query_id}[${o.source.row},${o.source.column}]`
                  : o.source.calculation_id,
              )
              .join(", ") || "";
          summary = `calc: ${call.arguments.operation} on [${ops}]`;
        } else if (call.name === "inspect_query_error") {
          summary = `error_id: ${call.arguments.error_id}`;
        } else {
          summary = "tool request";
        }

        const isError = isOutcomeFailure(item.outcome_code);
        steps.push({
          kind: "non_query_log",
          seq: item.seq,
          eventKind: item.kind,
          actionName: call.name,
          summary,
          status: isError ? "error" : "ok",
          cumulative_ms: item.elapsed_ms,
          rawPayload: item.payload,
          autoElevate: isError,
        });
      }
    } else if (item.kind === "tool_result") {
      const payload = item.payload;
      if (payload.name === "execute_readonly_sql") {
        const seq = pendingSql?.seq ?? item.seq;
        const sql = pendingSql?.sql ?? "-- SQL query unavailable";
        const duration_ms = pendingSql
          ? Math.max(0, item.elapsed_ms - pendingSql.elapsed_ms)
          : 0;
        const cumulative_ms = pendingSql?.elapsed_ms ?? item.elapsed_ms;

        if (payload.status === "ok") {
          steps.push({
            kind: "sql_query",
            seq,
            sql,
            status: "ok",
            cumulative_ms,
            duration_ms,
            columns: payload.data.columns,
            rows: payload.data.rows,
          });
        } else {
          steps.push({
            kind: "sql_query",
            seq,
            sql,
            status: payload.code === "timeout" ? "timeout" : "error",
            cumulative_ms,
            duration_ms,
            error: payload.code,
          });
        }
        pendingSql = null;
      } else {
        let summary = "";
        let status: "ok" | "warning" | "error" | "denied" = "ok";
        let autoElevate = false;

        if (payload.status === "ok") {
          if (payload.name === "list_tables") {
            summary = `${payload.data.tables.length} tables found`;
          } else if (payload.name === "describe_schema") {
            summary = `${payload.data.tables.length} tables inspected (${payload.data.tables.map((t) => t.name).join(", ")})`;
          } else if (payload.name === "get_business_definition") {
            const defSnippet =
              payload.data.definition.length > 60
                ? payload.data.definition.slice(0, 60) + "..."
                : payload.data.definition;
            summary = `${payload.data.metric_id}: ${defSnippet}`;
          } else if (payload.name === "validate_calculation") {
            summary = `calc_id: ${payload.data.calculation_id} = ${payload.data.value}`;
          } else if (payload.name === "inspect_query_error") {
            summary = `hint: ${payload.data.hint.slice(0, 60)}`;
          } else {
            summary = "tool result success";
          }
          if (isOutcomeFailure(item.outcome_code)) {
            status = "error";
            autoElevate = true;
          }
        } else {
          status = "error";
          autoElevate = true;
          summary = `${payload.name} failed: ${payload.code}`;
        }

        steps.push({
          kind: "non_query_log",
          seq: item.seq,
          eventKind: item.kind,
          actionName: payload.name,
          summary,
          status,
          cumulative_ms: item.elapsed_ms,
          rawPayload: item.payload,
          autoElevate,
        });
      }
    } else if (item.kind === "final_output") {
      steps.push({
        kind: "final_output",
        seq: item.seq,
        answer: item.payload,
        cumulative_ms: item.elapsed_ms,
      });
    } else if (item.kind === "start") {
      const isError = isOutcomeFailure(item.outcome_code);
      steps.push({
        kind: "non_query_log",
        seq: item.seq,
        eventKind: item.kind,
        actionName: "start",
        summary: `task: ${item.payload.task_key}`,
        status: isError ? "error" : "ok",
        cumulative_ms: item.elapsed_ms,
        rawPayload: item.payload,
        autoElevate: isError,
      });
    } else if (item.kind === "model_usage") {
      const isError = isOutcomeFailure(item.outcome_code);
      steps.push({
        kind: "non_query_log",
        seq: item.seq,
        eventKind: item.kind,
        actionName: "model_usage",
        summary: `${item.payload.input_tokens.toLocaleString()} in / ${item.payload.output_tokens.toLocaleString()} out tokens`,
        status: isError ? "error" : "ok",
        cumulative_ms: item.elapsed_ms,
        rawPayload: item.payload,
        autoElevate: isError,
      });
    } else if (item.kind === "policy_decision") {
      const denied =
        item.payload.safety_violation || isOutcomeFailure(item.outcome_code);
      const summary = `reason: ${item.payload.reason}${item.payload.safety_violation ? " (safety violation)" : ""}`;
      steps.push({
        kind: "non_query_log",
        seq: item.seq,
        eventKind: item.kind,
        actionName: "policy_decision",
        summary,
        status: denied ? "denied" : "ok",
        cumulative_ms: item.elapsed_ms,
        rawPayload: item.payload,
        autoElevate: Boolean(denied),
      });
    } else if (item.kind === "fault") {
      steps.push({
        kind: "non_query_log",
        seq: item.seq,
        eventKind: item.kind,
        actionName: "fault",
        summary: `fault injected: ${item.payload.tool} (${item.payload.kind})`,
        status: "warning",
        cumulative_ms: item.elapsed_ms,
        rawPayload: item.payload,
        autoElevate: true,
      });
    } else if (item.kind === "recovery") {
      const isError = isOutcomeFailure(item.outcome_code);
      steps.push({
        kind: "non_query_log",
        seq: item.seq,
        eventKind: item.kind,
        actionName: "recovery",
        summary: `recovered from ${item.payload.error_id} on ${item.payload.tool}`,
        status: isError ? "error" : "ok",
        cumulative_ms: item.elapsed_ms,
        rawPayload: item.payload,
        autoElevate: isError,
      });
    } else if (item.kind === "grade") {
      const isError =
        !item.payload.success || isOutcomeFailure(item.outcome_code);
      steps.push({
        kind: "non_query_log",
        seq: item.seq,
        eventKind: item.kind,
        actionName: "grade",
        summary: `success: ${item.payload.success}${item.payload.reasons?.length ? ` (${item.payload.reasons.join(", ")})` : ""}`,
        status: isError ? "warning" : "ok",
        cumulative_ms: item.elapsed_ms,
        rawPayload: item.payload,
        autoElevate: isError,
      });
    }
  }

  if (pendingSql) {
    steps.push({
      kind: "sql_query",
      seq: pendingSql.seq,
      sql: pendingSql.sql,
      status: "error",
      cumulative_ms: pendingSql.elapsed_ms,
      duration_ms: 0,
      error: "incomplete_request",
    });
  }

  return steps;
}

export function computeDivergenceStep(
  baseItems?: TraceEvent[] | null,
  candItems?: TraceEvent[] | null,
): { baseSeq?: number; candSeq?: number } | null {
  if (
    !baseItems ||
    !candItems ||
    baseItems.length === 0 ||
    candItems.length === 0
  ) {
    return null;
  }
  const baseSteps = extractInvestigationSteps(baseItems);
  const candSteps = extractInvestigationSteps(candItems);
  const maxLen = Math.max(baseSteps.length, candSteps.length);

  for (let i = 0; i < maxLen; i++) {
    const b = baseSteps[i];
    const c = candSteps[i];
    if (!b || !c) {
      return { baseSeq: b?.seq, candSeq: c?.seq };
    }
    if (b.kind !== c.kind) {
      return { baseSeq: b.seq, candSeq: c.seq };
    }
    if (b.kind === "sql_query" && c.kind === "sql_query") {
      if (b.sql.trim() !== c.sql.trim() || b.status !== c.status) {
        return { baseSeq: b.seq, candSeq: c.seq };
      }
    } else if (b.kind === "final_output" && c.kind === "final_output") {
      if (JSON.stringify(b.answer) !== JSON.stringify(c.answer)) {
        return { baseSeq: b.seq, candSeq: c.seq };
      }
    } else if (b.kind === "non_query_log" && c.kind === "non_query_log") {
      if (
        b.eventKind !== c.eventKind ||
        b.actionName !== c.actionName ||
        b.status !== c.status
      ) {
        return { baseSeq: b.seq, candSeq: c.seq };
      }
    }
  }
  return null;
}

export interface SqlExecution {
  seq: number;
  sql: string;
  status: "ok" | "error" | "timeout";
  elapsed_ms?: number;
  columns?: { name: string; type: string }[];
  rows?: Scalar[][];
  error?: string;
}

export interface DiscoveredSchema {
  tables: string[];
  inspected: {
    table: string;
    columns: { name: string; type: string; nullable?: boolean }[];
  }[];
}

export interface LiveOutputData {
  sqlExecutions: SqlExecution[];
  schema: DiscoveredSchema;
  findings: Finding[];
  clarification?: { question: string; missing_fields: string[] };
  unableReason?: string;
  totalTokens: { input: number; output: number };
  totalDurationMs: number;
  finalOutcome?: string;
  primaryValue?: { key: string; value: string; unit?: string };
}

export function extractLiveData(items: TraceEvent[]): LiveOutputData {
  const sqlExecutions: SqlExecution[] = [];
  const schema: DiscoveredSchema = { tables: [], inspected: [] };
  let findings: Finding[] = [];
  let clarification: { question: string; missing_fields: string[] } | undefined;
  let unableReason: string | undefined;
  let finalOutcome: string | undefined;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationMs = 0;

  // Track pending SQL request to pair with its result
  let pendingSql: { seq: number; sql: string; elapsed_ms: number } | null =
    null;

  for (const item of items) {
    if (item.elapsed_ms > totalDurationMs) {
      totalDurationMs = item.elapsed_ms;
    }
    if (item.outcome_code && item.outcome_code !== "success") {
      finalOutcome = item.outcome_code;
    }

    if (item.kind === "model_usage") {
      totalInputTokens += item.payload.input_tokens;
      totalOutputTokens += item.payload.output_tokens;
    } else if (item.kind === "tool_request") {
      if (item.payload.call.name === "execute_readonly_sql") {
        pendingSql = {
          seq: item.seq,
          sql: item.payload.call.arguments.sql,
          elapsed_ms: item.elapsed_ms,
        };
      }
    } else if (item.kind === "tool_result") {
      const payload = item.payload;
      if (payload.name === "execute_readonly_sql") {
        if (payload.status === "ok") {
          sqlExecutions.push({
            seq: pendingSql?.seq ?? item.seq,
            sql: pendingSql?.sql ?? "-- SQL query unavailable",
            status: "ok",
            elapsed_ms: item.elapsed_ms,
            columns: payload.data.columns,
            rows: payload.data.rows,
          });
        } else {
          sqlExecutions.push({
            seq: pendingSql?.seq ?? item.seq,
            sql: pendingSql?.sql ?? "-- SQL query unavailable",
            status: payload.code === "timeout" ? "timeout" : "error",
            elapsed_ms: item.elapsed_ms,
            error: payload.code,
          });
        }
        pendingSql = null;
      } else if (payload.name === "list_tables" && payload.status === "ok") {
        schema.tables = Array.from(
          new Set([...schema.tables, ...payload.data.tables]),
        );
      } else if (
        payload.name === "describe_schema" &&
        payload.status === "ok"
      ) {
        for (const t of payload.data.tables) {
          if (!schema.inspected.some((existing) => existing.table === t.name)) {
            schema.inspected.push({
              table: t.name,
              columns: t.columns.map((c) => ({
                name: c.name,
                type: c.type,
                nullable: c.nullable,
              })),
            });
          }
        }
      }
    } else if (item.kind === "final_output") {
      const answer = item.payload;
      if (answer.kind === "answer") {
        findings = answer.findings;
      } else if (answer.kind === "clarify") {
        clarification = {
          question: answer.question,
          missing_fields: answer.missing_fields,
        };
      } else if (answer.kind === "unable") {
        unableReason = answer.reason;
      }
    }
  }

  // Derive primary value if available
  let primaryValue: { key: string; value: string; unit?: string } | undefined;
  if (findings.length > 0) {
    const first = findings[0]!;
    primaryValue = {
      key: first.key,
      value: String(first.value),
      unit: first.unit,
    };
  } else if (sqlExecutions.length > 0) {
    // Pick the last successful query with rows
    for (let i = sqlExecutions.length - 1; i >= 0; i--) {
      const exec = sqlExecutions[i]!;
      if (exec.status === "ok" && exec.rows && exec.rows.length > 0) {
        const firstRow = exec.rows[0];
        const firstCol = exec.columns?.[0];
        if (firstRow && firstRow.length > 0) {
          primaryValue = {
            key: firstCol?.name ?? "Result",
            value: String(firstRow[0] ?? "null"),
            unit: firstCol?.type,
          };
          break;
        }
      }
    }
  }

  return {
    sqlExecutions,
    schema,
    findings,
    clarification,
    unableReason,
    totalTokens: { input: totalInputTokens, output: totalOutputTokens },
    totalDurationMs,
    finalOutcome,
    primaryValue,
  };
}

export function LiveDataView({
  items,
  armLabel,
}: {
  items: TraceEvent[];
  armLabel?: string;
}) {
  const data = extractLiveData(items);

  return (
    <Stack gap="md" mt="xs">
      {/* 1. Primary Highlight Metric if available */}
      {data.primaryValue && (
        <Card
          padding="md"
          radius="md"
          withBorder
          bg="var(--mantine-color-teal-0)"
          style={{ borderColor: "var(--mantine-color-teal-3)" }}
        >
          <Group justify="space-between" align="flex-start">
            <div>
              <Text size="xs" fw={700} c="teal.9" tt="uppercase" lts="0.05em">
                🎯{" "}
                {data.findings.length > 0
                  ? "Final Business Answer"
                  : "Live PostgreSQL Query Result"}
              </Text>
              <Group gap="xs" mt={4} align="baseline">
                <Text fw={900} size="2.2rem" c="teal.9" lh={1.1}>
                  {data.primaryValue.value}
                </Text>
                {data.primaryValue.unit && (
                  <Badge variant="light" color="teal" size="sm">
                    {data.primaryValue.unit}
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed" mt={4}>
                Field: <Code fw={700}>{data.primaryValue.key}</Code>
                {data.findings.length > 0
                  ? " · Synthesized & verified with evidence citations"
                  : " · Directly fetched from live PostgreSQL database"}
              </Text>
            </div>
            <Badge color="green" variant="filled">
              {armLabel ? `${armLabel} Output` : "Verified Data"}
            </Badge>
          </Group>
        </Card>
      )}

      {/* 2. Structured Findings list (if multiple) */}
      {data.findings.length > 1 && (
        <Card padding="sm" radius="md" withBorder>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb="xs">
            📋 All Verified Findings ({data.findings.length})
          </Text>
          <Table striped highlightOnHover withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Metric / Key</Table.Th>
                <Table.Th>Value</Table.Th>
                <Table.Th>Unit</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.findings.map((f, idx) => (
                <Table.Tr key={idx}>
                  <Table.Td fw={600}>{f.key}</Table.Td>
                  <Table.Td fw={700} c="teal.8">
                    {String(f.value)}
                  </Table.Td>
                  <Table.Td>{f.unit}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      {/* Clarification or Unable */}
      {data.clarification && (
        <Card
          padding="md"
          radius="md"
          withBorder
          bg="var(--mantine-color-blue-0)"
        >
          <Text size="xs" fw={700} c="blue.9" tt="uppercase">
            💬 Focused Clarification Question
          </Text>
          <Text size="sm" fw={600} mt={4}>
            {data.clarification.question}
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            Missing fields: {data.clarification.missing_fields.join(", ")}
          </Text>
        </Card>
      )}

      {data.unableReason && (
        <Card
          padding="md"
          radius="md"
          withBorder
          bg="var(--mantine-color-yellow-0)"
        >
          <Text size="xs" fw={700} c="yellow.9" tt="uppercase">
            ⚠️ AI Investigation Unable to Complete
          </Text>
          <Text size="sm" mt={4}>
            Reason: {human(data.unableReason)}
          </Text>
        </Card>
      )}

      {/* 3. Executed SQL Queries & Returned Data Tables */}
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={5}>
            ⚡ PostgreSQL Queries & Tables ({data.sqlExecutions.length})
          </Title>
          <Badge variant="outline" color="gray" size="xs">
            Read-Only Sandbox
          </Badge>
        </Group>

        {data.sqlExecutions.length === 0 ? (
          <Paper p="sm" withBorder bg="gray.0" radius="md">
            <Text size="xs" c="dimmed">
              No SQL queries were executed in this run (schema discovery or turn
              limit reached before query).
            </Text>
          </Paper>
        ) : (
          data.sqlExecutions.map((exec, idx) => (
            <Card key={idx} padding="sm" radius="md" withBorder>
              <Group justify="space-between" mb="xs">
                <Group gap="xs">
                  <Badge
                    size="xs"
                    color={
                      exec.status === "ok"
                        ? "green"
                        : exec.status === "timeout"
                          ? "orange"
                          : "red"
                    }
                  >
                    Query #{idx + 1} · {exec.status.toUpperCase()}
                  </Badge>
                  {exec.elapsed_ms && (
                    <Text size="xs" c="dimmed">
                      +{exec.elapsed_ms} ms
                    </Text>
                  )}
                </Group>
                {exec.rows && (
                  <Badge variant="light" size="xs">
                    {exec.rows.length} row{exec.rows.length === 1 ? "" : "s"}{" "}
                    returned
                  </Badge>
                )}
              </Group>

              {/* Executed SQL statement */}
              <Code
                block
                style={{
                  background: "#1e293b",
                  color: "#e2e8f0",
                  padding: "10px",
                  borderRadius: "6px",
                  fontSize: "0.82rem",
                  fontFamily: "var(--mantine-font-family-monospace)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {exec.sql.trim()}
              </Code>

              {/* Data Table */}
              {exec.status === "ok" && exec.columns && exec.rows && (
                <Stack gap="xs" mt="sm">
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                    📊 Retrieved Database Rows:
                  </Text>
                  {exec.rows.length > 0 ? (
                    <div style={{ overflowX: "auto" }}>
                      <Table
                        striped
                        highlightOnHover
                        withTableBorder
                        withColumnBorders
                      >
                        <Table.Thead bg="gray.1">
                          <Table.Tr>
                            {exec.columns.map((col) => (
                              <Table.Th key={col.name}>
                                <Group gap={4} wrap="nowrap">
                                  <span>{col.name}</span>
                                  <Badge
                                    size="xs"
                                    variant="outline"
                                    color="gray"
                                  >
                                    {col.type}
                                  </Badge>
                                </Group>
                              </Table.Th>
                            ))}
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {exec.rows.map((row, rIdx) => (
                            <Table.Tr key={rIdx}>
                              {row.map((val, cIdx) => (
                                <Table.Td key={cIdx} fw={600}>
                                  {val === null ? (
                                    <Text size="xs" c="dimmed" fs="italic">
                                      null
                                    </Text>
                                  ) : typeof val === "boolean" ? (
                                    val ? (
                                      "true"
                                    ) : (
                                      "false"
                                    )
                                  ) : (
                                    String(val)
                                  )}
                                </Table.Td>
                              ))}
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </div>
                  ) : (
                    <Paper p="xs" bg="gray.0" withBorder radius="sm">
                      <Text size="xs" c="dimmed">
                        Query executed successfully and returned 0 rows.
                      </Text>
                    </Paper>
                  )}
                </Stack>
              )}

              {exec.status === "timeout" && (
                <Paper p="xs" mt="xs" bg="orange.0" withBorder radius="sm">
                  <Text size="xs" c="orange.9" fw={600}>
                    ⏱️ Database Timeout (Fault Injected by Benchmark to test
                    agent resilience)
                  </Text>
                </Paper>
              )}

              {exec.status === "error" && exec.error && (
                <Paper p="xs" mt="xs" bg="red.0" withBorder radius="sm">
                  <Text size="xs" c="red.9" fw={600}>
                    ⚠️ Database Query Error: {exec.error}
                  </Text>
                </Paper>
              )}
            </Card>
          ))
        )}
      </Stack>

      {/* 4. Schema Discovery Summary */}
      {(data.schema.tables.length > 0 || data.schema.inspected.length > 0) && (
        <Card padding="sm" radius="md" withBorder>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb="xs">
            🗄️ Database Context Discovered by Agent
          </Text>
          {data.schema.tables.length > 0 && (
            <Stack gap={4} mb="xs">
              <Text size="xs" fw={600}>
                Available Tables in PostgreSQL:
              </Text>
              <Group gap={6}>
                {data.schema.tables.map((t) => (
                  <Badge key={t} variant="dot" color="blue" size="sm">
                    {t}
                  </Badge>
                ))}
              </Group>
            </Stack>
          )}

          {data.schema.inspected.length > 0 && (
            <Stack gap={4}>
              <Text size="xs" fw={600}>
                Inspected Table Schemas:
              </Text>
              <Group gap={6}>
                {data.schema.inspected.map((t) => (
                  <Badge key={t.table} variant="light" color="cyan" size="sm">
                    {t.table} ({t.columns.length} columns)
                  </Badge>
                ))}
              </Group>
            </Stack>
          )}
        </Card>
      )}

      {/* 5. Efficiency Footprint */}
      <Card padding="xs" radius="md" withBorder bg="gray.0">
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            ⚡ <strong>AI Footprint:</strong>{" "}
            {data.totalTokens.input.toLocaleString()} input tokens ·{" "}
            {data.totalTokens.output.toLocaleString()} output tokens ·{" "}
            {data.totalDurationMs} ms total duration
          </Text>
          {data.finalOutcome && (
            <Badge size="xs" color="gray" variant="light">
              Outcome: {human(data.finalOutcome)}
            </Badge>
          )}
        </Group>
      </Card>
    </Stack>
  );
}

export function HeadToHeadOutputComparison({
  baselineItems,
  candidateItems,
  taskKey,
}: {
  baselineItems?: TraceEvent[] | null;
  candidateItems?: TraceEvent[] | null;
  taskKey?: string;
}) {
  const baseData = baselineItems ? extractLiveData(baselineItems) : null;
  const candData = candidateItems ? extractLiveData(candidateItems) : null;

  if (!baseData && !candData) return null;

  const baseVal = baseData?.primaryValue?.value ?? "—";
  const candVal = candData?.primaryValue?.value ?? "—";
  const isMatch = baseVal !== "—" && candVal !== "—" && baseVal === candVal;
  const candWon =
    candVal !== "—" &&
    (baseVal === "—" ||
      (candData?.findings.length ?? 0) > (baseData?.findings.length ?? 0));

  return (
    <Card
      padding="md"
      radius="md"
      withBorder
      mb="md"
      bg="linear-gradient(135deg, #ffffff 0%, #f0fdf9 100%)"
      style={{ border: "2px solid #087069" }}
    >
      <Group justify="space-between" mb="xs">
        <div>
          <Badge color="teal" variant="filled" size="sm">
            ⚡ LIVE HEAD-TO-HEAD OUTPUT COMPARISON
          </Badge>
          <Title order={4} mt={4}>
            {taskKey ? human(taskKey) : "Selected Scenario Output Comparison"}
          </Title>
        </div>
        {candWon ? (
          <Badge color="green" size="lg" variant="light">
            🚀 Candidate Outperformed Baseline
          </Badge>
        ) : isMatch ? (
          <Badge color="teal" size="lg" variant="light">
            🤝 Consistent Verified Answers
          </Badge>
        ) : null}
      </Group>

      <Grid mt="sm" gutter="md">
        {/* Baseline (Arm 01) */}
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card padding="sm" radius="md" withBorder bg="white">
            <Group justify="space-between" mb={4}>
              <Text size="xs" fw={700} c="dimmed">
                ARM 01 (BASELINE / OLD VERSION)
              </Text>
              <Badge size="xs" color="gray">
                Baseline
              </Badge>
            </Group>

            <Text size="xs" c="dimmed">
              Primary Value:
            </Text>
            <Text
              fw={800}
              size="1.8rem"
              c={baseVal !== "—" ? "dark.7" : "dimmed"}
            >
              {baseVal}
              {baseData?.primaryValue?.unit
                ? ` ${baseData.primaryValue.unit}`
                : ""}
            </Text>

            <Divider my="xs" />

            <Text size="xs" fw={600} c="dimmed">
              SQL Executed:
            </Text>
            {baseData?.sqlExecutions?.[0] ? (
              <Code
                block
                style={{
                  fontSize: "0.75rem",
                  maxHeight: "80px",
                  overflowY: "auto",
                  background: "#f8fafc",
                }}
              >
                {baseData.sqlExecutions[0].sql.trim()}
              </Code>
            ) : (
              <Text size="xs" c="dimmed" fs="italic">
                No SQL executed (stopped at limit/schema)
              </Text>
            )}

            <Group justify="space-between" mt="xs">
              <Text size="xs" c="dimmed">
                Tokens: {baseData?.totalTokens.input.toLocaleString()} in /{" "}
                {baseData?.totalTokens.output.toLocaleString()} out
              </Text>
              <Text size="xs" c="dimmed">
                {baseData?.sqlExecutions.length} queries ·{" "}
                {baseData?.totalDurationMs} ms
              </Text>
            </Group>
          </Card>
        </Grid.Col>

        {/* Candidate (Arm 02) */}
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Card
            padding="sm"
            radius="md"
            withBorder
            bg="white"
            style={{
              borderColor: candWon ? "var(--mantine-color-green-5)" : undefined,
            }}
          >
            <Group justify="space-between" mb={4}>
              <Text size="xs" fw={700} c="indigo.8">
                ARM 02 (CANDIDATE / NEW VERSION)
              </Text>
              <Badge size="xs" color="indigo">
                Candidate
              </Badge>
            </Group>

            <Text size="xs" c="dimmed">
              Primary Value:
            </Text>
            <Text fw={800} size="1.8rem" c="teal.9">
              {candVal}
              {candData?.primaryValue?.unit
                ? ` ${candData.primaryValue.unit}`
                : ""}
            </Text>

            <Divider my="xs" />

            <Text size="xs" fw={600} c="dimmed">
              SQL Executed:
            </Text>
            {candData?.sqlExecutions?.[0] ? (
              <Code
                block
                style={{
                  fontSize: "0.75rem",
                  maxHeight: "80px",
                  overflowY: "auto",
                  background: "#f0fdf4",
                  color: "#166534",
                }}
              >
                {candData.sqlExecutions[0].sql.trim()}
              </Code>
            ) : (
              <Text size="xs" c="dimmed" fs="italic">
                No SQL executed
              </Text>
            )}

            <Group justify="space-between" mt="xs">
              <Text size="xs" c="dimmed">
                Tokens: {candData?.totalTokens.input.toLocaleString()} in /{" "}
                {candData?.totalTokens.output.toLocaleString()} out
              </Text>
              <Text size="xs" c="dimmed">
                {candData?.sqlExecutions.length} queries ·{" "}
                {candData?.totalDurationMs} ms
              </Text>
            </Group>
          </Card>
        </Grid.Col>
      </Grid>
    </Card>
  );
}
