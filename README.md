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
