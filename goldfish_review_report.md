# Goldfish Annotated Review Report

**Status:** resolved  
**Target:** `docs/designs/developer_mode_investigation_workbench.md` (`1..407`)

## Prioritized Findings & AI Suggestions

### 1. Tab Structure Contradiction vs Goal of Unified Workbench [`egm-zoom-out`] - Severity: Blocker
*   **Affected Scope:** [Lines 35, 131–135, 351–356](docs/designs/developer_mode_investigation_workbench.md#L35-L356) (`## Goals`, `### 3. Data Flow Diagram`, `#### 7. apps/web/src/trace.tsx`)
*   **Discrepancy Description:** The design states the core goal is to replace the disconnected dual-tab interface in developer mode with a unified workbench, but Section 5.7 specifies rendering `InvestigationWorkbench` inside the technical tab panel of the existing `<Tabs>` component, preserving the severed dual-tab structure.
*   **Rationale:** Retaining the `<Tabs>` wrapper in developer mode perpetuates the exact fragmentation the feature was commissioned to solve.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Reconcile the layout architecture. Conditionalize at the root of `Trace` in `apps/web/src/trace.tsx`: when `viewMode === "technical"`, directly render `<InvestigationWorkbench>` without wrapping in `<Tabs>`. When `viewMode === "business"`, preserve the existing `<Tabs>` and `LiveDataView` presentation.
*   ***Proposed Edit:***
    *   Location: `apps/web/src/trace.tsx` specification in `docs/designs/developer_mode_investigation_workbench.md`
    *   Change: Update Section 1, Section 3 Data Flow Diagram, and Section 5.7 to state that `Trace` checks `useViewMode()` and bypasses `<Tabs>` entirely when in `technical` mode, mounting `InvestigationWorkbench` as the top-level body of the panel.

---

### 2. Non-Existent Reasoning Field in Canonical Schema [`egm-comprehension`] - Severity: Blocker
*   **Affected Scope:** [Lines 36, 104–106, 269, 304](docs/designs/developer_mode_investigation_workbench.md#L36-L304) (`## Goals`, `### 2. Event Stream Preprocessing`, `#### 1. types.ts`, `#### 2. parser.ts`)
*   **Discrepancy Description:** The specification repeatedly describes extracting and displaying agent reasoning/thought text from `model_usage` events, while simultaneously declaring backend and schema changes out of scope. In `@harnesslab/schemas` (`v1.json`), `model_usage` carries only `input_tokens: number`, `output_tokens: number`, and `request_id: string | null`. No reasoning text exists in canonical trace events.
*   **Rationale:** The feature cannot extract fields that do not exist in the canonical wire payload without breaking schema contracts.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Re-align the SQL execution card with the true schema contract. Remove the non-existent `reasoning` field from `SqlQueryStep` and `SqlExecutionCard`. Instead, display the active task guidance / harness configuration knob (e.g. `schema_inspection`, `task_guidance`) and focus the card on the executed SQL query, latency delta, row counts, and tabular results.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (Overview, Goals, Architecture, Types, Component Specs)
    *   Change: Remove "internal reasoning" extraction from `model_usage`. Replace with active harness guidance/knob attribution and structured tool parameters.

---

### 3. Invalid Policy Decision Properties & Path [`egm-comprehension`] - Severity: Blocker
*   **Affected Scope:** [Lines 39, 77–80, 308–310](docs/designs/developer_mode_investigation_workbench.md#L39-L310) (`## Goals`, `### CUJ 3`, `#### 2. parser.ts`)
*   **Discrepancy Description:** The document checks `kind === "policy_decision" && outcome_code !== "allowed"` and `item.payload.decision !== "allow"`, and claims the alert banner displays the blocked query fingerprint. In `@harnesslab/schemas`, `policy_decision.payload` is strictly `{ reason: OutcomeCode, safety_violation: boolean }`.
*   **Rationale:** Accessing non-existent properties fails TypeScript compilation, and conflicting outcome code assertions introduce evaluation bugs.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Correct the property path to match `packages/schemas/contracts/v1.json`. Auto-elevate when `item.kind === "policy_decision" && (item.payload.safety_violation || item.outcome_code !== "success")`, and display `item.payload.reason`.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (Goals, CUJ 3, Parser specification)
    *   Change: Update policy auto-elevation criteria and alert contents to use valid schema properties: `item.payload.safety_violation` and `item.payload.reason`.

---

### 4. Violation of The Alternatives Rule [`egm-structural` & `egm-design`] - Severity: Blocker
*   **Affected Scope:** [Lines 204, 215, 226, 236](docs/designs/developer_mode_investigation_workbench.md#L204-L236) (`## Alternatives Considered`)
*   **Discrepancy Description:** Rejections cite `Rejected by author: <rationale>` without linking an issue, discussion, or PR, violating the feature specification standard.
*   **Rationale:** The standard requires stating concrete technical and scope trade-offs directly rather than subjective maintainer attribution.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Strip the subjective prefix `Rejected by author:` from all four alternative entries and replace with `**Rejection Rationale:**` leading directly into the technical trade-off.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (`## Alternatives Considered`)
    *   Change: Replace `*Rejected by author: <reason>*` with `**Rejection Rationale:** <reason>`.

---

### 5. Redundant Parser & Model Duplication vs Existing Live-Data Infrastructure [`egm-zoom-out`] - Severity: Major
*   **Affected Scope:** [Lines 103–125, 260–311](docs/designs/developer_mode_investigation_workbench.md#L103-L311) (`### 2. Event Stream Preprocessing`, `#### 1. types.ts`, `#### 2. parser.ts`)
*   **Discrepancy Description:** Creating a separate `workbench/parser.ts` duplicates extraction logic already mature and tested in `apps/web/src/live-data.tsx` (`extractLiveData`, `SqlExecution`, `DiscoveredSchema`).
*   **Rationale:** Dual parsers create maintenance drag and dual event loop traversals.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Generalize `apps/web/src/live-data.tsx` to export a shared pure function `extractInvestigationSteps(items: TraceEvent[])` reusing `SqlExecution` and canonical schema types.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (Architecture & Implementation Plan)
    *   Change: Consolidate stream clustering into `apps/web/src/live-data.tsx` and eliminate redundant parser duplication.

---

### 6. Premature Micro-File Fragmentation & Abstraction Sprawl [`egm-zoom-out`] - Severity: Major
*   **Affected Scope:** [Lines 89–99, 258–347](docs/designs/developer_mode_investigation_workbench.md#L89-L347) (`Architecture Component Map`, `Detailed Implementation Plan`)
*   **Discrepancy Description:** Splitting a single frontend view into 6 micro-files in a new directory contradicts established `apps/web` conventions (`trace.tsx`, `comparison.tsx`, `live-data.tsx`).
*   **Rationale:** Hyper-fragmenting 30-line subcomponents increases navigation friction and test boilerplate.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Consolidate into a cohesive module `apps/web/src/workbench.tsx` containing the workbench container, execution cards, and log pills.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (Component Architecture & Target Files)
    *   Change: Consolidate `apps/web/src/workbench/*` into `apps/web/src/workbench.tsx`.

---

### 7. Missing Lifecycle Events (`final_output`, `grade`, `fault`, `recovery`) [`egm-comprehension` & `egm-design`] - Severity: Major
*   **Affected Scope:** [Lines 107–125, 260–298](docs/designs/developer_mode_investigation_workbench.md#L107-L298) (`Event Stream Preprocessing`, `Detailed Implementation Plan`)
*   **Discrepancy Description:** The pipeline only models `execute_readonly_sql` and generic non-query logs, omitting `final_output` (where clarification questions and task answers reside), `fault`, `recovery`, and `grade`.
*   **Rationale:** In tasks with clarification questions or terminal faults, omitting these events leaves the workbench empty or incomplete.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Extend `ExecutionStep` to include `FinalOutputStep` (handling `final_output` with `WorkerAnswer`) and explicitly model `fault`, `recovery`, and `grade`.
*   ***Proposed Edit:</a>
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (Data Models & Parser)
    *   Change: Add `FinalOutputStep` and lifecycle event mappings to the step discrimination model.

---

### 8. Unresolved Side-by-Side Dual-Arm Comparison Architecture [`egm-zoom-out` & `egm-design`] - Severity: Major
*   **Affected Scope:** [Lines 54–58, 69–74](docs/designs/developer_mode_investigation_workbench.md#L54-L74) (`## Open Questions`, `### CUJ 2`)
*   **Discrepancy Description:** Dual-arm comparison behavior in `apps/web/src/comparison.tsx` (`.pair-grid`) is left as an open question, creating implementation ambiguity.
*   **Rationale:** Head-to-head tournament evaluation is HarnessLab's primary developer workflow; its layout and synchronization must be specified.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Resolve Open Question 2 directly: in `apps/web/src/comparison.tsx`, lift the `WorkbenchControls` toolbar to the parent container to control both arms simultaneously, while each arm maintains an independent scrollable container with sticky headers.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (`## Open Questions`, `### 1. High-Level Architecture`, `### CUJ 2`)
    *   Change: Remove Question 2 from Open Questions. Document the unified comparison toolbar and dual-arm synchronization architecture.

---

### 9. Causal Divergence Pinpointing Across Tournament Arms [`egm-inventive-catalyst`] - Severity: Major
*   **Affected Scope:** [Lines 69–74, 178–183](docs/designs/developer_mode_investigation_workbench.md#L69-L183) (`### CUJ 2`, `#### C. WorkbenchControls`)
*   **Discrepancy Description:** The workbench acts as a passive linear viewer during comparisons, requiring engineers to manually scan line-by-line differences between Baseline and Candidate.
*   **Rationale:** Automated divergence detection significantly accelerates root-cause triage during A/B evaluations.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** In tournament view, automatically detect the first execution step where the candidate arm diverged from the baseline (e.g. different tool call, different SQL query, or error) and badge that step with `[⚡ Divergence Point]`.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (CUJ 2 and Component Design Specifications)
    *   Change: Add automated divergence step detection and visual anchoring in comparison mode.

---

### 10. Missing Formal Risks & Mitigations Section [`egm-structural`] - Severity: Major
*   **Affected Scope:** [Lines 184–189, 240–254](docs/designs/developer_mode_investigation_workbench.md#L184-L254) (`### 5. Failure Modes`, `## Non-Functional Requirements`)
*   **Discrepancy Description:** Lacks a unified `## Risks & Mitigations` section pairing identified risks (DOM node bloat, comparison desynchronization) with concrete mitigations.
*   **Rationale:** Required by the feature specification standard template.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Consolidate failure modes and non-functional concerns into a formal `## Risks & Mitigations` section with a structured Markdown table.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md`
    *   Change: Add formal `## Risks & Mitigations` section with risk, severity, impact, and architectural mitigation.

---

### 11. Underspecified Auto-Elevation State Interaction [`egm-comprehension`] - Severity: Major
*   **Affected Scope:** [Lines 39–40, 296, 335–336](docs/designs/developer_mode_investigation_workbench.md#L39-L336) (`## Goals`, `Detailed Implementation Plan`)
*   **Discrepancy Description:** Interaction between `autoElevate: boolean` and user-controlled `expandedPills: Set<number>` is contradictory when "Collapse All" is clicked.
*   **Rationale:** Underspecified UI state models create inconsistent accordion behavior.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Formulate the state contract: `expandedPills: Map<number, boolean>` initialized with `autoElevate` values on mount. Clicking "Expand All" sets all to `true`, clicking "Collapse All" resets user-toggled entries to `false` while preserving `autoElevate === true`, and individual pill clicks toggle local state.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (Data Models & Component Design)
    *   Change: Formulate the exact state transition rules for log pill expansion.

---

### 12. Editorial Calibration & Style Fixes [`egm-style`] - Severity: Nit
*   **Affected Scope:** [Lines 13, 27–28, 41, 50, 213, 234, 251](docs/designs/developer_mode_investigation_workbench.md)
*   **Discrepancy Description:** Subjective tone ("cosmetic text swap", "severed causal chain") and redundant phrasing ("entirely", "100% untouched").
*   **Rationale:** Maintain neutral, dry technical engineering prose.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Calibrate prose across the affected lines.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md`
    *   Change: Apply neutral prose replacements across all noted lines.

---

### 13. Ergonomic Keyboard Shortcuts [`egm-inventive-catalyst`] - Severity: Nit
*   **Affected Scope:** [Lines 178–183](docs/designs/developer_mode_investigation_workbench.md#L178-L183) (`#### C. WorkbenchControls`)
*   **Discrepancy Description:** All workbench filtering and navigation relies on mouse clicks.
*   **Rationale:** Keyboard navigation (`s` for SQL Only, `j`/`k` to jump between queries) streamlines rapid triage.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Document hotkeys in `WorkbenchControls` specification.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md` (`#### C. WorkbenchControls`)
    *   Change: Add keyboard shortcut bindings: `s` (toggle SQL only), `j`/`k` (navigate queries), `c` (copy active query).

---

### 14. Cumulative Timestamp vs Query Latency Clarification [`egm-comprehension`] - Severity: Nit
*   **Affected Scope:** [Lines 113, 154](docs/designs/developer_mode_investigation_workbench.md#L113-L154) (`Event Stream Preprocessing`, `Component Design`)
*   **Discrepancy Description:** `elapsed_ms` in `TraceEvent` is cumulative timestamp since run start, not individual query duration.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:** Clarify that `+X ms` displays cumulative timeline offset, and query execution duration is computed as `tool_result.elapsed_ms - tool_request.elapsed_ms`.
*   ***Proposed Edit:***
    *   Location: `docs/designs/developer_mode_investigation_workbench.md`
    *   Change: Document cumulative offset vs delta latency distinction.
