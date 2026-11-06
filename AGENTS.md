# HarnessLab agent instructions

Read this file and [PLAN.md](PLAN.md) before editing. This file governs how to work in the repository. PLAN.md defines the implementation contracts, phase order and acceptance checks. Follow any nearer AGENTS.md for its subtree. When beginning from these two files, place both at the monorepo root.

## Mission and scope

Build a DataOps investigation agent that answers business questions against synthetic PostgreSQL, cites the data behind its answers and asks a focused clarification when a request is underspecified. HarnessLab learns from development traces, proposes bounded YAML changes and measures those changes against the same worker model. A validated, approved version becomes the next baseline.

Ship the 120-task benchmark, real DataOps MCP tools, deterministic evaluator, trace-derived optimizer, gated promotion and rollback, and an inspectable dashboard. Use LangGraph as the Python orchestration runtime for the Worker Graph and Optimizer Graph. Keep executable self-modification, external data connectors, model training and additional orchestration frameworks outside the MVP. Keep proposals, failed comparisons and inconclusive results visible to authorized reviewers.

## Working protocol

1. Read the current git status, relevant files and the earliest unchecked phase in PLAN.md. Work in dependency order and preserve unrelated changes. Use the phase contracts and existing helpers before introducing abstractions.
2. At the start of a phase, identify the vertical slice and the exact checks to run. Keep configuration and behavior changes small and traceable. Preserve supported callers and stored runs when changing a contract.
3. Implement the normal path and specified failure paths together. Update generated types with their source schemas, migration fixtures with their migration, and operational docs with their command. Commit lockfiles and pin runtime versions and deployment images. Record intentional contract changes in both root documents.
4. Run the phase's validation commands from the root. Record actual outcomes and any missing credentials in the phase evidence log. Check off a phase only when its acceptance criteria hold. Leave a reproducible command and the failing condition for anything outstanding.
5. Use fixture mode for local development and CI. Use live inference only for explicitly requested, budgeted experiments. Treat deployment, hosted migrations, holdout evaluation, release activation and rollback as operator actions. Implement and exercise the same paths in an isolated local/test environment.
6. Report changed files, commands run, remaining limitations and any unchecked work. Keep benchmark and live model results separate from fixture results.

## LangGraph integration and migration

- Continue from the verified Phase 0 foundation and Phase 1 fixture corpus. Reuse the pinned workspaces, service shells, shared v1 schemas, Compose services and role bootstrap, benchmark generators and artifacts, and fixture checks. The private release bundles remain operator work. See the repository audit and acceptance checks in [PLAN.md](PLAN.md#langgraph-integration-and-migration).
- Add internal versioned state and the Worker Graph in Phase 2 inside `harnesslab_runner`. Reuse the generated task, action, tool, answer and envelope contracts. Use the OpenAI Agents SDK only behind the stateless model-turn adapter. Keep MCP dispatch, fault handling, evidence and hard budgets under trusted application code.
- Establish the persistence, lease and trace contracts in Phase 3. Add the Optimizer Graph in Phase 4 inside `harnesslab_opt` on top of deterministic evaluation and the dispatcher’s experiment services. Enable durable checkpoints and record graph execution traces under the existing work identity and fence. Python accesses checkpoints through the dispatcher's private, scoped interface. The dispatcher owns scheduling, spend and durable commits. The operator API owns review and activation.
- Pin and test LangGraph and its checkpoint dependencies in `uv.lock` when introduced. Keep state serialization versioned and bounded. Disable external tracing and fail closed on ambiguous paid effects. Verify fixture branch parity, restart/redelivery, old-envelope replay, and checkpoint and trace access before enabling durable execution. Keep any temporary compatibility adapter until the graph passes the existing entry-point regressions. Expose only redacted graph execution data through the API and dashboard in Phases 6 and 7.

## Monorepo and ownership

```text
harnesslab/
├── AGENTS.md
├── PLAN.md
├── README.md                          # setup, architecture, result links
├── Makefile                           # public development and CI entry points
├── .env.example                       # local configuration contract
├── .github/workflows/ci.yml
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── pyproject.toml                     # uv workspace root
├── uv.lock
├── apps/
│   ├── web/                           # Next.js App Router, TS, Mantine
│   │   ├── app/
│   │   └── src/
│   ├── api/                           # Fastify HTTP, auth, promotion commands
│   │   └── src/
│   └── dispatcher/                    # Node outbox relay and BullMQ consumer
│       └── src/
├── packages/
│   ├── schemas/                       # JSON Schemas, examples, generated TS/Python
│   │   ├── contracts/
│   │   └── generated/
│   ├── harness-config/                # config schema and shared validation vectors
│   └── control-db/                    # TS queries, role-aware SQL migrations
│       ├── migrations/
│       └── src/
├── services/
│   ├── agent-runner/src/harnesslab_runner/
│   ├── dataops-mcp/src/harnesslab_mcp/
│   ├── evaluator/src/harnesslab_eval/
│   └── optimizer/src/harnesslab_opt/
├── benchmarks/
│   ├── generators/                    # generators, scenario catalog, import/export
│   ├── development/                   # dev prompts and reference definitions
│   ├── validation/                    # validation manifest only
│   └── holdout/                       # public protocol only
├── datasets/synthetic-business/       # seed config, schema templates, metric catalog
├── harnesses/
│   ├── baseline.yaml                  # immutable initial configuration
│   └── versions/                      # reviewed, hash-named exports
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── regression/
│   ├── security/
│   └── e2e/
├── infra/
│   ├── docker/                        # Compose and Dockerfiles
│   └── cloud-run/                     # deployment manifests and role bindings
├── scripts/                           # stable CLI wrappers used by Make and CI
└── docs/                              # operations, evidence log and demo script
```

- Use Node 22, TypeScript in strict mode, pnpm workspaces, Next.js App Router, Mantine, Fastify, BullMQ and the PostgreSQL `pg` driver. Use Python 3.12, uv, Pydantic, psycopg, the Python MCP SDK, pglast, LangGraph and the OpenAI Agents SDK model adapter. Use FastAPI for the private Python HTTP boundary. Use PostgreSQL 16 for local benchmark semantics and Redis 7 for BullMQ. Preserve the Phase 0 pins and verify compatibility when adding graph dependencies.
- Store orchestration, outcomes, redacted traces and the active pointer in control PostgreSQL. Use Supabase PostgreSQL and Auth for the hosted control plane. Use a separate PostgreSQL sandbox and credentials for synthetic data. Use Redis for delivery and backpressure. Keep evaluator bundles in private artifact storage in hosted environments.
- The web app uses the Fastify API through a same-origin proxy. It has no DB or provider credentials. Fastify owns user auth, command validation and the operator review boundary. The dispatcher owns stage transitions, scheduling and durable result commits. Python implements execution, scoring and proposal generation. No Python BullMQ client.
- Keep one schema source for each cross-language payload. Generate TypeScript and Python types and validate payloads at every trust boundary. Reject unknown fields and validate again before persistence. Use parameterized SQL for control-plane queries, typed tagged results and UTC times. Represent decimal business values and money as decimal strings on the wire, with integer micros for metering in storage.
- Use additive, transactional control DB migrations and exercise upgrade from the previous schema in CI. Keep workflow history append-only where PLAN.md specifies it. Use database uniqueness, leases and compare-and-swap to enforce invariants across restarts and concurrent callers.
- Prefer pure, table-tested scoring, canonicalization and patch functions. Use real PostgreSQL, Redis and the MCP transport for integration tests. Test repeated delivery, timeout recovery, restricted SQL, artifact access and stale promotion. Lint and test both languages before merge.

## Trust boundaries

| Principal | Allowed access |
| --- | --- |
| Web and public demo | Curated read endpoints and bounded, preset fixture experiments. No operator routes or arbitrary SQL, prompts or model settings. |
| API / operator | Experiment submission and authorized audit reads. A dedicated database role invokes the promotion and rollback functions after server-side role checks. |
| Dispatcher | Control-plane run state and redacted reports. Private Python calls using service identity. No oracle, sandbox admin or promotion credentials. |
| Agent runner / MCP | Task input, approved harness and a read-only role scoped to one synthetic variant. Runner gets the worker model credential in live mode. MCP starts with an explicit environment allowlist and no provider credentials. |
| Online evaluator | Dedicated read-only access to the dev and validation reference bundles. It receives a redacted run envelope and returns a deterministic grade. |
| Optimizer | Sanitized dev failure summaries and the mutable harness view. No credentials for grading artifacts, SQL, the queue, the control DB or deployment. Its model may return structured suggestions only. |
| Holdout operator/job | A separately built and authorized job, private holdout bundle and isolated holdout sandbox. Writes a private aggregate report. No online service receives these credentials or mounts. |

- Treat task text, SQL results, trace strings, model output, rationale and tool errors as untrusted data. Put them in delimited data fields, never in privileged instructions. Make safety depend on code, SQL privileges and network policy. Enforce the tool allowlist and limits at dispatch. Turn off provider/SDK trace export and remote state storage in the live adapter. Keep canonical application traces with explicit redaction.
- Allow only fixed model-provider destinations and required service connections from trusted processes. Models have no network, filesystem, shell, hosted tools or secret access. The MCP subprocess communicates via stdio and connects only to its selected sandbox.
- Use an allowlisted PostgreSQL AST, read-only transaction, variant-scoped role and strict time/row/byte limits together. Preserve hard limits even when a YAML knob changes. Treat a policy-violating attempt as a safety event even if it is blocked. Keep query logs, evidence and tool responses within synthetic data and byte caps.
- Keep migration, seed, evaluation and runtime roles distinct. Keep validation oracle files out of application images and all holdout artifacts out of the online environment. Keep reference values, holdout task identifiers, provider credentials and internal error details out of public views and logs.
- Keep graph checkpoints private and separate from the redacted audit trace. Bind checkpoint access to the authenticated service, its assigned work and the current lease fence. The runner and optimizer have no control DB credentials. Keep graph state, node routing and checkpoint settings outside the mutable YAML paths.
- Preserve the v1 run envelope for replay. Carry the separately versioned graph projection in the private execute response. Authorize checkpoint operations with both the service identity and a capability tied to the current work lease.
- Persist the matched stage roster before dispatch and reuse the pinned diagnosis baseline cells in screening. The optimizer sees only typed development summaries and the mutable harness view. Fixture recovery may replay a completed worker envelope or resume validated optimizer output. An unfinished MCP session uses a bounded retry under the original deadline.
- Run paired comparisons as deterministic dispatcher work using the private evaluator. Preserve immutable report, manifest and evidence commitments. Only the restricted promoter function may advance the production pointer, and only for a qualifying live validation winner. The holdout executable uses its own sandbox, restricted artifacts and persistent one-use ledger.
- Serve browser requests through the same-origin Next.js proxy and its server-only credential. Fastify verifies operator subjects and session cookies, reads through curated views, and sends authenticated commands to the dispatcher. Public fixture quotas and deadlines are enforced in PostgreSQL. Validation run summaries and graph traces are operator-only, including for published experiments.
- Keep the dashboard on the scoped API. Show the persisted mode, report, and run evidence, and distinguish fixture results on each experiment view. Render untrusted trace text as text. Treat the browser's review controls as a client of the authenticated API and database gates.
- Count typed tool requests and correlate untyped, blocked or redaction-required tool attempts by their `call_N` policy event when no `tool_request` can be recorded. Keep usage in the run envelope and exclude token counts, request IDs, run IDs and elapsed time from the deterministic trace digest.

## Harness configuration

`harnesses/baseline.yaml` begins with this complete v1 document. The trusted worker and price profiles are resolved at experiment creation and recorded with the run. They remain fixed across arms. Never resolve a floating model alias during a trial.

```yaml
schema_version: 1
model_profile: dataops-fixed-v1
prompt:
  task_guidance: "Investigate the request and cite the returned data."
workflow:
  schema_inspection: on_error
  verify_numeric_answers: false
  retry_policy: error_aware
context:
  recent_tool_results: 4
limits:
  max_tool_calls: 12
  max_retries_per_tool: 2
  max_model_turns: 10
  max_input_tokens: 12000
  max_output_tokens: 3000
output_contract: dataops-answer-v1
tool_registry: dataops-mcp-v1
safety_profile: readonly-synthetic-v1
```

- Parse a single YAML document using a safe loader with duplicate-key rejection. Allow only JSON types and reject anchors, aliases, custom tags, merge keys, unknown fields and a source larger than 16 KiB. Validate strictly, then hash UTF-8 RFC 8785 canonical JSON with SHA-256. Keep numeric configuration values as bounded integers. Store canonical JSON and the accepted YAML bytes. A hash refers to the normalized content and is unique. Reuse an existing hash and retain a separate proposal/audit record for each attempt.
- Bootstrap the baseline once. Reject updates/deletes to harness version rows using DB grants and a trigger. Store parent version on first creation and proposal lineage per experiment. Export reviewed files to `harnesses/versions/<sha256>.yaml`. Existing YAML files and benchmark versions remain immutable. Pin a version per run and resolve the next baseline from the active pointer when creating a new experiment.
- Only accept typed `replace` operations on the exact paths below. Reject duplicate paths, wrong types, unknown keys, invalid values, no-op patches and patches larger than two operations. Revalidate and rehash the merged document. Apply the hard limits independently of candidate values.

| Path | Accepted values and runtime behavior |
| --- | --- |
| `/prompt/task_guidance` | Nonempty text, maximum 600 characters. Insert below fixed policy as task guidance. No interpolation or code execution. |
| `/workflow/schema_inspection` | `on_error` or `before_first_sql`. The second mode runs `list_tables` before the first SQL call if no metadata has been seen, then gives the model a new turn before any SQL. The error-aware path calls `describe_schema` for referenced active tables when a schema error is recoverable. |
| `/workflow/verify_numeric_answers` | Boolean. When enabled, numeric final claims must have a matching `validate_calculation` event. The runner permits a correction turn within budget. Grade every version for correctness and evidence regardless of this knob. |
| `/workflow/retry_policy` | `none` or `error_aware`. Only the latter allows recovery from classified errors. It never repeats a failed canonical SQL fingerprint except once after a classified transient error. |
| `/context/recent_tool_results` | Integer 2–8. Keep this many recent, bounded tool results in model context, plus compact metadata and live evidence IDs. Keep the grader's ledger independent of context truncation. |
| `/limits/max_tool_calls` | Integer 4–12. Count model-requested calls and harness-inserted calls, including denied, malformed and failed calls. |
| `/limits/max_retries_per_tool` | Integer 0–2. Apply across the run per tool to attempts at recovering from a failed call. The global call ceiling still applies. |

The tool registry, safety profile, score code, benchmark, model profiles, worker output contract, token caps and model-turn ceiling are trusted release inputs. The optimizer receives no mechanism to edit these inputs, change code or tests, add tools, write to git or move the active pointer. Promotion is a transaction controlled by a separate trusted path. Read the gate rules in PLAN.md before changing scheduling, reporting or deployment behavior.

## Local commands

Implement and keep the root commands documented in PLAN.md. Start with `make bootstrap` and `make infra-up`, then use `make db-migrate` and the phase-specific checks. Before marking the MVP complete, verify `make ci`, `make demo-fixture` and the corresponding live/deployment checks where authorized. CI must work without provider credentials and must not download validation or holdout artifacts. Use test-only evaluator bundles for CI and label their evidence as fixture results.

## Implementation references

- [LangGraph Python graph API](https://docs.langchain.com/oss/python/langgraph/graph-api) and [checkpoint persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [OpenAI Agents SDK quickstart](https://developers.openai.com/api/docs/guides/agents/quickstart?lang=python), [model configuration](https://developers.openai.com/api/docs/guides/agents/models) and [structured output schema requirements](https://developers.openai.com/api/docs/guides/structured-outputs)
- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [PostgreSQL read-only transactions](https://www.postgresql.org/docs/16/sql-set-transaction.html)
- [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids) and [Cloud Run instance-based billing](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
