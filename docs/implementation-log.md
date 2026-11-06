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
