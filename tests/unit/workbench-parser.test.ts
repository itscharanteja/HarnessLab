import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@harnesslab/schemas/types";
import {
  computeDivergenceStep,
  extractInvestigationSteps,
} from "../../apps/web/src/live-data.tsx";

describe("Investigation Workbench Parser", () => {
  it("pairs SQL request and result into a single SqlQueryStep with delta duration", () => {
    const events: TraceEvent[] = [
      {
        kind: "tool_request",
        seq: 3,
        run_id: "00000000-0000-0000-0000-000000000001",
        elapsed_ms: 120,
        outcome_code: "ok",
        correlation_id: "tool_3",
        payload: {
          origin: "model",
          call: {
            kind: "tool",
            name: "execute_readonly_sql",
            arguments: {
              sql: "SELECT customer_id, SUM(amount) FROM orders GROUP BY 1",
            },
          },
        },
      },
      {
        kind: "tool_result",
        seq: 4,
        run_id: "00000000-0000-0000-0000-000000000001",
        elapsed_ms: 185,
        outcome_code: "ok",
        correlation_id: "tool_3",
        payload: {
          status: "ok",
          name: "execute_readonly_sql",
          data: {
            query_id: "q_1",
            columns: [
              { name: "customer_id", type: "integer" },
              { name: "sum", type: "numeric" },
            ],
            rows: [
              [1, "250.00"],
              [2, "120.50"],
            ],
            payload_hash: "a".repeat(64),
          },
        },
      },
    ];

    const steps = extractInvestigationSteps(events);
    expect(steps).toHaveLength(1);
    const sqlStep = steps[0];
    expect(sqlStep?.kind).toBe("sql_query");
    if (sqlStep?.kind === "sql_query") {
      expect(sqlStep.seq).toBe(3);
      expect(sqlStep.sql).toBe(
        "SELECT customer_id, SUM(amount) FROM orders GROUP BY 1",
      );
      expect(sqlStep.status).toBe("ok");
      expect(sqlStep.cumulative_ms).toBe(120);
      expect(sqlStep.duration_ms).toBe(65); // 185 - 120
      expect(sqlStep.columns).toEqual([
        { name: "customer_id", type: "integer" },
        { name: "sum", type: "numeric" },
      ]);
      expect(sqlStep.rows).toEqual([
        [1, "250.00"],
        [2, "120.50"],
      ]);
      expect(sqlStep.error).toBeUndefined();
    }
  });

  it("handles SQL error and timeout outcome correctly", () => {
    const events: TraceEvent[] = [
      {
        kind: "tool_request",
        seq: 1,
        run_id: "00000000-0000-0000-0000-000000000001",
        elapsed_ms: 50,
        outcome_code: "ok",
        correlation_id: "tool_1",
        payload: {
          origin: "model",
          call: {
            kind: "tool",
            name: "execute_readonly_sql",
            arguments: { sql: "SELECT * FROM nonexistent_table" },
          },
        },
      },
      {
        kind: "tool_result",
        seq: 2,
        run_id: "00000000-0000-0000-0000-000000000001",
        elapsed_ms: 95,
        outcome_code: "invalid_sql",
        correlation_id: "tool_1",
        payload: {
          status: "error",
          name: "execute_readonly_sql",
          error_id: "err_table_not_found",
          code: "invalid_sql",
        },
      },
    ];

    const steps = extractInvestigationSteps(events);
    expect(steps).toHaveLength(1);
    const sqlStep = steps[0];
    expect(sqlStep?.kind).toBe("sql_query");
    if (sqlStep?.kind === "sql_query") {
      expect(sqlStep.status).toBe("error");
      expect(sqlStep.error).toBe("invalid_sql");
      expect(sqlStep.duration_ms).toBe(45);
    }
  });

  it("extracts non-query steps and sets autoElevate on safety violations and faults", () => {
    const events: TraceEvent[] = [
      {
        kind: "start",
        seq: 1,
        run_id: "00000000-0000-0000-0000-000000000001",
        elapsed_ms: 0,
        outcome_code: "ok",
        correlation_id: null,
        payload: {
          task_key: "finance/q3_revenue",
          config_hash: "b".repeat(64),
        },
      },
      {
        kind: "policy_decision",
        seq: 2,
        run_id: "00000000-0000-0000-0000-000000000001",
        elapsed_ms: 10,
        outcome_code: "disallowed_statement_type",
        correlation_id: null,
        payload: {
          reason: "disallowed_statement_type",
          safety_violation: true,
        },
      },
      {
        kind: "fault",
        seq: 3,
        run_id: "00000000-0000-0000-0000-000000000001",
        elapsed_ms: 30,
        outcome_code: "transient_error",
        correlation_id: null,
        payload: {
          tool: "execute_readonly_sql",
          kind: "transient",
          match: "first_eligible_sql",
        },
      },
    ];

    const steps = extractInvestigationSteps(events);
    expect(steps).toHaveLength(3);

    expect(steps[0]?.kind).toBe("non_query_log");
    if (steps[0]?.kind === "non_query_log") {
      expect(steps[0].actionName).toBe("start");
      expect(steps[0].autoElevate).toBe(false);
    }

    expect(steps[1]?.kind).toBe("non_query_log");
    if (steps[1]?.kind === "non_query_log") {
      expect(steps[1].actionName).toBe("policy_decision");
      expect(steps[1].status).toBe("denied");
      expect(steps[1].autoElevate).toBe(true);
    }

    expect(steps[2]?.kind).toBe("non_query_log");
    if (steps[2]?.kind === "non_query_log") {
      expect(steps[2].actionName).toBe("fault");
      expect(steps[2].status).toBe("warning");
      expect(steps[2].autoElevate).toBe(true);
    }
  });

  it("extracts final_output steps for clarification requests and findings", () => {
    const clarifyEvents: TraceEvent[] = [
      {
        kind: "final_output",
        seq: 5,
        run_id: "00000000-0000-0000-0000-000000000001",
        elapsed_ms: 350,
        outcome_code: "clarify",
        correlation_id: null,
        payload: {
          kind: "clarify",
          question: "Which fiscal year and region do you want revenue for?",
          missing_fields: ["fiscal_year", "region"],
        },
      },
    ];

    const steps = extractInvestigationSteps(clarifyEvents);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("final_output");
    if (steps[0]?.kind === "final_output") {
      expect(steps[0].answer.kind).toBe("clarify");
      if (steps[0].answer.kind === "clarify") {
        expect(steps[0].answer.question).toContain("fiscal year");
        expect(steps[0].answer.missing_fields).toEqual([
          "fiscal_year",
          "region",
        ]);
      }
    }
  });

  it("pinpoints causal divergence point across baseline and candidate traces", () => {
    const commonStart: TraceEvent = {
      kind: "start",
      seq: 1,
      run_id: "00000000-0000-0000-0000-000000000001",
      elapsed_ms: 0,
      outcome_code: "ok",
      correlation_id: null,
      payload: {
        task_key: "analytics/kpi",
        config_hash: "c".repeat(64),
      },
    };

    const baseSqlRequest: TraceEvent = {
      kind: "tool_request",
      seq: 2,
      run_id: "00000000-0000-0000-0000-000000000001",
      elapsed_ms: 10,
      outcome_code: "ok",
      correlation_id: "call_1",
      payload: {
        origin: "model",
        call: {
          kind: "tool",
          name: "execute_readonly_sql",
          arguments: { sql: "SELECT count(*) FROM old_table" },
        },
      },
    };
    const baseSqlResult: TraceEvent = {
      kind: "tool_result",
      seq: 3,
      run_id: "00000000-0000-0000-0000-000000000001",
      elapsed_ms: 50,
      outcome_code: "ok",
      correlation_id: "call_1",
      payload: {
        status: "ok",
        name: "execute_readonly_sql",
        data: {
          query_id: "q_1",
          columns: [{ name: "count", type: "integer" }],
          rows: [[10]],
          payload_hash: "d".repeat(64),
        },
      },
    };

    const candSqlRequest: TraceEvent = {
      kind: "tool_request",
      seq: 2,
      run_id: "00000000-0000-0000-0000-000000000002",
      elapsed_ms: 10,
      outcome_code: "ok",
      correlation_id: "call_1",
      payload: {
        origin: "model",
        call: {
          kind: "tool",
          name: "execute_readonly_sql",
          arguments: { sql: "SELECT count(*) FROM new_optimized_table" },
        },
      },
    };
    const candSqlResult: TraceEvent = {
      kind: "tool_result",
      seq: 3,
      run_id: "00000000-0000-0000-0000-000000000002",
      elapsed_ms: 30,
      outcome_code: "ok",
      correlation_id: "call_1",
      payload: {
        status: "ok",
        name: "execute_readonly_sql",
        data: {
          query_id: "q_2",
          columns: [{ name: "count", type: "integer" }],
          rows: [[10]],
          payload_hash: "e".repeat(64),
        },
      },
    };

    const baseline = [commonStart, baseSqlRequest, baseSqlResult];
    const candidate = [commonStart, candSqlRequest, candSqlResult];

    // Divergence should be at step 2 (the SQL query difference)
    const divergence = computeDivergenceStep(baseline, candidate);
    expect(divergence).not.toBeNull();
    expect(divergence?.baseSeq).toBe(2);
    expect(divergence?.candSeq).toBe(2);

    // Identical traces should have no divergence
    expect(computeDivergenceStep(baseline, baseline)).toBeNull();
  });
});
