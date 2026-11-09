# Stage 7 Critic Review Report: High-Density Investigation Workbench

**Target:** `docs/designs/developer_mode_investigation_workbench.md` (`Lines 1..255`)  
**Standard:** `/Users/charansriteja/.gemini/config/plugins/egm/resources/document_standards/feature-spec-standard.md`  

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-design` | completed |
| `egm-structural` | completed |
| `egm-style` | completed |

## Severity Breakdown
* 🔴 **Blocker**: 1
* 🟡 **Major**: 3
* 🟢 **Nit**: 3

---

## Prioritized Findings (Blockers -> Major -> Nits)

### 1. Violation of The Alternatives Rule (Maintainer Attribution without Citation) - Severity: Blocker
* **Reviewer Lens:** `egm-structural` & `egm-design`
* **Affected Scope:** Lines 204, 215, 226, 236 (`## Alternatives Considered`)
* **Discrepancy Description**: Every rejected alternative cites rejection as `Rejected by author: <rationale>` without linking an issue, discussion, or PR. The Feature Specification Standard explicitly mandates:
  > *"Rejection rationales must state concrete technical or scope trade-offs and must not attribute a rejection to a maintainer without linking their issue, discussion, or PR."*
* **Rationale & Recommendation**: Strip the subjective attribution prefix `Rejected by author:` from all four alternative entries. State the concrete technical and scope trade-offs directly (e.g., `**Rejection Rationale:** Terminal feeds destroy tabular representations and force manual JSON parsing...`), or link the design issue/PR discussion where the decision was recorded.

---

### 2. Event Clustering Pipeline Omits Terminal Answers and Clarification Turns - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Lines 101–125 (`### 2. Event Stream Preprocessing & Clustering Pipeline`)
* **Discrepancy Description**: The clustering pipeline partitions the event stream strictly into `SqlQueryStep` (`execute_readonly_sql`) and `NonQueryLogStep` (all other actions). It fails to specify typed models or rendering paths for terminal agent outcomes, specifically:
  1. Final structured answers (`answer` payloads).
  2. Standalone clarification turns (`ask_clarification` or prompt guidance without tools).
  3. Preceding model reasoning turns that terminate in an answer rather than a `tool_request`.
* **Rationale & Recommendation**: Extend the discriminated union in `workbench/types.ts` and `parser.ts` to include explicit `AnswerStep` and `ClarificationStep` representations. Ensure model reasoning preceding a final answer is attached to the answer card rather than dropped.

---

### 3. Missing Formal Risks & Mitigations Section - Severity: Major
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** Lines 184–189, 240–254 (`### 5. Failure Modes & Edge Case Safeguards`, `## Non-Functional Requirements`)
* **Discrepancy Description**: The document standard requires a distinct `Risks & Mitigations` section evaluating security, scalability, and complexity. While the spec includes "Failure Modes & Edge Case Safeguards" and "Non-Functional Requirements", it lacks a unified `## Risks & Mitigations` section that systematically pairs identified risks (e.g., DOM node bloat during 50+ event traces, high-frequency re-renders in dual-arm tournament mode) with concrete architectural mitigations.
* **Rationale & Recommendation**: Group and elevate these points under a formal `## Risks & Mitigations` header conforming to the standard template, specifically addressing DOM memory consumption when large tabular results are expanded.

---

### 4. Unresolved Open Questions Affecting Core Architecture - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** Lines 54–58 (`## Open Questions`)
* **Discrepancy Description**: The specification lists two open questions regarding:
  1. Whether non-query log expansion state persists in `localStorage` across navigation.
  2. Whether dual-arm comparison (`apps/web/src/comparison.tsx`) supports synchronized scroll locks by sequence number.
  Leaving core UI state persistence and cross-arm synchronization unresolved creates ambiguity for frontend implementation.
* **Rationale & Recommendation**: Resolve both questions with explicit architectural decisions (e.g., "Default expansion state is ephemeral per task run session and not persisted to `localStorage`" and "Synchronized scroll lock is deferred to a future iteration"). Move deferred capabilities to `## Non-Goals`.

---

### 5. Subjective and Hyperbolic Tone - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 13, 27–28, 213, 234 (`## Overview`, `## The Problem`, `## Alternatives Considered`)
* **Discrepancy Description**: Several descriptions rely on dramatic or opinionated phrasing rather than dry technical statements:
  * Line 13: *"acts as a cosmetic text swap"*
  * Line 27: *"Severed Causal Chain"*
  * Line 28: *"forcing dozens of manual clicks per investigation"*
  * Line 213: *"Completely severs the causal investigation loop"*
  * Line 234: *"Completely inhibits side-by-side visual comparison"*
* **Rationale & Recommendation**: Calibrate to neutral engineering prose:
  * Replace *"cosmetic text swap"* with *"toggles label text within the business layout"*.
  * Replace *"Severed Causal Chain"* with *"Chronological Disconnect Between Reasoning and Queries"*.
  * Replace *"forcing dozens of manual clicks"* with *"requiring repeated manual expansion of collapsed `<details>` elements"*.

---

### 6. Maintainer Attribution Editorial Action - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 204, 215, 226, 236 (`## Alternatives Considered`)
* **Discrepancy Description**: Classification: `CALIBRATE`. The phrase `*Rejected by author:*` introduces informal self-attribution across all four alternatives.
* **Rationale & Recommendation**: Apply `CALIBRATE`: Replace with `**Rejection Rationale:**` and lead immediately with the technical argument.

---

### 7. Synonym Redundancy and Colloquialisms - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 41, 50, 251 (`## Goals`, `## Non-Goals`, `### 3. Rollout & Backward Compatibility`)
* **Discrepancy Description**:
  * Line 41: *"Preserve the existing executive presentation and metric cards entirely..."* ("entirely" is redundant filler).
  * Line 50: *"remains fully intact and available"* (synonym redundancy).
  * Line 251: *"remain 100% untouched"* (colloquial phrasing).
* **Rationale & Recommendation**:
  * Line 41: Remove "entirely".
  * Line 50: Change to *"remains available as an inspection companion"*.
  * Line 251: Replace *"remain 100% untouched"* with *"remain unchanged"*.
