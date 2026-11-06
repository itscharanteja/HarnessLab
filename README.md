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

The fixture web shell opens at [http://localhost:3000](http://localhost:3000). The API readiness endpoint is at [http://localhost:4000/readyz](http://localhost:4000/readyz). The private Python services and dispatcher expose probes only to the local Compose networks. Stop the stack with `docker compose --file infra/docker/compose.yaml down`.

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
