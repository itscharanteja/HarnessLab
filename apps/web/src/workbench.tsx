"use client";

import {
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import type { TraceEvent } from "@harnesslab/schemas/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type FinalOutputStep,
  type NonQueryLogStep,
  type SqlQueryStep,
  extractInvestigationSteps,
} from "./live-data";
import { human } from "./presentation";

function getCategoryIcon(eventKind: string, actionName: string): string {
  if (actionName === "list_tables" || actionName === "describe_schema")
    return "📋";
  if (eventKind === "model_usage") return "⚡";
  if (actionName === "validate_calculation") return "🔢";
  if (eventKind === "policy_decision") return "🛡️";
  if (
    eventKind === "fault" ||
    eventKind === "recovery" ||
    actionName === "inspect_query_error"
  )
    return "⚠️";
  if (eventKind === "start") return "🚀";
  if (eventKind === "grade") return "🎯";
  return "⚙️";
}

export interface WorkbenchControlsProps {
  sqlOnly: boolean;
  onToggleSqlOnly: (value: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  sqlCount?: number;
  totalSteps?: number;
  divergenceSeq?: number;
  onNavigateSql?: (direction: "next" | "prev") => void;
  onCopyCurrentSql?: () => void;
}

export function WorkbenchControls({
  sqlOnly,
  onToggleSqlOnly,
  onExpandAll,
  onCollapseAll,
  sqlCount = 0,
  totalSteps = 0,
  divergenceSeq,
  onNavigateSql,
  onCopyCurrentSql,
}: WorkbenchControlsProps) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        onToggleSqlOnly(!sqlOnly);
      } else if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        onNavigateSql?.("next");
      } else if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        onNavigateSql?.("prev");
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        onCopyCurrentSql?.();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [sqlOnly, onToggleSqlOnly, onNavigateSql, onCopyCurrentSql]);

  return (
    <div className="workbench-toolbar">
      <Group gap="xs" wrap="wrap">
        <Button
          size="xs"
          variant={sqlOnly ? "filled" : "light"}
          color={sqlOnly ? "teal" : "gray"}
          onClick={() => onToggleSqlOnly(!sqlOnly)}
        >
          🔍 SQL Only ({sqlCount})
        </Button>
        <Button size="xs" variant="subtle" color="gray" onClick={onExpandAll}>
          Expand All Logs
        </Button>
        <Button size="xs" variant="subtle" color="gray" onClick={onCollapseAll}>
          Collapse All Logs
        </Button>
        {divergenceSeq !== undefined && (
          <Badge
            color="orange"
            variant="filled"
            size="sm"
            className="divergence-badge"
          >
            ⚡ Divergence Point: Step #{divergenceSeq}
          </Badge>
        )}
      </Group>
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          {sqlCount} Queries · {totalSteps} Total Steps
        </Text>
        <Text size="xs" c="dimmed" className="hotkeys-hint">
          [S] SQL Only · [J/K] Navigate · [C] Copy
        </Text>
      </Group>
    </div>
  );
}

export function SqlExecutionCard({
  step,
  index,
  totalQueries,
  runId,
  isActive,
  divergenceSeq,
}: {
  step: SqlQueryStep;
  index: number;
  totalQueries: number;
  runId: string;
  isActive?: boolean;
  divergenceSeq?: number;
}) {
  return (
    <div
      id={`sql-card-${runId}-${step.seq}`}
      data-sql-card="true"
      data-active={isActive ? "true" : undefined}
      className="sql-card"
      style={{ padding: 12 }}
    >
      <Group justify="space-between" mb={8} wrap="wrap">
        <Group gap="xs">
          {divergenceSeq === step.seq && (
            <Badge
              color="orange"
              variant="filled"
              size="sm"
              className="divergence-badge"
            >
              ⚡ Divergence Point: Step #{step.seq}
            </Badge>
          )}
          <Badge size="sm" variant="filled" color="dark">
            Query #{index + 1} of {totalQueries}
          </Badge>
          <Text size="xs" c="dimmed">
            Duration:{" "}
            <strong style={{ color: "var(--ink)" }}>
              {step.duration_ms} ms
            </strong>{" "}
            · +{step.cumulative_ms} ms offset
          </Text>
        </Group>
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {step.rows ? step.rows.length : 0} rows returned
          </Text>
          {step.status === "ok" ? (
            <Badge color="teal" variant="light" size="sm">
              200 OK
            </Badge>
          ) : step.status === "timeout" ? (
            <Badge color="yellow" variant="light" size="sm">
              TIMEOUT
            </Badge>
          ) : (
            <Badge color="red" variant="filled" size="sm">
              {step.error ?? "ERROR"}
            </Badge>
          )}
        </Group>
      </Group>

      {/* SQL Code Block with Copy Button */}
      <div style={{ position: "relative", marginBottom: 8 }}>
        <Group
          justify="space-between"
          px={8}
          py={4}
          bg="#1e293b"
          style={{ borderTopLeftRadius: 6, borderTopRightRadius: 6 }}
        >
          <Text size="11px" fw={600} c="#94a3b8">
            PostgreSQL (Read-Only AST)
          </Text>
          <CopyButton value={step.sql}>
            {({ copied, copy }) => (
              <Button
                size="compact-xs"
                variant="subtle"
                color={copied ? "teal" : "gray"}
                onClick={copy}
              >
                {copied ? "✓ Copied" : "📋 Copy SQL"}
              </Button>
            )}
          </CopyButton>
        </Group>
        <pre
          className="data-code"
          style={{
            margin: 0,
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            maxHeight: 180,
            overflowY: "auto",
            background: "#0f172a",
            color: "#f8fafc",
          }}
        >
          {step.sql}
        </pre>
      </div>

      {/* Tabular Data Grid */}
      {step.status === "ok" ? (
        !step.rows || step.rows.length === 0 ? (
          <Paper p="xs" bg="#f8fafc" radius="sm" withBorder>
            <Text size="xs" c="dimmed" fs="italic">
              Empty result set (0 rows)
            </Text>
          </Paper>
        ) : (
          <div className="table-scroll-container">
            <Table striped highlightOnHover withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  {step.columns?.map((col, cIdx) => (
                    <Table.Th key={cIdx} style={{ padding: "6px 10px" }}>
                      <Group gap={4} wrap="nowrap">
                        <Text size="xs" fw={700}>
                          {col.name}
                        </Text>
                        <Badge
                          size="xs"
                          variant="outline"
                          color="gray"
                          style={{ fontSize: "9px" }}
                        >
                          {col.type}
                        </Badge>
                      </Group>
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {step.rows.slice(0, 100).map((row, rIdx) => (
                  <Table.Tr key={rIdx}>
                    {row.map((cell, cIdx) => (
                      <Table.Td
                        key={cIdx}
                        style={{ padding: "4px 10px", fontSize: "0.75rem" }}
                      >
                        {cell === null || cell === undefined ? (
                          <Badge size="xs" variant="light" color="gray">
                            NULL
                          </Badge>
                        ) : (
                          <Text
                            size="xs"
                            span
                            style={{ fontFamily: "monospace" }}
                          >
                            {String(cell)}
                          </Text>
                        )}
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {step.rows.length > 100 && (
              <Text size="xs" c="dimmed" ta="center" py="xs" bg="#f8fafc">
                ...and {step.rows.length - 100} more rows (initial 100 shown)
              </Text>
            )}
          </div>
        )
      ) : (
        <Paper
          p="sm"
          bg="var(--mantine-color-red-0)"
          radius="sm"
          style={{ border: "1px solid var(--mantine-color-red-3)" }}
        >
          <Group gap="xs">
            <Text size="xs" fw={700} c="red.9">
              Query Execution Failed:
            </Text>
            <Badge color="red" size="sm">
              {step.error ?? "error"}
            </Badge>
          </Group>
        </Paper>
      )}
    </div>
  );
}

export function CollapsedLogPill({
  step,
  runId,
  isExpanded,
  onToggle,
  divergenceSeq,
}: {
  step: NonQueryLogStep;
  runId: string;
  isExpanded: boolean;
  onToggle: () => void;
  divergenceSeq?: number;
}) {
  if (step.autoElevate) {
    return (
      <div
        id={`trace-${runId}-${step.seq}`}
        className={`log-pill-elevated ${step.status === "warning" ? "warning" : ""}`}
        style={{ marginBottom: 4 }}
      >
        {divergenceSeq === step.seq && (
          <Badge
            color="orange"
            variant="filled"
            size="sm"
            className="divergence-badge"
            mb={6}
          >
            ⚡ Divergence Point: Step #{step.seq}
          </Badge>
        )}
        <Group
          justify="space-between"
          wrap="nowrap"
          style={{ cursor: "pointer" }}
          onClick={onToggle}
        >
          <Group gap="xs" wrap="nowrap">
            <Code style={{ fontSize: "11px", fontWeight: 700 }}>
              [#{String(step.seq).padStart(2, "0")}]
            </Code>
            <Text size="xs" c="dimmed">
              +{step.cumulative_ms}ms
            </Text>
            <Text size="sm">{step.status === "denied" ? "🛡️" : "⚠️"}</Text>
            <Text
              size="xs"
              fw={700}
              c={step.status === "warning" ? "yellow.9" : "red.9"}
            >
              {human(step.actionName)} —{" "}
              {step.status === "denied"
                ? "GUARDRAIL INTERCEPTION"
                : "EXCEPTION ELEVATED"}
            </Text>
            <Text
              size="xs"
              c="dimmed"
              style={{
                maxWidth: 350,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {step.summary}
            </Text>
          </Group>
          <Group gap="xs">
            <Badge
              size="xs"
              color={
                step.status === "denied"
                  ? "red"
                  : step.status === "warning"
                    ? "yellow"
                    : "red"
              }
              variant="filled"
            >
              {step.status.toUpperCase()}
            </Badge>
            <Text size="10px" c="dimmed">
              {isExpanded ? "▲" : "▼"}
            </Text>
          </Group>
        </Group>
        {isExpanded && (
          <div style={{ marginTop: 8 }}>
            <pre
              className="data-code"
              style={{
                maxHeight: 220,
                overflow: "auto",
                margin: 0,
                background: "#ffffff",
                border: "1px solid rgba(0,0,0,0.1)",
              }}
            >
              {JSON.stringify(step.rawPayload, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div id={`trace-${runId}-${step.seq}`} style={{ marginBottom: 4 }}>
      {divergenceSeq === step.seq && (
        <Badge
          color="orange"
          variant="filled"
          size="sm"
          className="divergence-badge"
          mb={4}
        >
          ⚡ Divergence Point: Step #{step.seq}
        </Badge>
      )}
      <div className="log-pill" onClick={onToggle}>
        <Group gap={6} wrap="nowrap">
          <Code style={{ fontSize: "10px" }}>
            [#{String(step.seq).padStart(2, "0")}]
          </Code>
          <Text size="xs" c="dimmed">
            +{step.cumulative_ms}ms
          </Text>
          <Text size="xs">
            {getCategoryIcon(step.eventKind, step.actionName)}
          </Text>
          <Text size="xs" fw={600}>
            {human(step.actionName)}
          </Text>
          <Text
            size="xs"
            c="dimmed"
            style={{
              maxWidth: 350,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.summary}
          </Text>
        </Group>
        <Group gap="xs">
          <Badge size="xs" color="gray" variant="light">
            OK
          </Badge>
          <Text size="10px" c="dimmed">
            {isExpanded ? "▲" : "▼"}
          </Text>
        </Group>
      </div>
      {isExpanded && (
        <pre
          className="data-code"
          style={{ maxHeight: 180, overflow: "auto", margin: "4px 0 0 0" }}
        >
          {JSON.stringify(step.rawPayload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function FinalOutputCard({
  step,
  runId,
  divergenceSeq,
}: {
  step: FinalOutputStep;
  runId: string;
  divergenceSeq?: number;
}) {
  return (
    <Card
      padding="md"
      radius="md"
      withBorder
      style={{
        border: "2px solid var(--mantine-color-teal-6)",
        background: "var(--mantine-color-teal-0)",
      }}
      mb="xs"
      id={`trace-${runId}-${step.seq}`}
    >
      {divergenceSeq === step.seq && (
        <Badge
          color="orange"
          variant="filled"
          size="sm"
          className="divergence-badge"
          mb={6}
        >
          ⚡ Divergence Point: Step #{step.seq}
        </Badge>
      )}
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <Code style={{ fontSize: "11px", fontWeight: 700 }}>
            [#{String(step.seq).padStart(2, "0")}]
          </Code>
          <Title order={4} c="teal.9">
            {step.answer.kind === "answer"
              ? `🎯 Terminal Business Findings (${step.answer.findings.length})`
              : step.answer.kind === "clarify"
                ? "❓ Clarification Requested"
                : "🚫 Unable to Answer"}
          </Title>
        </Group>
        <Text size="xs" c="dimmed">
          +{step.cumulative_ms} ms offset
        </Text>
      </Group>

      {step.answer.kind === "answer" && (
        <Table striped highlightOnHover withTableBorder bg="white">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Metric / Key</Table.Th>
              <Table.Th>Synthesized Value</Table.Th>
              <Table.Th>Unit</Table.Th>
              <Table.Th>Evidence Citations</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {step.answer.findings.map((f, idx) => (
              <Table.Tr key={idx}>
                <Table.Td fw={600}>{f.key}</Table.Td>
                <Table.Td fw={700} c="teal.8">
                  {String(f.value)}
                </Table.Td>
                <Table.Td>{f.unit}</Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    {f.evidence?.map((ev, eIdx) => (
                      <Badge
                        key={eIdx}
                        size="xs"
                        variant="outline"
                        color="teal"
                      >
                        {ev.kind === "cell"
                          ? `${ev.query_id}[${ev.row},${ev.column}]`
                          : `calc:${ev.calculation_id}`}
                      </Badge>
                    ))}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {step.answer.kind === "clarify" && (
        <Paper p="sm" bg="white" withBorder>
          <Text size="sm" fw={700} c="blue.9">
            {step.answer.question}
          </Text>
          <Group gap="xs" mt="xs">
            <Text size="xs" c="dimmed">
              Missing requested parameters:
            </Text>
            {step.answer.missing_fields.map((field) => (
              <Badge key={field} size="xs" color="blue" variant="light">
                {field}
              </Badge>
            ))}
          </Group>
        </Paper>
      )}

      {step.answer.kind === "unable" && (
        <Paper p="sm" bg="white" withBorder>
          <Text size="sm" fw={700} c="red.9">
            Reason: {human(step.answer.reason)}
          </Text>
        </Paper>
      )}
    </Card>
  );
}

export interface InvestigationWorkbenchProps {
  items: TraceEvent[];
  runId: string;
  sqlOnly?: boolean;
  onToggleSqlOnly?: (value: boolean) => void;
  expandAllTrigger?: number;
  collapseAllTrigger?: number;
  divergenceSeq?: number;
  hideControls?: boolean;
}

export function InvestigationWorkbench({
  items,
  runId,
  sqlOnly,
  onToggleSqlOnly,
  expandAllTrigger,
  collapseAllTrigger,
  divergenceSeq,
  hideControls = false,
}: InvestigationWorkbenchProps) {
  const steps = useMemo(() => extractInvestigationSteps(items), [items]);
  const sqlSteps = useMemo(
    () => steps.filter((s) => s.kind === "sql_query") as SqlQueryStep[],
    [steps],
  );

  const [localSqlOnly, setLocalSqlOnly] = useState(false);
  const effectiveSqlOnly = sqlOnly !== undefined ? sqlOnly : localSqlOnly;
  const setEffectiveSqlOnly = onToggleSqlOnly ?? setLocalSqlOnly;

  const [activeSqlIndex, setActiveSqlIndex] = useState(0);

  // Expanded state for non-query pills
  const [expandedPills, setExpandedPills] = useState<Map<number, boolean>>(
    () => {
      const map = new Map<number, boolean>();
      for (const step of steps) {
        if (step.kind === "non_query_log") {
          map.set(step.seq, step.autoElevate);
        }
      }
      return map;
    },
  );

  // Reset state when runId changes
  useEffect(() => {
    const map = new Map<number, boolean>();
    for (const step of steps) {
      if (step.kind === "non_query_log") {
        map.set(step.seq, step.autoElevate);
      }
    }
    setExpandedPills(map);
    setActiveSqlIndex(0);
  }, [runId, steps]);

  // Handle external expand-all trigger
  useEffect(() => {
    if (expandAllTrigger && expandAllTrigger > 0) {
      setExpandedPills((prev) => {
        const next = new Map(prev);
        for (const step of steps) {
          if (step.kind === "non_query_log") {
            next.set(step.seq, true);
          }
        }
        return next;
      });
    }
  }, [expandAllTrigger, steps]);

  // Handle external collapse-all trigger
  useEffect(() => {
    if (collapseAllTrigger && collapseAllTrigger > 0) {
      setExpandedPills((prev) => {
        const next = new Map(prev);
        for (const step of steps) {
          if (step.kind === "non_query_log") {
            next.set(step.seq, step.autoElevate);
          }
        }
        return next;
      });
    }
  }, [collapseAllTrigger, steps]);

  const handleTogglePill = useCallback((seq: number) => {
    setExpandedPills((prev) => {
      const next = new Map(prev);
      next.set(seq, !next.get(seq));
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    setExpandedPills((prev) => {
      const next = new Map(prev);
      for (const step of steps) {
        if (step.kind === "non_query_log") {
          next.set(step.seq, true);
        }
      }
      return next;
    });
  }, [steps]);

  const handleCollapseAll = useCallback(() => {
    setExpandedPills((prev) => {
      const next = new Map(prev);
      for (const step of steps) {
        if (step.kind === "non_query_log") {
          next.set(step.seq, step.autoElevate);
        }
      }
      return next;
    });
  }, [steps]);

  const handleNavigateSql = useCallback(
    (direction: "next" | "prev") => {
      if (sqlSteps.length === 0) return;
      const nextIdx =
        direction === "next"
          ? (activeSqlIndex + 1) % sqlSteps.length
          : (activeSqlIndex - 1 + sqlSteps.length) % sqlSteps.length;
      setActiveSqlIndex(nextIdx);
      const target = document.getElementById(
        `sql-card-${runId}-${sqlSteps[nextIdx]!.seq}`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    },
    [sqlSteps, activeSqlIndex, runId],
  );

  const handleCopyCurrentSql = useCallback(() => {
    if (sqlSteps[activeSqlIndex]) {
      void navigator.clipboard.writeText(sqlSteps[activeSqlIndex]!.sql);
    }
  }, [sqlSteps, activeSqlIndex]);

  const displayedSteps = useMemo(() => {
    if (!effectiveSqlOnly) return steps;
    return steps.filter(
      (s) => s.kind === "sql_query" || s.kind === "final_output",
    );
  }, [steps, effectiveSqlOnly]);

  let sqlIndexCounter = 0;

  return (
    <div className="workbench-container">
      {!hideControls && (
        <WorkbenchControls
          sqlOnly={effectiveSqlOnly}
          onToggleSqlOnly={setEffectiveSqlOnly}
          onExpandAll={handleExpandAll}
          onCollapseAll={handleCollapseAll}
          sqlCount={sqlSteps.length}
          totalSteps={steps.length}
          divergenceSeq={divergenceSeq}
          onNavigateSql={handleNavigateSql}
          onCopyCurrentSql={handleCopyCurrentSql}
        />
      )}

      {displayedSteps.length === 0 ? (
        <Text size="sm" c="dimmed" p="md">
          {effectiveSqlOnly
            ? "No SQL queries recorded in this run."
            : "No events recorded in this run."}
        </Text>
      ) : (
        <Stack gap="xs">
          {displayedSteps.map((step) => {
            if (step.kind === "sql_query") {
              const currentSqlIndex = sqlIndexCounter++;
              return (
                <SqlExecutionCard
                  key={`sql-${step.seq}`}
                  step={step}
                  index={currentSqlIndex}
                  totalQueries={sqlSteps.length}
                  runId={runId}
                  isActive={currentSqlIndex === activeSqlIndex}
                  divergenceSeq={divergenceSeq}
                />
              );
            }
            if (step.kind === "final_output") {
              return (
                <FinalOutputCard
                  key={`out-${step.seq}`}
                  step={step}
                  runId={runId}
                  divergenceSeq={divergenceSeq}
                />
              );
            }
            return (
              <CollapsedLogPill
                key={`log-${step.seq}`}
                step={step}
                runId={runId}
                isExpanded={expandedPills.get(step.seq) ?? step.autoElevate}
                onToggle={() => handleTogglePill(step.seq)}
                divergenceSeq={divergenceSeq}
              />
            );
          })}
        </Stack>
      )}
    </div>
  );
}
