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
