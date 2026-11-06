#!/bin/sh
set -eu

scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM

./scripts/generate-contracts.sh "$scratch"
diff -u packages/schemas/generated/contracts.ts "$scratch/contracts.ts"
diff -u packages/schemas/generated/harnesslab_contracts/contracts.py "$scratch/contracts.py"
cmp packages/schemas/generated/harnesslab_contracts/v1.json "$scratch/v1.json"
