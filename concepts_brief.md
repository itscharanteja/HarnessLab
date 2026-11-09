# High-Density Investigation Workbench for Developer Mode

* **Author:** Charan Sri Teja
* **Date:** 2026-11-09

## Overview

HarnessLab's developer mode (`technical` view mode in `apps/web`) currently acts as a cosmetic text swap over the business layout. It hides tool arguments and return values behind collapsed `<details>` elements while isolating extracted query metrics in a separate tab, severing the causal link between reasoning, queries, and data.

This feature replaces that split with a unified, high-density investigation workbench in the technical trace view. SQL executions are presented as first-class inspection units displaying the executed query, preceding internal reasoning, and tabular results. Non-query events (such as schema inspection, token usage, calculation checks, and policy guardrails) are condensed into compact, 28px expandable log pills with status indicators, with automated elevation for any event that encounters an error, retry, or security policy denial.

## Analysis

### 1. UX & Visual Rhythm (Goldfish: Design)
- **High Information Density vs. Visual Overload**: Unfiltered trace lists create cognitive fatigue. Elevating SQL executions with dedicated monospace code styling and compact tabular grids draws focus directly to data-fetching operations.
- **Constrained Viewports**: Tabular result grids must have constrained vertical heights (e.g. max 260px) with sticky headers and horizontal overflow scrolling to prevent large result sets from monopolizing vertical space.
- **Workbench Controls**: Provide quick toggles at the top of the workbench: "SQL Only", "Expand All Logs", and "Collapse All Logs".

### 2. Codebase Architecture Alignment (Goldfish: Codebase Details)
- **Component Refactor in `apps/web`**: Currently, `Trace` in `apps/web/src/trace.tsx` renders Mantine `<Tabs>` with two disconnected panels: `📊 Live Output & Data` (`LiveDataView`) and `⚙️ Technical Trace & Graph` (`Graph` + raw event `<ol>`).
- **Stream Clustering**: In `apps/web/src/live-data.tsx`, `extractLiveData(items)` already pairs `execute_readonly_sql` calls with their result payloads, but detaches them from chronological context. The technical mode needs an event stream parser (`workbench-parser.ts`) that clusters sequential events (`model_usage` -> `tool_request` -> `tool_result`) into unified `ExecutionStep` objects.
- **Contract Integrity**: Retains strict adherence to `@harnesslab/schemas/types` (`TraceEvent`, `TaskRunSummary`, `Scalar[][]`).

### 3. Failure Mode Visibility (Goldfish: Skeptical Architect)
- **Guarding Against Silent Upstream Failures**: Agents often fail prior to SQL execution (such as looping repeatedly on `describe_schema`, encountering JSON validation issues, or getting blocked by a policy fence).
- **Automated Exception Elevation**: Any non-query turn with an error (`status === "error"`), retry, or policy denial (`kind === "policy_decision" && outcome_code !== "allowed"`) must break the collapsed pill rule and render as an expanded warning banner.
- **Harness Knob Traceability**: Visually link events to active harness parameters (e.g. badging `describe_schema` with active `schema_inspection` mode).

### 4. Layout Ergonomics & Comprehension (Goldfish: Comprehension)
- **Non-Query Log Pill Anatomy**:
  - `[#Seq] [Elapsed ms] [Icon] [Action Name] [Target/Arg Summary] ─── [Status Badge]`
  - Example: `[#02] +12ms 📋 describe_schema · tables: ["orders"] ─── 🟢 OK (14 cols)`
  - Error Example: `[#08] +1,120ms 🛡️ policy_decision · execute_readonly_sql ─── 🔴 DENIED (AST Allowlist)`
- **SQL Execution Card Anatomy**:
  - Header: Query ordinal (`Query #1 of 3`), execution latency (`+340ms`), status badge, and returned row count.
  - Reasoning Block: The agent's preceding internal thought or intent.
  - SQL Code Block: Monospace syntax-highlighted query with one-click copy.
  - Tabular Results: Striped Mantine table displaying columns, inferred types, and row data.

### 5. Inventive Principles & Contradiction Resolution (Goldfish: Inventive Catalyst)
- **TRIZ Principle #1 (Segmentation) & Principle #15 (Dynamism)**: SQL cards default to a structured preview showing the formatted query, preceding reasoning, and the first rows of data. Clicking expands to a full table inspection view.
- **TRIZ Principle #22 (Convert Harm to Benefit)**: Rather than treating non-query events as noise to hide, failed non-query events become instant alert callouts that highlight why the run struggled or stopped.

## Goals vs. Non-Goals

### In-Scope Goals
* Unify the separated "Live Data" and "Technical Trace" panels in developer mode (`viewMode === "technical"`) into a single chronological investigation workbench.
* Render SQL execution cards displaying query, internal reasoning, and tabular PostgreSQL result sets.
* Condense non-query turns (schema inspection, calculation checks, token usage, guardrails) into 28px expandable log pills with status badges.
* Automatically expand and elevate any non-query event that encounters an error, retry, or policy denial.
* Provide workbench filtering toggles ("SQL Only", "Expand All Logs", "Collapse All Logs") and keyboard navigation.

### Out-of-Scope Non-Goals
* Altering the existing business view (`viewMode === "business"`).
* Modifying server-side API endpoints, database schemas, or control plane contracts (presentation layer only).
* In-browser execution of arbitrary ad-hoc SQL queries against synthetic sandboxes.
* Replacing the LangGraph state visualization graph in the technical tab (the graph remains accessible as an inspection companion).

## Alternatives Weighed

* **Alternative 1: Raw Terminal / JSON Stream**
  * *Rejected by author: text-only terminal feeds force developers to parse nested JSON manually and destroy structured tabular database representations.*
* **Alternative 2: Keeping Disconnected Tabs ("Live Output" vs "Technical Trace")**
  * *Rejected by author: separating high-level data from the event list breaks causal debugging and prevents seeing which reasoning step created which query.*
* **Alternative 3: Static Collapse of All Non-Query Events**
  * *Rejected by author: unconditionally collapsing non-query events conceals critical upstream schema loops and security policy rejections.*

## Key Decisions & Staging for Next Steps

1. **Pure Event Preprocessor**: Implement a deterministic event stream clusterer (`apps/web/src/workbench/parser.ts`) that transforms flat `TraceEvent[]` into structured `ExecutionStep[]`.
2. **Modular Workbench Components**: Implement `SqlExecutionCard`, `CollapsedLogPill`, and `WorkbenchControls` under `apps/web/src/workbench/`.
3. **Integration into `Trace`**: Mount `InvestigationWorkbench` directly in `apps/web/src/trace.tsx` when `viewMode === "technical"`.
4. **Handoff to Drafting**: Proceed to `/egm-draft` to construct the formal design specification and verification plan.
