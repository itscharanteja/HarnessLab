# Goldfish Review Report: Initial Zoom Out Review (Stage 5)

**Target:** `docs/designs/developer_mode_investigation_workbench.md` (`1..407`)  
**Standard:** `/Users/charansriteja/.gemini/config/plugins/egm/resources/document_standards/zoom-out-standard.md`  

## Reviewer Status

| Reviewer | Status |
| :--- | :--- |
| `egm-zoom-out` | completed |
| `egm-inventive-catalyst` | completed |

## Severity Breakdown
* 🔴 **Blocker**: 1
* 🟡 **Major**: 5
* 🟢 **Nit**: 2

---

## Prioritized Findings (Blockers -> Major -> Nits)

### 1. Tab Structure Contradiction vs Goal of Unified Workbench - Severity: Blocker
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** Lines 35, 131–135, 351–356 (Goals, Architecture, and Section 5.7 `trace.tsx`)
* **Discrepancy Description**: A foundational architectural contradiction exists between the stated goal and the component integration plan. Line 35 states the core goal is to *"replace the disconnected 'Live Data' versus raw trace tabs in developer mode (`viewMode === "technical"`) with a single, high-density investigation workbench"*. However, Section 5.7 specifies: *"In the technical tab panel: Render InvestigationWorkbench in place of the raw `<ol className="event-list">`... Ensure `viewMode === "business"` remains completely unchanged and continues rendering `LiveDataView`"*. This leaves the outer `<Tabs>` wrapper (`Tabs.Tab value="live-data"` vs `Tabs.Tab value="technical"`) intact in developer mode. As a result, the causal chain remains severed: the developer still has two disconnected tabs where `LiveDataView` extracts queries out of order on Tab 1, and `InvestigationWorkbench` renders them in order on Tab 2.
* **Rationale & Recommendation**: Reconcile the layout architecture. In `apps/web/src/trace.tsx`, conditionalize the top-level view on `viewMode`:
  - When `viewMode === "technical"`, completely bypass the inner `<Tabs>` component and render `<InvestigationWorkbench>` as the direct, unified child of `<Trace>`.
  - When `viewMode === "business"`, preserve the existing `<Tabs>` or `<LiveDataView>` presentation. This fulfills the core mission of eliminating tab-switching during technical investigations.

---

### 2. Redundant Parser & Model Duplication vs Existing Live-Data Infrastructure - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** Lines 103–125, 260–311 (Sections: Event Stream Preprocessing, Target Files 1 & 2)
* **Discrepancy Description**: The design proposes creating `apps/web/src/workbench/parser.ts` and `apps/web/src/workbench/types.ts` (`clusterTraceEvents`, `SqlQueryStep`, etc.) from scratch. However, `apps/web/src/live-data.tsx` already contains mature, tested extraction logic (`extractLiveData`, `SqlExecution`, `DiscoveredSchema`) that parses SQL statements, paired results, column types, tabular rows, elapsed latency, errors, token counters, and business findings from `TraceEvent[]`. Introducing a parallel parser creates dual maintenance overhead, duplicate traversals of the event array, and conflicting models of what constitutes an executed SQL turn.
* **Rationale & Recommendation**: Adhere to the "Leverage Existing / Codebase Reuse" principle of the Zoom Out standard. Generalize `extractLiveData()` (or extract a shared pure utility in `live-data.ts`) to produce both the chronological step sequence and the aggregate metrics, or build `clusterTraceEvents()` directly upon `SqlExecution` and existing schemas from `@harnesslab/schemas/types`.

---

### 3. Premature Micro-File Fragmentation & Abstraction Sprawl - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** Lines 89–99, 258–347 (Architecture Component Map & Target Files 1–6)
* **Discrepancy Description**: The proposal fragments a single frontend view into 6 distinct files inside a new directory `apps/web/src/workbench/` (`types.ts`, `parser.ts`, `InvestigationWorkbench.tsx`, `SqlExecutionCard.tsx`, `CollapsedLogPill.tsx`, `WorkbenchControls.tsx`). Throughout `apps/web`, established architectural conventions favor cohesive, domain-scoped modules (`trace.tsx`, `live-data.tsx`, `graph.tsx`, `comparison.tsx`) rather than hyper-fragmented micro-files for sub-components of 30–50 lines each.
* **Rationale & Recommendation**: Consolidate into a cohesive module (e.g. `apps/web/src/workbench.tsx` containing the workbench container, execution cards, and log pills; or alongside `trace.tsx`). Reduce file sprawl to keep maintenance, test collocation, and code navigation simple.

---

### 4. Unresolved Side-by-Side Dual-Arm Comparison Architecture - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** Lines 57–58, 71–74, 235–236 (Open Questions, CUJ 2, Alternatives Considered)
* **Discrepancy Description**: Open Question 2 leaves synchronized scrolling and dual-arm behavior in `apps/web/src/comparison.tsx` (`.pair-grid`) as an open question. In HarnessLab, head-to-head tournament evaluation (Baseline vs Candidate) is the primary user journey for developer triage. If two independent `InvestigationWorkbench` instances are rendered side-by-side in `.pair-grid`, each with its own independent toolbar, independent sticky controls, and variable table heights, the layout will suffer from vertical desynchronization and awkward visual clutter.
* **Rationale & Recommendation**: Elevate the dual-arm comparison contract from an unresolved question to a concrete design requirement. Specify how the workbench behaves in dual-arm mode: e.g., lift `WorkbenchControls` to the parent container in `comparison.tsx` so a single toolbar controls both arms simultaneously, and define layout behavior for side-by-side 260px table viewports.

---

### 5. Missed Inventive Leverage: Causal Divergence Pinpointing Across Tournament Arms - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst`
* **Affected Scope:** Lines 69–74, 178–183 (CUJ 2, WorkbenchControls)
* **Discrepancy Description**: The design treats the workbench as a passive, linear viewer for single runs, offering only a basic "SQL Only" filter for comparisons. When comparing Baseline vs Candidate arms, engineers are forced to manually scan and eyeball line-by-line differences in tool choices, query syntax, and row counts to determine why one arm succeeded or cost less.
* **Rationale & Recommendation**: Turn the dual-arm comparison into an active diagnostic tool by adding **Causal Divergence Pinpointing**. In tournament view, automatically detect the first step where the candidate arm's execution diverged from the baseline (e.g., candidate skipped redundant `describe_schema` loops or utilized an index-aware query). Highlight this divergence point with an anchor badge so engineers immediately see the cause of differential performance without scrolling through matching preliminary steps.

---

### 6. Multi-Tool Turn Misattribution in Reasoning Attribution - Severity: Major
* **Reviewer Lens:** `egm-inventive-catalyst`
* **Affected Scope:** Lines 105, 304 (Event Clustering Pipeline & Parser specification)
* **Discrepancy Description**: The pipeline specifies: *"When a `model_usage` event carries preceding agent reasoning text, the parser attaches it to the immediately following `tool_request`"*. In LangGraph / agent runtimes, a single model turn often produces multiple tool calls (e.g., parallel schema queries or multiple calculation checks). Attaching the reasoning text only to the single immediate `tool_request` causes subsequent tool calls in that same turn to lose their causal context, or results in awkward duplicate rendering if cloned across all calls.
* **Rationale & Recommendation**: Model execution around the **Model Turn Container** (Turn -> Thought/Hypothesis -> Action(s) -> Observation(s)) rather than forcing reasoning to be an exclusive child property of an individual `SqlQueryStep`. This correctly reflects the LLM execution lifecycle and cleanly handles multi-tool turns.

---

### 7. Premature Implementation Weeds in High-Altitude Design - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** Lines 260–374 (Detailed Implementation Plan)
* **Discrepancy Description**: The design document plunges into low-level code implementation details, including complete TypeScript interface listings, specific CSS class names (`.workbench-container`, `.log-pill-elevated`), and exact JSX prop combinations (`<Table striped highlightOnHover withTableBorder>`), while core high-level architectural interactions (such as dual-arm coordination) remain unresolved.
* **Rationale & Recommendation**: Rebalance the document altitude. Replace boilerplate syntax listings with high-level component responsibility matrices, state transition diagrams, and clear cross-component contracts.

---

### 8. Lack of Keyboard Navigation for High-Density Developer Triage - Severity: Nit
* **Reviewer Lens:** `egm-inventive-catalyst`
* **Affected Scope:** Lines 178–183 (WorkbenchControls)
* **Discrepancy Description**: A high-density workbench built for rapid benchmark inspection should empower power users to triage runs without constantly switching between keyboard and mouse. Currently, all filtering and pill expansion interactions rely exclusively on mouse clicks.
* **Rationale & Recommendation**: Add standard ergonomic hotkeys (e.g., `s` to toggle SQL Only, `j`/`k` or `[`/`]` to jump to next/previous query or elevated error, `c` to copy active SQL).
