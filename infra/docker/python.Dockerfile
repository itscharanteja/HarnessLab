FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS build
ARG SERVICE_PATH
ARG SERVICE_PACKAGE
WORKDIR /workspace
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy
RUN pip install --no-cache-dir uv==0.13.7
COPY pyproject.toml uv.lock .python-version ./
COPY packages/schemas/generated/ packages/schemas/generated/
COPY services/agent-runner/pyproject.toml services/agent-runner/
COPY services/dataops-mcp/pyproject.toml services/dataops-mcp/
COPY services/evaluator/pyproject.toml services/evaluator/
COPY services/optimizer/pyproject.toml services/optimizer/
COPY services/dataops-mcp/src/harnesslab_mcp/ services/dataops-mcp/src/harnesslab_mcp/
COPY services/${SERVICE_PATH}/src/ services/${SERVICE_PATH}/src/
RUN uv sync --locked --no-dev --no-editable --package "$SERVICE_PACKAGE"

FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS runtime
COPY --from=build /workspace/.venv /workspace/.venv
ENV PATH=/workspace/.venv/bin:$PATH PYTHONUNBUFFERED=1
USER 65534:65534

FROM runtime AS runner
COPY datasets/synthetic-business/metrics.json /workspace/metric-catalog.json
ENV HL_METRIC_CATALOG=/workspace/metric-catalog.json

FROM build AS holdout-build
COPY services/evaluator/src/harnesslab_eval/ services/evaluator/src/harnesslab_eval/
RUN uv sync --locked --no-dev --no-editable --package harnesslab-runner --package harnesslab-eval

FROM runtime AS holdout
WORKDIR /workspace
COPY --from=holdout-build /workspace/.venv /workspace/.venv
COPY datasets/synthetic-business/metrics.json /workspace/datasets/synthetic-business/metrics.json
COPY scripts/holdout_job.py scripts/holdout_ledger.py /workspace/scripts/
ENTRYPOINT ["python", "-m", "scripts.holdout_job"]
