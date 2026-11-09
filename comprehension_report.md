# Comprehension Review Report (Stage 6)

**Target:** `docs/designs/developer_mode_investigation_workbench.md` (`1..407`)  
**Reviewer:** `egm-comprehension`  

---

### What this proposes

The document proposes a high-density "Investigation Workbench" component in `apps/web/src/trace.tsx` for developer mode (`viewMode === "technical"`). It replaces the existing dual-tab interface ("Live Output & Data" and raw trace cards) with a unified, chronological feed of execution steps. Executed SQL operations are elevated into dedicated inspection cards displaying the query text, internal agent reasoning, latency, and a constrained tabular data grid. All other non-query events are condensed into compact 28-pixel log pills that automatically elevate into expanded warning banners when an error, retry, or security policy denial occurs.

### How the existing system works, per this document

Currently, developer mode in `apps/web` acts as a cosmetic text swap over the business layout, splitting run evidence across two disconnected tabs. The "Live Output & Data" tab aggregates queries and results into summary cards that lack chronological context and reasoning attribution. The "Technical Trace & Graph" tab renders large Mantine cards with extensive whitespace and buries tool arguments and outputs inside collapsed HTML `<details>` elements. Critical upstream failures—such as schema discovery loops, JSON validation errors, or AST guardrail blocks—remain hidden within collapsed rows without visual elevation.

---

### Findings

#### 1. Severity: Blocker
*   **Affected Scope**: Technical Plan §2 (lines 104–106); Detailed Implementation Plan §1 (line 269), §2 (line 304), §9 (line 371); Goals (line 36); Non-Goals (line 48).
*   **Discrepancy Description & Rationale**:
    The design relies on extracting and displaying agent reasoning/thought text from `model_usage` events to accompany SQL queries (e.g. line 105: *"When a `model_usage` event carries preceding agent reasoning text, the parser attaches it to the immediately following `tool_request`"*; line 304: *"Track preceding `model_usage` payload to extract agent reasoning text"*). Simultaneously, line 48 establishes that backend and schema modifications are strictly out of scope (*"No changes to Fastify API routes, BullMQ jobs, database migrations, or `@harnesslab/schemas` type contracts (presentation layer only)"*).
    However, under `@harnesslab/schemas` (`packages/schemas/contracts/v1.json`), `model_usage.payload` is strictly typed as `ModelUsage` with `additionalProperties: false`, containing only `input_tokens: number`, `output_tokens: number`, and `request_id: string | null`. Neither `model_usage` nor any other `TraceEvent` variant in the canonical schema contains a reasoning, thought, or intent field. The proposed feature cannot be implemented as designed without changing backend contracts and payloads.

#### 2. Severity: Blocker
*   **Affected Scope**: Goals (line 39); CUJ 3 (lines 77–80); Detailed Implementation Plan §2 (lines 308–310).
*   **Discrepancy Description & Rationale**:
    The document outlines conflicting and invalid property paths for detecting policy rejections and auto-elevating them:
    *   Line 39 defines auto-elevation when `kind === "policy_decision" && outcome_code !== "allowed"`.
    *   Line 308 checks `event.outcome_code && event.outcome_code !== "success"`.
    *   Line 309 checks `item.kind === "policy_decision" && item.payload.decision !== "allow"`.
    *   Line 79 asserts that the elevated banner displays the *"blocked query fingerprint"*.
    In `@harnesslab/schemas`, `policy_decision.payload` is `{ reason: OutcomeCode; safety_violation: boolean }` with `additionalProperties: false`. It does not contain a `decision` property or a query fingerprint. Accessing `item.payload.decision` in TypeScript strict mode will fail compilation, and conflicting outcome code assertions (`"allowed"` vs `"success"`) introduce runtime evaluation bugs.

#### 3. Severity: Major
*   **Affected Scope**: Technical Plan §2 (lines 107–125); Detailed Implementation Plan §1 (lines 260–298); Failure Modes (line 186).
*   **Discrepancy Description & Rationale**:
    The document defines `ExecutionStep = SqlQueryStep | NonQueryLogStep` and specifies that all non-SQL events map to `NonQueryLogStep`. However, it only accounts for `start`, `model_usage`, `policy_decision`, and specific tool calls, completely omitting standard `TraceEvent` variants: `final_output`, `grade`, `fault`, and `recovery`.
    Line 186 states that when an agent emits a clarification question or fails during initial discovery, the workbench displays an empty-state card with the clarification question or failure reason. In `@harnesslab/schemas`, clarification questions and terminal failures reside in `final_output` (`payload: WorkerAnswer`). Because `final_output` is ignored by the parser and excluded from `ExecutionStep`, the workbench lacks the typed data structure needed to render clarification questions or final task outcomes.

#### 4. Severity: Major
*   **Affected Scope**: Goals (line 38); Technical Plan §2 (lines 117–124); Component Design Specifications §4.B (lines 167–175); Detailed Implementation Plan §2 (line 306).
*   **Discrepancy Description & Rationale**:
    The document conflates tool invocation names with event kinds. Lines 38, 117, and 306 enumerate non-query events as `describe_schema`, `list_tables`, `validate_calculation`, `policy_decision`, and `start`. In the schema, `start` and `policy_decision` are top-level `TraceEvent["kind"]` variants, whereas `describe_schema`, `list_tables`, and `validate_calculation` are tool invocations within `tool_request` and `tool_result`.
    Furthermore, `CollapsedLogPill` requires a compact `summary: string` (e.g. `tables: ["orders"]`). The design never explains how summaries are extracted for non-tool lifecycle events (`start`, `model_usage`), nor does it specify how non-SQL `tool_request` and `tool_result` events are paired (whether each yields an individual pill or if they are collapsed into a single step).

#### 5. Severity: Major
*   **Affected Scope**: Goals (lines 39–40); Detailed Implementation Plan §1 (line 296), §5 (lines 335–336), §6 (line 344); Verification Plan §2 (lines 396–398).
*   **Discrepancy Description & Rationale**:
    The state management contract between `autoElevate: boolean` and `expandedPills: Set<number>` is underspecified. Line 397 states that clicking "Collapse All Logs" must collapse all pills *except* auto-elevated errors. If expanded state is simply derived as `autoElevate || expandedPills.has(seq)`, clearing the set preserves auto-elevated pills, but prevents a user from ever manually collapsing an auto-elevated pill. Conversely, if `expandedPills` tracks explicit user toggles, the initialization and reset semantics must be explicitly defined to avoid contradictory UI behavior.

#### 6. Severity: Nit
*   **Affected Scope**: Detailed Implementation Plan §1 (lines 260–298).
*   **Discrepancy Description & Rationale**:
    The code snippet for `apps/web/src/workbench/types.ts` uses external schema types (`rows?: Scalar[][];`, `eventKind: TraceEvent["kind"];`) without importing `Scalar` or `TraceEvent` from `@harnesslab/schemas/types` or defining `Scalar` locally.

#### 7. Severity: Nit
*   **Affected Scope**: Technical Plan §1 (line 95); Non-Functional Requirements §2 (lines 246–249).
*   **Discrepancy Description & Rationale**:
    Line 95 characterizes `InvestigationWorkbench.tsx` as a *"virtual list"*. However, no virtual list dependency (e.g. `@tanstack/react-virtual` or `react-window`) or implementation is detailed in the plan. Section 2 (lines 246–249) relies instead on fixed CSS container max-heights (`260px`) and table row caps (`100` rows). The reference to a virtual list in the architectural summary is misleading.

#### 8. Severity: Nit
*   **Affected Scope**: Technical Plan §2 (line 113); Component Design Specifications §4.A (line 154); Detailed Implementation Plan §1 (line 271).
*   **Discrepancy Description & Rationale**:
    Line 113 defines `SqlQueryStep.elapsed_ms` as *"Milliseconds taken"*, and line 154 labels it as *"Latency: +X ms"*. In `TraceEvent`, `elapsed_ms` denotes the cumulative millisecond timestamp offset since the run began, not the individual tool call duration. If query latency is intended, the parser must compute the duration delta (`tool_result.elapsed_ms - tool_request.elapsed_ms`). The specification should clarify whether this field represents cumulative offset or delta latency.
