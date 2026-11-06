SHELL := /bin/sh
PNPM := corepack pnpm
COMPOSE := docker compose --file infra/docker/compose.yaml
.DEFAULT_GOAL := bootstrap

.PHONY: bootstrap infra-up contracts-check lint typecheck
bootstrap:
	@node -e 'if (process.version !== "v" + require("fs").readFileSync(".node-version", "utf8").trim()) process.exitCode = 1' || { echo "Use the Node version in .node-version"; exit 1; }
	$(PNPM) install --frozen-lockfile
	uv sync --locked --all-packages

infra-up:
	mkdir -p -m 700 .artifacts/online-fixture
	mkdir -p .artifacts/online-fixture/dispatcher .artifacts/online-fixture/runner .artifacts/online-fixture/evaluator
	$(COMPOSE) up --detach --build --wait --wait-timeout 120

contracts-check:
	./scripts/check-contracts.sh
	$(PNPM) exec vitest run tests/unit/contracts.test.ts
	uv run --locked pytest -q tests/unit/test_contracts.py

lint:
	$(PNPM) lint
	uv run --locked ruff check .
	uv run --locked ruff format --check .

typecheck:
	$(PNPM) typecheck

MODE ?= fixture
export MODE SPLIT SEED_FILE OUT_DIR

.PHONY: benchmark-generate benchmark-seed benchmark-verify
benchmark-generate:
	@if [ "$$MODE" = fixture ] && { [ -z "$$SPLIT" ] || [ "$$SPLIT" = holdout ]; }; then \
		$(COMPOSE) --profile holdout-fixture up --detach --wait holdout-db; \
	fi
	uv run --locked python -m benchmarks.generators.cli generate

benchmark-seed:
	uv run --locked python -m benchmarks.generators.cli seed

benchmark-verify:
	uv run --locked python -m benchmarks.generators.cli verify

.PHONY: config-check run-fixture
config-check:
	uv run --locked python -m harnesslab_runner.fixture config-check

run-fixture:
	@uv run --locked python -m harnesslab_runner.fixture run

.PHONY: db-migrate phase3-artifacts grader-replay test-integration test-security
db-migrate:
	uv run --locked python scripts/db_migrate.py

phase3-artifacts:
	uv run --locked python scripts/phase3_artifacts.py

grader-replay:
	uv run --locked pytest -q tests/regression/test_grader.py

test-integration:
	uv run --locked pytest -q tests/integration

test-security:
	uv run --locked pytest -q tests/security

.PHONY: dispatch-fixture
dispatch-fixture:
	$(COMPOSE) exec -T dispatcher node apps/dispatcher/src/cli.ts

.PHONY: optimize-fixture
optimize-fixture:
	$(COMPOSE) exec -T dispatcher node apps/dispatcher/src/cli.ts --trial

.PHONY: gates-check holdout-run
gates-check:
	uv run --locked pytest -q tests/regression/test_gates.py

holdout-run:
	uv run --locked python -m scripts.holdout_job --mode "$(MODE)" $(HOLDOUT_ARGS)

.PHONY: api-check
api-check:
	@set -eu; \
	previous=$$($(COMPOSE) exec -T api printenv HL_PUBLIC_RUNS); \
	trap 'HL_PUBLIC_RUNS="$$previous" $(COMPOSE) up --detach --no-build --wait api dispatcher web' EXIT; \
	HL_PUBLIC_RUNS=1 $(COMPOSE) up --detach --no-build --wait api dispatcher web; \
	HL_API_CHECK=1 uv run --locked pytest -q tests/integration/test_api.py tests/security/test_api_access.py

.PHONY: dev demo-fixture test-e2e
dev:
	HL_PUBLIC_RUNS=1 $(MAKE) infra-up
	$(MAKE) db-migrate MODE=fixture
	@if [ ! -s .artifacts/benchmark-fixture/.runtime/dev.json ] || \
	    [ ! -s .artifacts/benchmark-fixture/.runtime/validation.json ]; then \
		$(MAKE) benchmark-generate benchmark-seed MODE=fixture; \
	fi
	$(MAKE) phase3-artifacts

demo-fixture:
	uv run --locked python scripts/demo_fixture.py

test-e2e:
	HL_E2E_BASE_URL="$${HL_E2E_BASE_URL:-http://localhost:$${WEB_PORT:-3000}}" $(PNPM) exec playwright test

.PHONY: ci deploy-check smoke-hosted live-smoke live-trial
ci:
	$(MAKE) bootstrap
	@if [ "$${HL_CI_REUSE_IMAGES:-0}" = 1 ]; then \
		$(COMPOSE) up --detach --no-build --wait --wait-timeout 120; \
	else \
		$(MAKE) infra-up; \
	fi
	$(MAKE) contracts-check lint typecheck
	$(PNPM) test
	$(MAKE) benchmark-generate benchmark-seed benchmark-verify MODE=fixture
	$(MAKE) db-migrate phase3-artifacts grader-replay MODE=fixture
	$(MAKE) config-check run-fixture gates-check holdout-run MODE=fixture
	$(MAKE) api-check
	uv run --locked pytest -q
	$(PNPM) build
	@if [ "$${CI_BROWSER_SETUP:-0}" = 1 ]; then $(PNPM) exec playwright install --with-deps chromium; fi
	@set -eu; \
	previous=$$($(COMPOSE) exec -T api printenv HL_PUBLIC_RUNS); \
	trap 'HL_PUBLIC_RUNS="$$previous" $(COMPOSE) up --detach --no-build --wait api dispatcher web' EXIT; \
	HL_PUBLIC_RUNS=1 $(COMPOSE) up --detach --no-build --wait api dispatcher web; \
	$(MAKE) demo-fixture test-e2e

ENV ?= staging
deploy-check:
	uv run --locked python -m scripts.deploy_check --env "$(ENV)" \
		$(if $(DEPLOY_CONFIG),--config "$(DEPLOY_CONFIG)") \
		$(if $(DEPLOY_OUTPUT),--output "$(DEPLOY_OUTPUT)") \
		$(if $(filter 1,$(VERIFY_REMOTE)),--verify-remote)

export BASE_URL MAX_SPEND_MICRO_USD
smoke-hosted:
	uv run --locked python -m scripts.hosted_smoke

live-smoke:
	uv run --locked python -m scripts.live_checks smoke

live-trial:
	uv run --locked python -m scripts.live_checks trial
