#!/bin/sh
set -eu

output=${1:-packages/schemas/generated}
mkdir -p "$output"
corepack pnpm contracts:generate "$output/contracts.ts"
if [ "$output" = packages/schemas/generated ]; then
    output="$output/harnesslab_contracts"
fi
cp packages/schemas/contracts/v1.json "$output/v1.json"
uv run --locked datamodel-codegen \
    --input packages/schemas/contracts/v1.json \
    --input-file-type jsonschema \
    --output "$output/contracts.py" \
    --output-model-type pydantic_v2.BaseModel \
    --target-python-version 3.12 \
    --use-union-operator \
    --use-standard-collections \
    --strict-types str int bool \
    --use-annotated \
    --formatters builtin \
    --disable-timestamp
