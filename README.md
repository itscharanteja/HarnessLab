# HarnessLab

HarnessLab investigates synthetic business data and records the evidence behind each answer. The implementation follows the phases in [PLAN.md](PLAN.md).

## Local setup

Install Docker Desktop with Compose, the Node version in [.node-version](.node-version), and uv 0.13.7. Install Python with `uv python install`. Corepack resolves the pnpm version from [package.json](package.json).

```sh
make bootstrap
make infra-up
make contracts-check
make lint
make typecheck
```

The fixture dashboard opens at [http://localhost:3000](http://localhost:3000). The API readiness endpoint is at [http://localhost:4000/readyz](http://localhost:4000/readyz). The private Python services and dispatcher expose probes only to the local Compose networks. Stop the stack with `docker compose --file infra/docker/compose.yaml down`.

[.env.example](.env.example) documents local CLI connection strings and service configuration. Copy it to an ignored `.env` for local CLI configuration. Compose supplies the application services with separate local credentials and internal addresses. Set the database port and matching host CLI DSNs together when overriding a port.

## Service configuration

- Fastify receives the API control DSN and Redis URL. The dispatcher receives its own control DSN, Redis URL and the three private service URLs.
- Use the migrator, promoter and seed DSNs for their dedicated commands. Keep seed credentials out of the runner. The runner receives split-specific runtime map paths. Each map associates a variant ID with the corresponding read-only DSN. The holdout runtime map belongs to the separate holdout job.
- The trusted worker, optimizer and price profiles are configured through `HL_WORKER_PROFILE_FILE`, `HL_OPTIMIZER_PROFILE_FILE` and `HL_PRICE_PROFILE_FILE`. `HL_MAX_EXPERIMENT_MICRO_USD` is the deployment cap. Compose runs with `HL_MODE=fixture` and needs no provider key. A hosted live-capable service receives its own `OPENAI_API_KEY` from the platform, and the API resolves each experiment's mode from its authorized scope.

[Implementation log](docs/implementation-log.md)

## Hosted runtime targets

Vercel targets Node 22.x. Vercel manages its patch version, while `make bootstrap` and the Docker image use the exact local pin. [Vercel Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

Cloud Run images must include `linux/amd64`, with each service listening on its configured port and handling SIGTERM. [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)

Use a direct TLS connection for Supabase migrations and a direct or session-mode TLS connection for persistent services. The synthetic benchmark uses PostgreSQL 16 in a separate sandbox. [Supabase PostgreSQL connections](https://supabase.com/docs/guides/database/connecting-to-postgres)

## Synthetic benchmark

With the fixture stack running, generate, seed and verify the synthetic corpus.

```sh
make benchmark-generate MODE=fixture
make benchmark-seed MODE=fixture
make benchmark-verify MODE=fixture
uv run pytest tests/integration/test_benchmark.py
```

Generation checks 120 tasks against independent PostgreSQL and Python references. It writes split-scoped, owner-only artifacts under `.artifacts/benchmark-fixture`. The holdout fixture uses a separate PostgreSQL instance on loopback port 55434 and a separate credential. Start it through the generator's Compose profile. The seed command creates read-only variant logins and saves their credentials separately from prompt and reference bundles. The verification command checks row, input and bundle digests after reload.

For release validation or holdout generation, supply a private seed JSON file with `seed_revision` and three distinct `seeds`, an owner-only destination outside the repository, and the authorized split's `SANDBOX_SEED_DSN`. The generator checks references in rolled-back scratch schemas.

```sh
make benchmark-generate MODE=release SPLIT=validation SEED_FILE=/restricted/validation-seed.json OUT_DIR=/restricted/validation-release
make benchmark-generate MODE=release SPLIT=holdout SEED_FILE=/restricted/holdout-seed.json OUT_DIR=/restricted/holdout-release
```

Install prompt and fault bundles in the authorized execution scope. Install the matching oracle only in the evaluator's private storage. Keep all holdout artifacts and credentials in the separate operator environment. Review the release manifest and record its digest before installation.

## Fixture Worker Graph

After generating and seeding the fixture benchmark, validate the baseline and run one preset development task.

```sh
make config-check
make run-fixture
uv run --locked pytest -q tests/unit/test_harness.py tests/integration/test_mcp.py tests/security/test_sql_policy.py tests/regression/test_worker_graph.py
```

The fixture uses scripted model turns, a real MCP stdio session and a variant-scoped PostgreSQL login. `make run-fixture` prints a v1 run envelope with the answer, evidence and trace digest. The runner starts the MCP subprocess with the selected sandbox credential and the public metric catalog. Build the runner with `make infra-up` before the image integration test.

## Durable fixture delivery

After the fixture benchmark has been generated and seeded, migrate the local control database and materialize the service-specific fixture mounts.

```sh
make db-migrate
make phase3-artifacts
make dispatch-fixture
make grader-replay
make test-integration
make test-security
```

`make dispatch-fixture` submits one preset development task and prints the experiment ID. The dispatcher relays its reference through BullMQ, saves the worker envelope, calls the evaluator, and commits the grade and trace to control PostgreSQL. A grading retry reads the saved envelope. Use the local fixture database roles for these commands.

The dispatcher receives only prompts and benchmark manifests. The evaluator receives manifests and oracles. The runner receives variant-scoped runtime maps. Compose mounts these three directories separately and supplies distinct private bearer identities. The fixture packaging command copies neither holdout data nor sandbox seed credentials.

## Fixture optimization trial

After rebuilding the fixture services and applying the control migrations, start the bounded six-task trial.

```sh
make db-migrate phase3-artifacts
make optimize-fixture
uv run --locked pytest -q tests/regression/test_optimizer.py tests/integration/test_experiment.py
uv run --locked pytest -q tests/integration/test_graph_persistence.py
```

The command prints an experiment ID and its stored development report. The dispatcher records the diagnosis, proposal decisions, matched screening roster, grades, and optimizer usage. Screening reuses the diagnosis baseline cells. Fixture reports are ineligible for activation.

Both graphs use the dispatcher's lease-scoped checkpoint interface. The optimizer resumes from validated suggestions. A worker can replay a completed envelope after a lost response. A worker interrupted before its MCP evidence ledger is complete uses the existing bounded fixture retry with the original deadline. The development corpus is shared across fixture and live worker modes. Live validation requires a separate operator-approved release bundle.

## Evaluation, review and isolated holdout

```sh
make db-migrate
make gates-check
uv run --locked pytest -q tests/security/test_artifact_access.py tests/regression/test_promotion.py
make holdout-run MODE=fixture
```

The fixture holdout uses the generated, seeded holdout bundle and the separate local PostgreSQL instance. It writes an owner-only aggregate report and resume ledger under `.artifacts/holdout-operator`. The fixture exercises the matched execution and grading paths with a scripted adapter and zero spend. Comparisons of development fixtures cannot promote.

The dispatcher stores versioned reports and matched trace references. Review commands use the dedicated `hl_promoter` database role after operator authentication. Production activation requires a qualifying live validation winner, its reviewed report digest, and the expected channel revision. Rejection records a reason, and rollback appends a new decision and advances the revision.

For an authorized release, run the separate holdout job with an explicitly nominated pair and the signed-off holdout manifest digest. Install and verify the private bundle and seed the isolated sandbox before running. Provide the holdout-only provider credential as `HL_HOLDOUT_API_KEY`, the isolated database name as `HL_HOLDOUT_SANDBOX_DATABASE`, and the deployed image digest as `HL_HOLDOUT_IMAGE_DIGEST`. Use one persistent, owner-only work directory across retries and release IDs. The ledger in that directory prevents reuse of a revealed holdout with a different pair.

```sh
make holdout-run MODE=release HOLDOUT_ARGS='--baseline /restricted/baseline.yaml --candidate /restricted/candidate.yaml --manifest-digest APPROVED_DIGEST --release-id RELEASE_ID --spend-cap APPROVED_MICROUSD --bundle /restricted/holdout --runtime-map /restricted/runtime.json --work-dir /restricted/holdout-ledger --worker-profile /restricted/worker.json --price-profile /restricted/price.json'
```

The container target for this job is `holdout` in `infra/docker/python.Dockerfile`, built with `SERVICE_PATH=agent-runner` and `SERVICE_PACKAGE=harnesslab-runner`. Its entry point accepts the same options, starting with `--mode release`. Mount private artifacts and runtime credentials into the job only. Per-task envelopes stay in the restricted ledger.

## Local fixture API

The browser API is available at `http://localhost:3000/api/v1` after `make infra-up` and `make db-migrate`. Public fixture starts are off by default. To enable them locally, set `HL_PUBLIC_RUNS=1` when starting the stack. `make api-check` temporarily enables them, exercises a real fixture through the Next.js proxy, and restores the prior setting.

Use `GET /api/v1/experiments` to establish a signed session cookie. Submit `{"scope":"demo_fixture"}` to the same URL with that cookie, the site origin and an `Idempotency-Key`. Read experiment progress at `/api/v1/experiments/{id}` and comparison results at `/api/v1/experiments/{id}/comparisons`. Add `?graph=1` to experiment detail or a run trace to request graph events. Published live examples expose aggregate validation comparisons and omit validation task and trace details.

The fixture operator token is available only in the local Compose API configuration. Hosted deployments use Supabase asymmetric access tokens. Set `HL_AUTH_MODE=supabase`, the issuer and audience, and `HL_OPERATOR_SUBJECTS` to the server-maintained list of verified UUIDs. The API derives the signing key endpoint from the issuer unless `HL_SUPABASE_JWKS_URL` is configured. Set separate server secrets for the browser proxy, session signing and API-to-dispatcher calls. [Supabase JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)

The live dispatcher reads the approved worker and optimizer settings from their profile files, a price profile with `worker` and `optimizer` entries containing decimal-string `input` and `output` prices, and the approved development and validation manifest digests. Each live request must include a spend cap within `HL_MAX_EXPERIMENT_MICRO_USD`.

## Dashboard demo

```sh
make dev
make demo-fixture
make test-e2e
```

Open [HarnessLab](http://localhost:3000) and select **Run fixture experiment** to follow the run in your browser. The terminal demo creates its own session, saves the comparison JSON under `.artifacts`, and prints the experiment's comparison URL. The browser launch keeps the signed session in the tab that will display the results. Follow the [two-minute demo script](docs/demo.md) to inspect diagnosis, matched traces, the harness diff and promotion gates.

## Release handoff

Run `make ci` for the complete local fixture validation. Use the [operations runbook](docs/operations.md) for deployment preflight, hosted smoke checks, isolated holdout, recovery and rollback.
