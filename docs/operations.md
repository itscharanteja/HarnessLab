# HarnessLab operations

## Local startup

Run `make bootstrap` with the pinned Node, Python and package managers, then run `make dev`. This starts the local Compose stack, applies the control migrations, and prepares fixture artifacts. Use `make demo-fixture` for a terminal check or launch the fixture at [http://localhost:3000](http://localhost:3000). `make ci` runs the complete fixture verification. On a clean CI runner set `CI_BROWSER_SETUP=1` to install the pinned Chromium and system dependencies.

For a local CI retry after rebuilding the changed services, set `HL_CI_REUSE_IMAGES=1` to reuse the verified fixture images. GitHub Actions builds the images on its clean runner.

The public switch defaults to off in `make infra-up`. The API and dispatcher must agree on `HL_PUBLIC_RUNS`. The fixture channel uses preset work, scripted model turns, and no provider key. Production experiments use the operator-supplied cap, immutable snapshot, trusted price profiles, and signed-off development and validation digests. The dispatcher checks each stage against the remaining cap before it schedules work. Review the stored comparison and evidence digest before submitting an activation command.

## Release inventory and preflight

Build the API and dispatcher from their named targets in `infra/docker/node.Dockerfile`. Build the runner, evaluator and optimizer from their targets in `infra/docker/python.Dockerfile`, with the corresponding `SERVICE_PATH` and `SERVICE_PACKAGE` from Compose. Build the holdout image separately with target `holdout` and runner build arguments. The build context excludes benchmark artifacts, credentials and generated local data. Push from an authorized release pipeline, then record the registry digest of each image.

Copy `infra/cloud-run/fixture.example.json` to the operator's restricted deployment directory. Replace all sample values, set `environment` to `staging`, and fill in the distinct service URLs, accounts, image digests, bucket names and numeric secret versions. The sample is a static test inventory. Generate the plan and optionally check resource metadata using an operator account with read-only access.

```sh
make deploy-check ENV=fixture
make deploy-check ENV=staging DEPLOY_CONFIG=/restricted/staging.json DEPLOY_OUTPUT=/restricted/plan
make deploy-check ENV=staging DEPLOY_CONFIG=/restricted/staging.json VERIFY_REMOTE=1
```

The preflight writes a local manifest for each service, the isolated Job manifest, and an IAM assignment plan. The remote inventory check reads registry images, service accounts, buckets and secret version metadata. The deployment and any IAM changes are separate operator actions.

## Provisioning and deployment

1. Provision Supabase PostgreSQL and Auth. Use asymmetric signing keys and a verified issuer, audience and operator UUID allowlist. Use separate DB roles for migration, dispatcher, API and promotion. Use a direct connection or a session-mode pooler with TLS verification. Check `SHOW server_version_num` and the session's `pg_stat_ssl` row with the assigned credentials. Apply the control migrations using the dedicated migrator. [Supabase JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)
2. Provision separate PostgreSQL sandboxes for online and holdout data. Verify the PostgreSQL 16 behavior used by the benchmark, TCP/TLS connectivity and the variant read-only roles. Seed and verify the approved data with the seeder, then provide only runtime maps to the workers. The online deployment must have neither a route nor credentials for the holdout sandbox. Create a distinct PostgreSQL ledger database and login for the holdout job. Apply [the holdout ledger schema](../infra/cloud-run/holdout-ledger.sql) as its schema owner. Use `sslmode=verify-full` and a trusted CA for the ledger connection.
3. Provision managed Redis with TLS, append-only persistence and `noeviction` on the online private network. Verify those settings from the deployment network using the Redis provider's control plane or the permitted Redis inspection commands. Pass a `rediss://` connection URL only to the API and dispatcher.
4. Install the signed-off development and validation artifacts from the benchmark generator. The dispatcher bucket contains split manifests and prompt/fault bundles. The evaluator bucket contains split manifests and oracle bundles. The dispatcher also reads a distinct trusted profile bucket. Mount only the required runtime maps in the runner. Keep the sealed holdout artifacts, runtime map, ledger DSN, provider key and aggregate report bucket restricted to the holdout identity. Review the role plan and grant bucket access at bucket scope and secret access at secret scope. The holdout writes only the aggregate report to the report bucket and keeps per-task results in its restricted ledger.
5. Apply the rendered service definitions with `gcloud run services replace` and the isolated Job definition with `gcloud run jobs replace` after approving the plan. Set `roles/run.invoker` only for the listed private service callers, plus the explicitly authorized operator identity where needed. The API service accepts the Vercel proxy at the network boundary and authenticates the proxy's server-only credential on every versioned route. The remaining HTTP services require Cloud Run IAM plus their application bearer token. The dispatcher uses instance-based CPU, one warm instance and a one-instance limit. Check the advertised service URLs against the configured token audiences before enabling traffic. [Cloud Run YAML](https://docs.cloud.google.com/run/docs/reference/yaml/v1), [service identity](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)
6. Configure the Vercel project with `apps/web` as its root directory, workspace sources included, and Node 22. Set the server-only `HL_API_INTERNAL_URL`, `HL_PROXY_TOKEN`, and `HL_PUBLIC_ORIGIN` in the matching project environment. Deploy the approved revision. Begin with public starts disabled. Check proxy authentication, issuer and audience denials, quotas, and secret rotation before enabling fixture traffic. [Vercel monorepos](https://vercel.com/docs/monorepos)

Cloud Run obtains a target-audience identity token from its metadata service. It sends that token in the platform authentication header and uses the existing application bearer token for internal service and checkpoint checks. The holdout uses a session advisory lock in its dedicated ledger because Cloud Run NFS mounts do not support file locking. [Cloud Run NFS behavior](https://docs.cloud.google.com/run/docs/configuring/services/nfs-volume-mounts)

## Hosted smoke and live checks

Run the hosted fixture smoke during an approved window with the public toggle enabled.

```sh
make smoke-hosted BASE_URL=https://your-harnesslab-host
```

For a live single-task smoke, prepare an owner-only JSON file with the approved dev `ExecuteTaskRequest` under `execute` and its fixed integer-string price profile under `price`. Use a fresh approved run UUID. Supply that path as `HL_LIVE_SMOKE_INPUT`, an absolute owner-only output directory as `HL_LIVE_RESULTS_DIR`, and the authorized private runner and evaluator service URLs, application tokens and audience-specific ID tokens via `HL_LIVE_RUNNER_URL`, `HL_LIVE_RUNNER_TOKEN`, `HL_LIVE_RUNNER_ID_TOKEN` and the equivalent evaluator variables. The command refuses an over-budget task, reserves one effect in the private directory before invoking the worker, and retains that reservation when usage is ambiguous. A repeated invocation of the same smoke UUID is refused.

Build the input from a signed-off development task and the active harness export. Pin the manifest to `mode: live`, `stage: diagnose`, and the deployed evaluator version. Include the task, config, dataset, benchmark, worker profile and price digests. The smoke sets a fresh deadline immediately before dispatch.

```sh
HL_LIVE_AUTHORIZED=1 make live-smoke MAX_SPEND_MICRO_USD=YOUR_APPROVED_LIMIT
```

For a full trial, supply the current operator access token as `HL_OPERATOR_ACCESS_TOKEN`, the same private result directory and a fixed `HL_LIVE_IDEMPOTENCY_KEY`. Reuse that key when resuming polling with a renewed token. The operator reviews the stored report and compares the expected active revision before making a decision.

```sh
HL_LIVE_AUTHORIZED=1 make live-trial BASE_URL=https://your-harnesslab-host \
  MAX_SPEND_MICRO_USD=YOUR_APPROVED_LIMIT
```

Run a release holdout only as its separately authorized job with an explicitly nominated pair, signed-off manifest and approved spend. Resume the same seal through the dedicated ledger. Keep the aggregate and all per-task records private until reviewed.

## Monitoring and recovery

- Probe `/readyz` on the deployed services and alert on failures. Scrape the dispatcher's private `/internal/v1/metrics` with its operations bearer token and an authorized Cloud Run caller. Watch queue depth, oldest queue age, expired leases, recent budget exhaustion, and metered spend on recent experiments.
- Use structured log alerts for `lease_reclaimed` and `review_integrity_denied`. Correlate API errors with the returned request ID and dispatcher lease recovery with its work ID. Use the authorized API to look up experiment and run IDs. Keep bearer tokens, credentials, reference values and internal error details out of logs.
- For stalled work, inspect `hl.work_items` and `hl.outbox` through an authorized operational connection. Preserve pending rows and let the dispatcher reconcile delivery and claim a new fence. A stored envelope can be graded again. Treat a paid call with unknown completion as an ambiguous effect and retain the reservation. Use `make grader-replay` to verify deterministic local replay.
- Checkpoints expire 24 hours after terminal experiments. Immutable run envelopes, reports and decisions have separate retention. Before changing graph versions or rolling back code, pause submission and drain work pinned to the older graph, or keep its compatible runtime available until that work is terminal.
- Back up the control database and the isolated holdout ledger separately. Protect credentials with a libpq service file. Use `pg_dump --format=custom --dbname=service=harnesslab-control-backup` and restore into an isolated rehearsal database. Verify migration checksums, the active channel revision, report digests and row counts before switching traffic. Reconcile Redis from the durable outbox after a restore.
- Rotate the proxy secret on both Vercel and the API, and rotate the paired private service tokens on both ends. Plan a short disabled-submission window if versions cannot overlap. Rotating the session signing key expires existing anonymous sessions. Pin new secret versions in the release inventory and verify the smoke checks.
- Roll back activation through the operator API using the observed channel revision and a reason. The decision advances the revision and affects future submissions. For a code rollback, select the previous pinned Vercel and Cloud Run revisions after checking in-flight compatibility. Keep database history and migration checksums intact.
