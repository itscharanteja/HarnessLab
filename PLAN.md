# HarnessLab implementation plan

Start with [AGENTS.md](AGENTS.md). Execute the numbered phases in order. Create each command in the phase that first uses it, run it from the repo root, and record its exit status and evidence in `docs/implementation-log.md`. A phase closes when its checklist and acceptance checks pass. Commands below specify the interfaces to build.

## Target outcome

Given a synthetic business question, return verified findings with SQL evidence or request the missing input. Given failed development runs, propose up to three immutable harness variants and evaluate them with the same pinned worker model. Expose the trace, config diff, matched results, safety gates and operator decision. Make an approved version the next baseline and preserve rollback. Measure improvements from stored runs and show an inconclusive result when evidence is insufficient.

```text
Browser → Next.js / Mantine → Fastify → Control PostgreSQL
                                  ↑            ↕
                                  │       TypeScript dispatcher ↔ Redis / BullMQ
                                  │            ├─→ Python runner / Worker Graph → DataOps MCP → synthetic PostgreSQL
                                  │            ├─→ Python evaluator → dev/validation reference bundles
                                  │            └─→ Python optimizer / Optimizer Graph ← sanitized dev-only summaries
                                  └─ operator review → guarded active-pointer update

Separate operator job → isolated holdout sandbox + private oracles → private release report
```

## LangGraph integration and migration

Repository audit at `a0205e3` on 2026-11-06. The audit repeated `make bootstrap` in a clean source copy with the pinned toolchain and cached packages, `make contracts-check lint typecheck`, `corepack pnpm test` (39 tests), and `uv run --locked pytest -q tests/unit` (42 tests). Compose reported all nine foundation services and the separate fixture holdout database healthy. Redis reported append-only persistence and `noeviction`. The original stack startup, production build and browser smoke are recorded in the [implementation evidence](docs/implementation-log.md).

The fixture generation, seed and verify targets in Phase 1 passed, as did all six benchmark integration tests. These checked the 60/30/30 roster, independent reference agreement and byte-identical regeneration, restored hashes, sandbox login restrictions, and restricted bundle isolation in the runner image. The metric catalog and both oracle implementations cover the previously unchecked cohort, subscription and reconciliation definitions.

| Status | Repository state and migration impact |
| --- | --- |
| Completed and reusable | Pinned pnpm/uv workspaces, Make and fixture CI, Next.js/Mantine shell, Fastify probes, `pg` pool, BullMQ queue connection, private FastAPI shells, Compose isolation and role bootstrap SQL, and generated v1 contracts and validators. Reuse `synthetic-business-v1`, its metric catalog, generators, development references, fixture artifacts and benchmark tests with their current identities and hashes. |
| Requires adaptation | The Phase 2 plan called for a separate runner state machine. Put its routing in the Worker Graph and keep the pinned OpenAI Agents SDK as a single-turn inference adapter. The runner image currently packages the runner source only. Phase 2 must package the MCP subprocess and its dependencies through an explicit allowlist. The shared v1 schemas are closed. Keep graph state internal and add a separately versioned trace projection for graph metadata. |
| Still to build | The control DB migration directory is empty beyond its placeholder. The dispatcher connects to BullMQ for readiness and has no worker or outbox relay. The private Python services are probe scaffolds, and the MCP service is a package scaffold. Implement the planned execution routes, MCP tools, grader, experiment workflow, optimizer, gates, API and dashboard in their existing phases. The real release bundles and signed-off validation digest remain operator work. |

Build in dependency order. Phase 2 adds internal state contracts and `harnesslab_runner/graph.py`, then exercises the Worker Graph with scripted model turns and real MCP. Phase 3 delivers grading, durable results and dispatch, plus the checkpoint interface and graph event contracts. Phase 4 adds `harnesslab_opt/graph.py` over the evaluator and dispatcher services, then enables persistent checkpoints and graph traces for both graphs in fixture integration. Phases 6 and 7 expose and render the redacted execution projection. Use the existing entry points throughout. Retire any temporary adapter only after the graph-backed path passes those entry-point tests. There is no existing orchestration loop to port.

Keep LangGraph in-process. Pin `langgraph` and `langgraph-checkpoint` in the Python workspace when used, and prove locked compatibility with Python 3.12, Pydantic, the model/MCP SDK pins and isolated service images. Use the dispatcher’s existing `pg` driver for checkpoint storage in control PostgreSQL. A Python `BaseCheckpointSaver` adapter talks to a private dispatcher interface so both graph services retain their existing credential boundaries. Preserve per-run deadlines and model budgets across restarts, and treat framework replay as a possible repeat of work. Version graph state and topology independently of harness YAML, benchmark and grading data. [LangGraph Python graph API](https://docs.langchain.com/oss/python/langgraph/graph-api), [checkpointer interfaces](https://docs.langchain.com/oss/python/langgraph/checkpointers).

## Phase 0 — Monorepo and local foundation

Dependencies — none.

- [x] Create the tree in AGENTS.md, root Makefile, pnpm and uv workspaces, explicit runtime pins and lockfiles. Use ESLint, Prettier, Vitest, Ruff, pytest and Playwright. Add TypeScript and Python health endpoints and a Next.js app shell. Pin the selected framework versions after a clean install and build.
- [x] Add `infra/docker/compose.yaml` for independent control and sandbox PostgreSQL 16 services, Redis 7 with persistence and `noeviction`, and local application services. Default to loopback exposure for web/API development ports and host CLI database ports. Keep private HTTP and MCP boundaries internal. Implement readiness probes and graceful shutdown.
- [x] Document `CONTROL_API_DSN`, `CONTROL_DISPATCHER_DSN`, `CONTROL_MIGRATOR_DSN`, `CONTROL_PROMOTER_DSN`, `SANDBOX_SEED_DSN`, per-split sandbox runtime credential mapping, `REDIS_URL`, `RUNNER_URL`, `EVALUATOR_URL`, `OPTIMIZER_URL`, `HL_MODE`, `HL_WORKER_PROFILE_FILE`, `HL_OPTIMIZER_PROFILE_FILE`, `HL_PRICE_PROFILE_FILE`, `HL_MAX_EXPERIMENT_MICRO_USD` and `OPENAI_API_KEY`. Only pass each process the subset it needs. Use ignored local env files and fixture defaults. Set `HL_MODE=fixture` locally and `HL_MODE=live` only where operator live inference is enabled. Resolve the actual run mode server-side from the authorized scope. The public demo always uses fixture adapters, including on live-enabled deployments. Provision hosted secrets through the platform.
- [x] Define versioned JSON Schemas for task input, answer, worker action, tools, traces, YAML config, proposal, run manifest, reports, queue reference and HTTP endpoints. Put examples and contract tests in the shared packages. Fail CI when type generation changes tracked files or a schema example fails either runtime.

**Validation**

```sh
make bootstrap
make infra-up
make contracts-check
make lint
make typecheck
```

**Accept when** a clean checkout installs from locks, infrastructure is healthy, both languages accept and reject the same contract vectors, and these checks use no provider account.

## Phase 1 — Synthetic benchmark and reference bundles

Dependencies — Phase 0.

- [x] Create `synthetic-business-v1` with 12 physical schema variants, each with ten tasks. Use one business model with renamed and reordered relations/columns and controlled changes in distributions, refund rates and fixture anomalies. In each variant maintain a checked logical-to-physical mapping. Expose real names, data types and relationships to the worker through MCP only.
- [x] Create six development variants, three validation variants and three holdout variants. Use a different seed and physical map per variant. Allocate exactly the following counts and keep each template family in its designated split. Treat the split and variant as part of every task ID and reference lookup.

| Category | Dev | Validation | Holdout | Dev / validation / holdout scenario families |
| --- | ---: | ---: | ---: | --- |
| Schema discovery | 10 | 5 | 5 | Paid-order count by month / refund totals by method / active subscriber count by plan |
| Multi-step analytics | 13 | 6 | 6 | Sept–Oct revenue bridge / signup cohort spend / subscription churn by plan and month |
| Data inconsistencies | 10 | 5 | 5 | Duplicate captured payment / paid invoice with unmatched balance / refund total exceeding captured payment |
| Tool failures | 10 | 5 | 5 | Monthly net revenue after one SQL timeout / product-unit totals after a malformed result / refund count by region after a one-shot transient error |
| Ambiguous requests | 7 | 4 | 4 | Revenue with missing period / churn with missing cohort / sales with missing metric basis |
| Efficiency | 10 | 5 | 5 | Order count by status / single-SKU price / invoice count by month |
| **Total** | **60** | **30** | **30** | **120** |

- [x] Populate logical tables `customers(id, region, signup_at)`, `products(id, sku, unit_price_cents)`, `orders(id, customer_id, ordered_at, status)`, `order_items(order_id, product_id, quantity, unit_price_cents)`, `invoices(id, order_id, status, total_cents)`, `payments(id, invoice_id, captured_at, amount_cents, method, status)`, `refunds(id, payment_id, refunded_at, amount_cents)` and `subscriptions(id, customer_id, plan, started_at, ended_at)`. Use PKs/FKs, index date and join keys, and represent absent end dates as NULL. Use USD integer cents, UTC timestamps and half-open periods. Dates are anchored to 2025 UTC.
- [x] Generate each variant from stable IDs and a SHA-256 keyed generator. Take the first eight digest bytes as an unsigned big-endian integer and use modulo for bounded choices. Use UTF-8 length-prefixed seed, namespace and stable ID as the digest input. Seed 200 customers, 20 SKUs, 600 orders spread across Jan–Dec, 1–3 distinct order items per order, one invoice per order, base payments for paid invoices, and 80 subscriptions. Choose dates, dimensions and quantities from explicit finite catalogs. Vary September and October volume, price and refund incidence and inject bounded, identifiable reconciliation anomalies. Commit the exact distributions, anomaly rules and ID ordering as code, and assert the named scenarios are feasible and produce discriminating results.
- [x] Enumerate scenario instances by category order and slot within each split. Assign each split's ordered stream round-robin across its variants. Use stable IDs `<dataset-version>/<split>/<variant>/<category>/<slot>`, IDs and seeded parameters for prompt materialization, and explicit subject keys in expected outputs. Reject duplicate normalized prompts and scenario instances across splits. Give each fault fixture one eligible event, a tool and a stable match rule. Inject the fault once before a genuine success can be returned, keyed by task and repeat, independently for each arm. A malformed response must traverse the worker's MCP result validator.
- [x] Define the metric catalog and reference calculations before running agents. Gross captured receipts sum captured payment amounts by `captured_at`, net receipts subtract refunds by `refunded_at`, and paid-order count counts distinct orders with a captured payment in the period. Reconciliation scenarios deliberately include duplicates or inconsistent amounts. For the revenue bridge require the two months' net receipts and order counts plus a signed volume effect, average receipt per paid-order effect and refund effect. For September (`S`) and October (`O`), use `(countO-countS)*avgS`, `countO*(avgO-avgS)` and `refundS-refundO`. Require nonzero paid-order counts in both months. Use a pinned Decimal context of 38 digits and round half-even to six decimal places for bridge effects. Explain in the rendered answer that average receipts per order combine pricing, product mix and payment effects. Keep reference SQL and an independent Python computation over the generated rows and fail generation on disagreement.
- [x] Define cohort spend as captured receipts from customers who signed up in the stated period, restricted to the requested spend period. Active subscriptions satisfy `started_at <= as_of` and `ended_at IS NULL OR ended_at > as_of`. Monthly churn counts terminations in the month among subscriptions active at the start, divided by that starting count. Require a nonzero denominator. Compare invoice and captured payment totals without netting refunds for reconciliation. Return discrepancy IDs in sorted order. Pin exact metric IDs, output keys, units and task tolerances in the generator. Task inputs may declare output keys and allowed clarification fields, with expected values and the correct missing-field subset reserved for the evaluator.
- [ ] Export manifests with IDs, split, schema/seed revision, checksums of sorted canonical rows, task inputs, fixtures, reference bundle hash and generator revision. Store answers in evaluator-only artifacts and public metadata in separate manifests. Include development refs in source, validation manifests without prompts/answers, and only holdout protocol in Git. Use private validation and holdout seeds/artifacts. Document `make benchmark-generate MODE=release SPLIT=validation SEED_FILE=… OUT_DIR=…` and the corresponding holdout command. Write artifacts directly to the restricted destination, including the seed revision and reference bundle digest. Import only prompt/fixture bundles and metadata into their authorized runtimes. Keep signed-off manifest digests in the environment's release metadata. CI generates disposable test-only bundles for all splits. Verify replay against hashes after loading a clean database.

**Validation**

```sh
make benchmark-generate MODE=fixture
make benchmark-seed MODE=fixture
make benchmark-verify MODE=fixture
uv run pytest tests/integration/test_benchmark.py
```

**Accept when** a clean regeneration is byte-identical, split and category counts are exact, variant IDs and scenario instances are disjoint, the independent oracles agree on every task, and a regular runtime container cannot read restricted bundles.

Fixture acceptance is verified. The export, regeneration and replay paths exist, and release generation was previously exercised with disposable seeds. The final checkbox tracks the real private seeds, restricted destinations, authorized artifact installation and signed-off validation manifest. Phase 2 can proceed on fixtures. Authorized live validation and holdout depend on their respective release artifacts.

## Phase 2 — Read-only DataOps MCP and harness runner

Dependencies — Phase 1 fixture acceptance.

- [x] Implement the six tools below using the Python MCP SDK over stdio. Start one session per run with a fixed variant role and run-local evidence/error ledger. Match the registry against the schema package at startup. Return typed errors with safe SQLSTATE-derived codes. Strip exception text, stack traces and credentials.
- [x] Use pglast to accept a single `SELECT` from variant tables, with an explicit recursive allowlist for plain/aggregate SELECTs, joins, nonrecursive read-only CTEs, scalar subqueries and the operators needed by the benchmark. Require an approved physical relation or a previously declared CTE in every FROM. Deny DML and DDL, writes in CTEs, locking, `SELECT INTO`, multi-statements, other schemas and catalogs, system columns, arbitrary functions, user-defined casts and arbitrary operators. Keep allowed built-in functions to `count`, `sum`, `avg`, `min`, `max`, `round` and `date_trunc` initially. Reject qualified function/operator escape paths. Use simple built-in types and prove the required oracle-shaped queries pass. Recheck hard policy within MCP even when the runner has already validated the call.
- [x] Use a dedicated LOGIN role per variant, no membership in privileged roles and SELECT only on the variant's relations. Revoke PUBLIC temp/create and sandbox connect access as appropriate. Use a read-only transaction, trusted search path restricted to `pg_catalog` and the active schema, UTC, 2 s statement timeout, 250 ms lock timeout, 8 KiB SQL maximum, and an outer result cap of 201 rows to detect and reject over 200. Reject duplicate output column names and responses over 64 KiB. Roll back on failures and use read-only credentials in a real integration test that tries to bypass the parser.
- [x] Add LangGraph to the runner workspace with tested exact pins and update `uv.lock`. Extend the isolated runner image to package the MCP subprocess and its runtime dependencies. Verify the locked image build and stdio launch with the existing environment allowlist and no restricted bundles.
- [x] Implement config validation from AGENTS.md and the fixed Worker Graph using LangGraph `StateGraph`. Version and validate internal state for run identity, deadline, budgets, schema/context, retries and SQL fingerprints, fault and evidence state, pending action and terminal outcome. Inject clients and credentials at runtime. Route model turns through action validation, policy and budget checks, MCP dispatch, configured schema discovery/recovery, finish verification and the terminal result. Reuse v1 types at the boundaries. Use an in-memory checkpointer for graph tests and leave the production checkpoint hookup to Phase 4.
- [x] Keep the OpenAI Agents SDK behind a stateless, single-turn adapter with no registered or hosted tools. Wrap the action in an object as `{action: ...}`. Use a nested union of closed per-tool variants `{kind:"tool", name, arguments}` and the finish variant `{kind:"finish", answer}`. Verify the generated provider schema against the supported strict subset and run local semantic checks on decoded outputs. Use supported fixed inference settings, an explicit turn timeout and an output limit. Fail profile initialization on unsupported settings. Use the same Worker Graph with scripted fixture turns based on actual tool responses and harness policy events. Disable SDK/provider tracing and remote state storage.
- [x] Use a hard 90 s per task deadline, at most ten model turns, per-turn remaining output allowance and conservative preflight estimates of cumulative input tokens. Reconcile provider usage after each call. Stop dispatch on an exhausted budget and record a failure if a reported overrun or usage mismatch occurs. Disable automatic provider retries. Cap every tool response fed to the model, preserve deterministic order in the model context, and assign stable run-local evidence IDs.

| Tool | Input | Result |
| --- | --- | --- |
| `list_tables` | `{}` | Sorted allowed physical relation names |
| `describe_schema` | `{tables: string[]}`, 1–6 approved names | Sorted columns, types, keys and relationships |
| `execute_readonly_sql` | `{sql: string}` | `query_id`, ordered columns, typed rows and payload hash |
| `get_business_definition` | `{metric_id: string}` | Versioned catalog entry and units |
| `validate_calculation` | `{operation, operands}` | `calculation_id`, checked Decimal and units, source refs. Operations are identity, sum, difference, product or ratio. Operands are numeric cell or earlier calculation refs, with arity/unit checks and division-by-zero rejection |
| `inspect_query_error` | `{error_id: string}` | Run-local error class, retryability and safe recovery hint |

Only stable scalars, bounded strings and nulls may appear in tool row results. Serialize decimals and timestamps canonically. Emit the exact delivered row order and use zero-based row numbers and column names for citations. Treat attempted out-of-scope tools, blocked SQL policy and cross-run evidence access as safety violations. Syntax errors, missing columns and an unresolved unqualified relation name count as invalid SQL. Reject unresolved relations before dispatch. Explicit access to a forbidden schema, relation or capability counts as a safety violation.

The runner returns a v1 `RunEnvelope`. Each admitted tool attempt has one `call_N` correlation ID, including attempts represented only by a policy event when the original call cannot be retained. The envelope preserves full delivered evidence independently of model context. Its canonical trace digest excludes run IDs and elapsed time and normalizes usage telemetry. Grading and durable commits start in Phase 3.

**Validation**

```sh
make config-check
make run-fixture
uv run pytest tests/unit/test_harness.py tests/integration/test_mcp.py tests/security/test_sql_policy.py
uv run pytest tests/regression/test_worker_graph.py
```

**Accept when** a real sandbox query completes with evidence via MCP, a malformed response and a transient error take the expected branches, disallowed SQL never executes, and every mutable YAML knob changes the intended runtime behavior in a test.

The graph-backed fixture entry point must also cover clarification before any SQL, schema discovery before SQL with a fresh model turn, verification/correction, exhausted budgets and denied or malformed calls. Check the same typed outcomes and evidence ledger the evaluator will consume, including after model-context truncation.

Fixture acceptance is verified in the [Phase 2 evidence log](docs/implementation-log.md#phase-2--read-only-dataops-mcp-and-worker-graph).

## Phase 3 — Deterministic grading, persistence and job delivery

Dependencies — Phase 2.

- [x] Grade three tagged worker outcomes. `answer` contains a list of unique `{key,value,unit,evidence}` findings with evidence IDs and typed cells/calculations. `clarify` contains `missing_fields` from the task contract and asks a concise question without findings. `unable` contains a stable reason code. Render answer text from the findings and label catalog. Grade clarification by exact missing-field set with no SQL attempt. For an answer, require the exact key set, declared units, type, numeric agreement and at least one valid same-run evidence value of the correct unit/type for each finding. For a raw cell, use the benchmark key’s declared unit to interpret the scalar. For a calculation, validate its declared unit and recompute the chain from recorded delivered operands. Store each operand’s unit annotation with its source reference and check unit algebra against the fixed catalog. Compare integer cents/counts exactly and other decimals at the absolute tolerance pinned per reference key. Normalize Unicode strings to NFC, apply only declared enum aliases and sort declared sets. Mark failed, unsupported, budget-exhausted, unsafe or incomplete runs as unsuccessful.
- [x] Emit ordered typed events for start, model usage, policy decision, tool request/result, fault, recovery, final output and grade. Persist `run_id`, monotonically increasing `seq`, relative time, event kind, outcome code, correlation IDs and bounded redacted payload. Omit hidden reasoning, credentials, DSNs and raw provider errors. Retain token counts, request IDs and bounded typed evidence. Fail a run closed if redaction would alter a scalar required by the grader. Store trace replay inputs, config hash, dataset/benchmark hashes, software revision, model snapshot/settings, price profile digest, schedule seed and environment mode in the run manifest. Hash canonical replay payloads and keep wall-clock, IDs and billing telemetry outside the deterministic grade/fixture digest. Regrade the stored envelope without model or SQL calls.
- [x] Implement the control DB migrations below. Use UUID PKs unless a natural key is shown, foreign keys, check constraints and UTC `timestamptz`. Store JSONB snapshots with schema/version fields. Finalize a task and append traces/grade atomically. Keep completed result, manifest, gate report and decision records immutable. Expose no oracle values in control storage.

| Table | Required fields and invariants |
| --- | --- |
| `harness_versions` | Unique `content_sha256`, canonical config, accepted YAML bytes, nullable parent FK, created timestamp |
| `harness_channels` | Channel PK, active version FK, revision, activation timestamp. Bootstrap the baseline. Prod has one channel, local tests use a separate channel |
| `benchmark_tasks` | PK `(benchmark_digest, task_key)`, category, split constrained to dev/validation, dataset digest, variant ID, input hash. Store dev/validation metadata only and resolve prompt artifacts by task identity |
| `experiments` | Baseline FK, channel/revision snapshot, principal, mode, scope, status, stage, immutable manifest, spend cap, reserved/spent amounts, created/completed times. Unique principal + idempotency key with request hash |
| `experiment_arms` | PK `(experiment_id, harness_id)`, baseline/candidate role, ordinal and disposition. One baseline per experiment |
| `task_runs` | Experiment/arm, benchmark/task FK, stage, repeat, result status, final output, grade and reason codes, latency, token counts, tool counts, cost micros, safety count and trace digest. Unique logical key `(experiment_id, harness_id, stage, task_key, repeat)` |
| `trace_events` | PK `(run_id, seq)`, event kind, span/correlation ID, redacted payload, timestamp |
| `failure_patterns` | Experiment FK, signature, count, stable supporting dev run/event refs, sanitized summary. Unique experiment + signature |
| `optimization_proposals` | Experiment FK, parent FK, resulting harness FK if valid, typed patch or redacted rejected-input summary, rationale, dev event refs and status/reason. Unique experiment + ordinal |
| `evaluation_reports` | Experiment/arm FK, comparison scope, policy version, paired roster digest, metric/gate JSON, evidence digest, completeness, winner marker. Unique experiment + arm + scope |
| `promotion_decisions` | Experiment/report FK when applicable, kind, actor, reason, expected/current revision, from/to version FKs, evidence digest and timestamp. Append-only |
| `work_items` / `outbox` | Unique work key per experiment, state, delivery generation, lease expiry, fence, effect marker, reservation and result ref. Unique outbox row per item + generation |
| `published_experiments` | Experiment PK/FK, publishing actor and timestamp. Readable only through curated views/API |

- [x] Write work and outbox records in the same transaction as experiment creation or stage transition. BullMQ carries only a work reference. Use queue name `harnesslab-work-v1` and job ID `hl-<work-uuid>-<generation>`. The relay sends committed outbox records, then acknowledges the send. Reconcile pending items with absent/terminal delivery records by increasing the generation transactionally. Claim jobs by DB lease and fencing token, renewing while active. Reclaim expired leases, reject stale fences on commit, and make completed work a no-op on redelivery. A stage advances once when its expected roster reaches terminal status.
- [x] Use work kinds `execute_task`, `analyze_and_propose` and `compare_and_advance`. The dispatcher calls private Python POST endpoints under `/internal/v1`. Use `/execute-task` for the runner, `/grade-task`, `/analyze-dev` and `/compare` for the evaluator, and `/propose` for the optimizer. Add analysis and comparison endpoints in Phases 4 and 5. Load task inputs from a split-scoped prompt bundle available to the dispatcher, separate from evaluator-only oracles. Runner inputs contain the approved config, task input, run manifest, split-scoped fault fixture and deadline. The evaluator validates the task hash and manifest then reads the oracle locally. The optimizer receives sanitized dev patterns only. Verify internal identity and validate request and result schemas. Test both auth and missing-artifact failure paths.
- [x] Reserve worst-case cost atomically for the bounded worker task or optimizer request before dispatch. Use a pinned price table per million input/output tokens and round charges up to integer micros. Settle with metered cost from actual reported tokens, including calls in failed task runs. Charge cached input at the pinned ordinary rate for conservative, comparable estimates. Use the reservation on unknown usage and mark the outcome incomplete for gate purposes. Include optimizer usage in experiment spend and report it separately from worker comparisons. Use zero price and zero external requests in fixture mode. Persist the live side-effect marker before sending. After ambiguous live completion or a lost response, charge the reservation and fail closed with `infrastructure_error`; do not replay inference. Retain a committed worker envelope so grading can retry without re-executing the worker. Allow three total attempts for safe pre-effect and deterministic work, with 1 s then 2 s backoff. Any terminal infra error or missing matched cell makes the affected report ineligible. Stop new work on cancellation or budget exhaustion and safely settle already reserved work.
- [x] Add checkpoint storage in an additive control DB migration and a private dispatcher interface for bounded reads and writes. Authorize the calling service against its assigned work kind and check the current lease fence transactionally. Derive thread IDs server-side from the logical work key and graph kind. Store checkpoint sequence, graph/state version, pinned input identity and the state needed for safe continuation. Persist checkpoint and pending node writes idempotently. Reject stale fences and incompatible state versions. Define a bounded retention policy independent of immutable results. Keep checkpoints out of API projections and omit credentials, raw provider payloads, oracles and holdout data.
- [x] Define a separate versioned graph execution event contract with stable node and edge IDs, ordered sequence, outcome/reason, elapsed time and links to canonical evidence events when applicable. Correlate Worker Graph events by run and Optimizer Graph events by proposal work item. Validate and persist the redacted projection under the same fence as the result. Keep canonical v1 envelopes, replay digests and grade inputs readable on their original path. Capture the graph versions in trusted experiment metadata and use the same Worker Graph version across all arms.

The fixture dispatcher submits one diagnosis task. It closes that roster into `report`; Phase 4 adds proposal and screening work and Phase 5 adds comparison and promotion. The private execute response wraps the original `RunEnvelope` in `ExecuteTaskResponse` with a separate versioned `GraphProjection`. Checkpoint access requires a service identity and the dispatcher-issued capability for the current work lease. Keep the checkpoint state and graph projection out of the canonical grader input.

**Validation**

```sh
make db-migrate
make phase3-artifacts
make dispatch-fixture
make grader-replay
make test-integration
make test-security
```

**Accept when** replay returns the same deterministic grade and digest, duplicate messages and crashes do not create a second terminal result or live spend, grading can retry from durable results, and failure to finish a matched roster blocks eligibility.

Also verify a migration upgrade from the Phase 0 role-bootstrap schema, replay a v1 envelope without graph events, and exercise stale-fence and cross-work checkpoint denials using local service identities.

Fixture acceptance is verified in the [Phase 3 evidence log](docs/implementation-log.md#phase-3--deterministic-grading-persistence-and-job-delivery).

## Phase 4 — Trace-derived optimization and paired trials

Dependencies — Phase 3.

- [x] Derive deterministic dev failure signatures from stable reason codes and event sequences. Start with schema errors before discovery, blocked repeat attempts of failed query fingerprints, unrecovered injected faults, evidence/verification gaps and excess tool calls on successful efficiency tasks. Cluster by signature and sort by descending count then signature. Require at least two distinct affected tasks for a recurring pattern. Retain up to three supporting run/sequence pairs per pattern. Include successful counterexamples and baseline measurements so the optimizer can see the cost of extra checks.
- [x] Build optimizer input from the top five dev clusters, aggregate dev metrics and the mutable config. Redact/truncate summaries and exclude raw prompts, arbitrary cell values, SQL strings and oracle values. Ask the optimizer for at most three independent proposals against the same parent. Require a closed proposal object with `patch`, `expected_metric`, `direction`, `rationale` and `evidence_refs`. Use `success_rate`, `invalid_sql_rate`, `tool_calls_per_success`, `recovery_rate` and `cost_per_success` as metric IDs, `increase` or `decrease` for direction, and `{run_id, seq}` event references. Validate shape, evidence lineage, scope, runtime support and resulting hash. Save rejection reasons. Never accept a proposal citing an event from outside the diagnosis sample.
- [x] Implement the schedules below. Capture fixed worker snapshot/settings, profile and price digests, benchmark, sandbox, evaluator and safety versions, task IDs, seeds, repeats and concurrency before execution. Use one in-flight inference unit per deployment for the MVP. Set the schedule seed to `20251106` by default. Build the roster in task/repeat blocks and shuffle arm order inside each block with the recorded seeded generator. Keep fault injection identical across arms. Repeat live inference independently and record model response identifiers and observed usage. Deterministic scoring and replay are required even when live inference varies.
- [x] Full experiments take the first 5 schema, 7 multi-step, 5 inconsistency, 5 tool-failure, 3 ambiguity and 5 efficiency tasks after ordering each category by a seeded hash of task ID. Reuse those exact baseline runs when completing the dev screen. Keep screening and validation disjoint. Evaluate the shortlist on all 30 validation tasks for three repeats with a fresh baseline under the same settings. Run a full stage only if its configured worst-case spend fits the remaining experiment budget.
- [x] For full experiments keep up to two dev candidates with complete safe runs and no loss in total dev successes. Require at least one more success or 10% lower worker cost per success. In fixture demo mode use the same rule with tool calls per success in place of cost, and rank by success, fewer calls per success and ascending config hash. For full experiments rank by success, lower worker cost per success, then ascending config hash. Freeze the shortlist before starting validation. Keep validation metrics in reports and away from the proposer. Preserve all candidates and their dispositions.
- [x] Implement the Optimizer Graph behind `/propose` with versioned state for the sanitized diagnosis, mutable parent view, proposal budget, validated candidates and rejection reasons. Route from input validation through the fixture or single-call live proposer, patch and lineage validation, and terminal audit output. Consume the evaluator's `/analyze-dev` output through the dispatcher. Return typed dispositions for the dispatcher to persist and use in the existing paired schedule. Keep screening, validation, grading and promotion with their existing service owners. Pin the compatible graph dependencies in the optimizer workspace.
- [x] Connect both graphs to the Phase 3 checkpoint interface and append their redacted execution events. Use durable checkpoints at safe boundaries and reconcile resumed work against the committed result, current fence, spend ledger and original deadline. Resume fixture work only with the evidence, MCP session state and one-shot fault state needed to preserve behavior. If that state cannot be restored, use the existing bounded fixture retry under a new fence. Keep automatic graph retries off for model calls. A checkpoint cannot authorize replay of ambiguous paid work or a second terminal commit. Test restart and redelivery across checkpoints and after committed results. Verify the optimizer cannot read validation inputs, oracle bundles or Worker Graph checkpoints.

| Stage | Full experiment | Public fixture experiment |
| --- | --- | --- |
| Diagnose | 30 dev tasks × baseline × 1 repeat | Six preset dev tasks × baseline, including two schema errors and one injected failure |
| Propose | Up to 3 typed patches in one bounded call | Same analyzer/validator, scripted optimizer adapter keyed to supplied clusters, at most 2 patches |
| Screen | All 60 dev tasks × baseline and each candidate × 1, reusing diagnosis baseline runs | Same six tasks × each candidate × 1 |
| Validate | All 30 validation tasks × baseline and up to 2 finalists × 3 | Skip. Return dev-only report with explicit `ineligible_fixture` |

A full experiment schedules up to 510 worker runs plus one optimizer request, excluding deterministic grading and delivery retries. The public fixture schedules at most 18 worker runs with no provider requests. If no candidate survives, finish with the applicable reason and keep the baseline. Show rejected patches, screened-out arms and incomplete stages in history.

The fixture trial uses the first two development tasks in each of schema discovery, tool failures and efficiency. The optimizer resumes at its validated-output boundary. The worker reuses a completed response if it lost delivery, or restarts an unfinished MCP session under the original deadline. The fixed development corpus is valid in both worker modes. Validation artifact mode must match the experiment mode.

**Validation**

```sh
make optimize-fixture
uv run pytest tests/regression/test_optimizer.py tests/integration/test_experiment.py
uv run pytest tests/integration/test_graph_persistence.py
```

**Accept when** recurring failures in stored traces lead to at least two distinct valid patches without hand-editing the configs, a malformed patch is audited and rejected, and the same fixture experiment produces identical graded results across restarts. Removing the source failure pattern must remove the corresponding fixture proposal.

Checkpoint restart and duplicate delivery must also preserve the matched fixture results, proposal dispositions, one-shot fault behavior and evidence links. Simulate an ambiguous paid effect and verify it settles once and fails closed. Verify graph metadata is ordered, bounded and redacted before retiring any temporary adapter.

Fixture acceptance is verified in the [Phase 4 evidence log](docs/implementation-log.md#phase-4--trace-derived-optimization-and-paired-trials). Full live validation requires the private release bundle and operator spend authorization.

## Phase 5 — Evaluation gates, operator promotion and holdout

Dependencies — Phase 4.

- [x] Compute metrics per arm, category and paired comparison. Success rate is successes / scheduled runs for complete rosters. Tool calls per success and cost per success divide all attempted calls or worker spend by successes. Use only worker model charges in the initial comparison since MCP tools have zero marginal metered cost. Also show calls averaged among successful runs, invalid SQL attempts / total SQL attempts, recovery of injected faults / scheduled recoverable injections, and nearest-rank p50/p95 task latency. A recovery requires the injected call to be encountered, a subsequent successful target call and a successful grade. Use `null` for undefined rates or ratios and expose counts alongside them.
- [x] Generate one versioned report per candidate. Record paired wins/losses/ties across task/repeat cells, category deltas, hard gate results and per-arm trace links. For uncertainty, bootstrap whole task IDs with all three matched repeats and shared arm rows. Sample within category, 10,000 resamples with a recorded seed, using nearest-rank percentile quantiles. Report ordinary two-sided 95% intervals and use one-sided 98.75% lower bounds for the two qualification routes across at most two finalists. Mark a bound unavailable when its denominator is undefined on the observed sample or in any resample. In particular, a zero baseline cost prevents computing relative cost reduction. Document the limited power of 30 distinct validation tasks and possible dependence within a schema variant. Add a leave-one-variant-out sensitivity table. Treat estimates as benchmark evidence for review.
- [x] Require every hard gate below and either the quality or the efficiency route. Calculate deltas from unrounded values and use inclusive comparisons except where the lower bound must be strictly positive. Apply identical rules in the evaluator and UI by persisting versioned gate outputs. A failed or unavailable gate yields a recorded reason and retains the active version.

| Gate | Rule |
| --- | --- |
| Provenance and completeness | Full live validation. Exactly 30 paired tasks × 3 repeats per arm. Manifest and report digests match. No infrastructure, unknown usage, budget-exhausted experiment, or artifact errors. A task-level budget stop with known usage remains a scored task failure. |
| Safety | Zero candidate safety violations on its dev and validation runs. Zero baseline validation safety violations. Any blocked capability escalation counts. |
| Regressions | Per-category candidate validation success rate is no more than 5 percentage points below baseline. No drop in number of successful repeats on any ambiguity or data-inconsistency task. Candidate p95 latency ≤ 1.25 × baseline p95, with nonzero baseline p95. |
| Quality route | Validation success delta ≥ 5 percentage points, its lower bound > 0 and cost per success ≤ 1.10 × baseline. |
| Efficiency route | Cost-per-success reduction ≥ 20%, its lower bound > 0, observed success delta ≥ 0 and the success delta lower bound ≥ −5 percentage points. |
| Human review | Only the highest-ranked qualifying candidate may be promoted. Prefer a quality-route pass, then higher success delta, lower cost per success and ascending config hash. Reviewer must submit the report digest, expected active revision and a reason. |

- [x] Protect the promote/rollback commands with an operator role and restricted DB functions. Inside a transaction lock the channel row, compare revision and baseline, verify immutable report/evidence digests and current policy, enforce eligibility/winner and mode, append a decision, then advance the pointer and revision. Use an idempotency key. Reject stale or duplicate conflicts with stable error codes. Manual rejection records reviewer and reason without moving the pointer. Rollback moves to the immediately preceding activated hash and appends a new decision. In-flight experiments keep their pinned config. Test fixture-backed promotion via a dedicated local-only test channel and injected live-like evidence. The deployed service and its DB role must enforce the live-only gate.
- [x] Add `make holdout-run` for a separate operator executable. It takes an explicitly nominated baseline/candidate pair, signed-off manifest digest, release ID and spend cap. Lock the pair, roster and matched settings before access. Use the same 30 × 3 evaluation design in a separate sandbox and a one-use ledger keyed by holdout digest. Permit resumption of the same sealed evaluation from durable checkpoints. Record an incomplete result if matched completion becomes impossible. Output a private aggregate report with provenance, counts, deltas and uncertainty. Keep per-task output in restricted storage. Do not tune, re-rank, or try another candidate against the same holdout after revealing results. Use a fresh locked holdout for a future independent release test.

**Validation**

```sh
make gates-check
make holdout-run MODE=fixture
uv run pytest tests/security/test_artifact_access.py tests/regression/test_promotion.py
```

**Accept when** a deliberately worse or unsafe candidate is rejected, a complete qualifying report can activate a version through the test channel, concurrent approvals and stale evidence cannot change the pointer, rollback affects only subsequent experiments, and the online system has no path to holdout credentials, rows or artifacts.

The dispatcher queues `compare_and_advance` and sends bounded run facts to the evaluator. It stores one immutable report per compared candidate and scope, with the pinned manifest and paired run IDs and trace digests kept in restricted evidence. Development screening uses `dev_fixture` or `dev_screen`; only a full live `validation` winner is eligible for production review. The statistical interval describes these benchmark tasks. Thirty distinct tasks provide limited power, and tasks in the same schema variant may share failure modes. Review the leave-one-variant-out results alongside the pooled estimate.

The isolated holdout executable seals the nominated pair, model, budget and matched roster before opening prompts or oracles. Its restricted SQLite ledger permits a resume of the same seal and retains per-run results. The separate aggregate report contains counts, deltas and uncertainty. An interrupted paid attempt without a saved response settles at the reservation and yields an incomplete comparison.

Fixture acceptance is verified in the [Phase 5 evidence log](docs/implementation-log.md#phase-5--evaluation-gates-operator-promotion-and-holdout). Private release validation and holdout execution remain operator work.

## Phase 6 — Fastify API and access controls

Dependencies — Phase 5. Scaffold Fastify in Phase 0 and keep DB/queue ownership from Phase 3.

- [ ] Implement JSON endpoints with generated contracts, structured errors `{code,message,request_id}`, bounded payloads, stable cursor paging and server-owned filters. Use 202 for accepted experiment/cancel requests, 400 for bad shapes, 401 for missing credentials, 403 for prohibited operations, 404 for inaccessible resources, 409 for state/idempotency conflicts and 429 for quota limits. Use `Idempotency-Key` on mutations, scope it to actor and command, and reject reuse with a different normalized body.
- [ ] Verify Supabase access tokens with configured issuer, audience and JWKS. Read operator membership from a server-managed allowlist keyed by verified subject. Use a fixture auth adapter only in local/test environments. Route browser calls through an explicit same-origin Next proxy. Protect the public-facing Fastify service with a server-only proxy credential. Strip client-supplied internal/identity headers at the proxy. For mutations check origin and verify user identity where required. Give anonymous sessions an opaque signed HTTP-only cookie and authorize their experiment IDs server-side.
- [ ] Allow anonymous requests only for published examples and the caller's fixture run. Default the public run toggle to off. When enabled, allow one active run per session, two active public runs globally and ten starts per rolling hour across the deployment. Enforce quotas atomically in PostgreSQL. Use preset task sets only, no live API requests, and cap fixture experiment wall time at two minutes after dispatch. Operators can launch full experiments only when live mode is configured, the approved cap is within the deployment maximum, and diagnosis fits the cap. Check each subsequent stage’s worst-case spend before enqueuing it.
- [ ] Return redacted, bounded traces and summaries. Offer opt-in, separately versioned Worker Graph and Optimizer Graph projections through the run trace and experiment detail respectively, under the same ownership and publication checks. Keep the default v1 response shape and support runs with no graph events. Hide checkpoints, raw internal payloads, private artifact keys and validation task prompts from public responses. Publishing requires operator review of the curated read projection. Exclude validation per-task details from the public projection even for a published live run.

| Method and path | Contract and caller |
| --- | --- |
| `GET /healthz`, `GET /readyz` | Liveness and DB/queue readiness, no infrastructure details. Probe access only |
| `POST /v1/experiments` | `{scope:"demo_fixture"\|"full_live", max_spend_microusd?}` → `{id,status}`. Only operator sets live scope/spend. Baseline resolved server-side |
| `GET /v1/experiments`, `GET /v1/experiments/:id` | Scoped history and stage progress, proposals, arm states and summaries |
| `GET /v1/experiments/:id/comparisons` | Stored reports and gate reasons, filtered by caller |
| `GET /v1/experiments/:id/runs`, `GET /v1/runs/:id/trace` | Cursor-paged run summaries and events. Authorize through owning experiment. Pair with task key, stage and repeat |
| `GET /v1/harnesses`, `GET /v1/harnesses/:hash` | Version lineage/config/diff and active status. Public gets only published or own demo projections |
| `POST /v1/experiments/:id/cancel`, `POST /v1/experiments/:id/publish` | Operator or fixture owner may cancel. Only operator may publish a terminal report |
| `POST /v1/experiments/:id/promote`, `POST /v1/experiments/:id/reject` | Operator. `{candidate_hash, report_digest, expected_revision, reason}` |
| `POST /v1/channels/:channel/rollback` | Operator. `{expected_revision, reason}` |

Use experiment statuses `queued`, `running`, `completed`, `failed`, `cancelled`. Store stage separately as `diagnose`, `propose`, `screen`, `validate` or `report`. A completed experiment can have no eligible candidate. Poll progress every two seconds while running, with backoff on errors and stop on terminal status. Review state belongs to the report/decision and does not rerun an experiment.

**Validation**

```sh
make api-check
make test-security
```

**Accept when** the public experiment path works with no API key, token spoofing and cross-session access fail, quotas hold under concurrent requests, and no public path can dispatch paid work or change the active pointer.

Access tests must also show that graph projections inherit the trace and experiment authorization rules and never expose checkpoint state or validation per-task details to the public.

## Phase 7 — Dashboard and reproducible demo

Dependencies — Phase 6.

- [ ] Build Next.js/Mantine routes `/`, `/experiments/[id]`, `/experiments/[id]/compare` and `/harnesses/[hash]`. Show active baseline, queued/running status, experiment mode, proposal diffs with evidence links, paired outcomes, per-category metrics, confidence intervals, gate decisions and lineage. Include empty, partial, rejected and inconclusive states. Keep controls keyboard-accessible and status text independent of color. Escape untrusted trace text.
- [ ] Compare baseline/candidate traces side by side for the same task, stage and repeat. Show SQL, timestamps, allowed rows/evidence, error class, recovery and resulting grade. Provide rejected proposals and experiments in history. Show promote/reject/rollback controls only to operators and confirm the reviewed hash/revision in the UI.
- [ ] Visualize the recorded Worker Graph path beside the paired run traces and the Optimizer Graph path beside proposal history. Show executed branches, retries, recovery, stops and skipped nodes where the recorded graph version supports them. Link steps to the supporting evidence or proposal disposition. Offer a keyboard-accessible ordered event view and a trace-only view for older or partial records.
- [ ] Add `make demo-fixture` to submit the public preset through the API, wait for terminal status with a bounded timeout and print the comparison URL. Use scripted responses plus genuine MCP SQL execution, injected errors, scoring and proposal validation. Label the result **Fixture model** and **Development only** on every view. Generate all displayed values from persisted runs.
- [ ] Add a two-minute demo script in `docs/demo.md`. Start the bounded run, open a baseline failure and its supporting cluster, inspect the proposed YAML diff and candidate trace, then show the promotion gate and history. Pair the deterministic interaction with a published live comparison if an authorized live run exists. Show inconclusive or negative results as recorded. Use a measured claim only with benchmark mode, denominator, model snapshot, date and report provenance. Highlight isolated SQL tools, trace-to-config lineage and the guarded feedback loop.

**Validation**

```sh
make dev
make demo-fixture
make test-e2e
```

`make dev` starts the local fixture stack in the background and waits for readiness. It enables the preset fixture demo locally. Playwright must exercise public submission, progress, side-by-side traces, rejected/ineligible states and a separate local operator review/rollback scenario. Exercise both graph projections, their evidence links and a run with no graph events.

**Accept when** a fresh visitor can launch and understand the fixture experiment from stored evidence, a reviewer can trace a decision to the exact report and config, and browser tests cover both paths.

## Phase 8 — CI, deployment and handoff

Dependencies — Phase 7.

- [ ] Wire `make ci` into GitHub Actions with frozen installs, contract regeneration check, lint, typecheck, unit/regression tests, migration upgrade, integration/security tests, web build and Playwright. Use disposable fixture DBs and no model secrets. Keep failed test reports as CI artifacts. Run sandbox, checkpoint recovery and artifact-access checks against production-like roles.
- [ ] Deploy Next.js to Vercel. Deploy Fastify and the TypeScript dispatcher as separate Cloud Run services. Give the dispatcher instance-based CPU, one warm instance, max one instance, readiness and SIGTERM handling. Use its durable lease protocol across deployments. Deploy runner, evaluator and optimizer as private IAM-authenticated services with separate identities and secret mounts. Invoke them with a service identity token for the target audience. Ship the holdout executable as a separately authorized Cloud Run Job. Use pinned container images and verify isolated builds exclude restricted data. [Cloud Run billing settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
- [ ] Provision Supabase for control DB/Auth and a separate private PostgreSQL sandbox, such as Cloud SQL, for online synthetic data. Use a separate holdout sandbox and identity. Configure Supabase Auth with an asymmetric signing key and test expired, wrong-issuer and wrong-audience tokens. Apply migrations with the migrator identity and seed with a separate account. Verify TLS, supported Postgres version and direct/session connection compatibility. Configure managed Redis with TLS, persistence, `noeviction` and a private connector. Use an artifact bucket with per-service read permissions. Test fixture quotas and secret rotation before enabling the public toggle.
- [ ] Document startup, cost caps, artifact installation, logs, backup/restore, replay, stuck work recovery, credential rotation and rollback in `docs/operations.md`. Include checkpoint retention and how to drain or route work pinned to an older graph version before deployment or code rollback. Add structured health/spend metrics and trace correlation. Alert on queue age, lease expiry, budget exhaustion and failed gate integrity checks. Use the stored version/revision for activation rollback and pinned deployment revisions for code rollback.
- [ ] Add a deploy check that verifies images, configuration, roles and required operator environment before any cloud writes. Run hosted fixture smoke tests. When credentials and spend approval exist, run a bounded live single-task smoke and submit a budgeted full experiment through the operator API. Poll it to terminal status and retain the real report. Run the holdout only under the separate operator protocol. Document deployment URLs, command outputs, measured or inconclusive results and any checks awaiting authorization in the evidence log.

**Validation**

```sh
make ci
make deploy-check ENV=staging
make smoke-hosted BASE_URL=https://your-harnesslab-host
make live-smoke MAX_SPEND_MICRO_USD=YOUR_APPROVED_LIMIT
```

**Accept when** CI is green, staged smoke checks succeed when run against the provisioned environment, the public demo never invokes live inference, and the runbook can reproduce an experiment and verify its activation or retention decision. Keep hosted and live checks marked pending if credentials, infrastructure or spend authorization are unavailable.

## Definition of done

- [ ] A fresh checkout can bootstrap, migrate, generate and verify the benchmark, run the fixture demo and pass `make ci` with no provider key.
- [ ] The versioned corpus has exactly 120 tasks in the 60/30/30 allocation, with independently checked references, verified hashes and a sealed holdout path.
- [ ] Trace-based diagnosis produces valid, distinct candidate configs, paired reports retain full provenance, and failures and inconclusive results are inspectable.
- [ ] Deterministic regrading works from stored envelopes. End-to-end tests cover unsafe SQL, artifact leakage, duplicate delivery, partial failure, budget stops, invalid patches, concurrent promotion and rollback. Both graphs are inspectable from redacted traces, and checkpoint recovery preserves evidence and spend invariants.
- [ ] Eligible review and rollback work in the isolated test channel. Production changes require the full live gate and an authorized operator. Future experiments use the active immutable hash.
- [ ] Deployment manifests, operations guide, demo script and evidence log are usable. The hosted release closes only after authorized deployment and smoke checks pass. A positive measured gain is a research outcome and is recorded only when a real comparison supports it.
