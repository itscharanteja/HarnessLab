# Implementation evidence

## Phase 0 — Local fixture foundation

The workspace started with the two root instruction files. Phase 0 uses Node 22.23.4, pnpm 10.34.9, Python 3.12.16 and uv 0.13.7. Fixture checks ran on 2026-11-06 without a model account or provider requests.

| Check                                                          | Outcome                                                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make bootstrap`                                               | Exit 0 from a clean source copy with frozen pnpm and uv locks                                                                                                                          |
| `make infra-up`                                                | Exit 0. All nine services healthy. Separate PostgreSQL 16.15 instances accepted the local migrator and seed roles on loopback. Redis append-only persistence and `noeviction` verified |
| `make contracts-check`                                         | Exit 0. Regenerated files matched. Both validators agreed on all 38 shared vectors, and Python also checked the schema against its meta-schema                                         |
| `make lint`                                                    | Exit 0 with ESLint, Prettier and Ruff                                                                                                                                                  |
| `make typecheck`                                               | Exit 0 across all six TypeScript workspaces                                                                                                                                            |
| `corepack pnpm test` and `uv run --locked pytest -q`           | Exit 0 with 39 TypeScript tests and 42 Python tests                                                                                                                                    |
| `corepack pnpm build` and `corepack pnpm exec playwright test` | Exit 0. Next.js production build and one Chromium shell smoke test                                                                                                                     |

The JSON Schema validators enforce wire constraints such as canonical UUID and UTC timestamp syntax. The generated Pydantic types map those fields to native UUID and datetime values. Validate payloads against the schema before decoding them.

Hosted credentials and live spend authorization are outside the Phase 0 checks.

## Phase 1 — Synthetic benchmark fixtures

The local corpus contains 120 tasks across 12 variants, with exactly 60 development, 30 validation and 30 holdout tasks. The holdout fixture runs against a separate PostgreSQL instance and seed identity. This evidence concerns generated fixtures only.

| Check                                               | Outcome                                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make benchmark-generate MODE=fixture`              | Exit 0. Independent PostgreSQL and Python references agreed on all 120 tasks                                                                                                                                                     |
| `make benchmark-seed MODE=fixture`                  | Exit 0. All 12 variants loaded from empty schemas and received variant-scoped reader roles                                                                                                                                       |
| `make benchmark-verify MODE=fixture`                | Exit 0. Database rows, prompt replay and references matched the recorded digests                                                                                                                                                 |
| `uv run pytest tests/integration/test_benchmark.py` | Exit 0. Six tests covered split counts, byte-identical regeneration, role restrictions and online image isolation                                                                                                                |
| `make lint` and `uv run --locked pytest -q`         | Exit 0. The final Python run passed 48 tests with default fixture DSNs                                                                                                                                                           |
| Release benchmark generation with disposable seeds  | Both commands exited 0 against separate local databases. The first subsequent suite inherited the holdout seed DSN and failed two online replay tests. Unsetting the override restored the fixture defaults and the suite passed |

The development prompts, manifest and references are in source. The release artifact checkbox remains open pending a private release seed source and restricted destination for the real validation and holdout bundles. The public validation manifest requires the resulting signed-off release digest. Reproduce the local dry-run using the release generation commands in the README, owner-only disposable seed files and the corresponding local seed DSN scoped to each command.
