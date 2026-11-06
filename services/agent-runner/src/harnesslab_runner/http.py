import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from harnesslab_contracts.checkpoint import Checkpoint
from harnesslab_contracts.contracts import HealthResponse
from harnesslab_contracts.internal import InternalError, internal_request, read_json
from harnesslab_contracts.replay import digest
from harnesslab_contracts.validate import accepts

from .fixture import OrderCountFixture
from .graph import execute, validate_request
from .model import OpenAITurns
from .trial_fixture import TrialFixture

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
@app.get("/readyz")
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/internal/v1/execute-task")
async def execute_task(request: Request):
    try:
        payload = await internal_request(request, "ExecuteTaskRequest")
        validate_request(payload)
        task, manifest = payload["task"], payload["manifest"]
        mode = manifest["mode"]
        if mode == "live" and os.environ.get("HL_MODE") != "live":
            raise InternalError(403, "mode_disabled")
        checkpoint = Checkpoint.for_request(request, "worker_v1") if mode == "fixture" else None
        identity = digest(payload)
        if checkpoint:
            saved = await checkpoint.exchange("worker_completed")
            if saved:
                if saved["request_digest"] != identity or not accepts(
                    "ExecuteTaskResponse", saved["response"]
                ):
                    raise InternalError(422, "checkpoint_input_mismatch")
                return saved["response"]
        mapping_key = {
            "dev": "HL_SANDBOX_DEV_RUNTIME_MAP_FILE",
            "validation": "HL_SANDBOX_VALIDATION_RUNTIME_MAP_FILE",
        }[task["split"]]
        try:
            dsn = read_json(Path(os.environ[mapping_key]))[task["variant_id"]]
            catalog = Path(os.environ["HL_METRIC_CATALOG"])
            if not catalog.is_file() or not isinstance(dsn, str):
                raise ValueError
        except (KeyError, OSError, ValueError):
            raise InternalError(503, "artifact_unavailable") from None
        events: list[dict] = []
        if mode == "fixture":
            if task["split"] != "dev" or task["category"] not in {
                "efficiency",
                "schema_discovery",
                "tool_failures",
            }:
                raise InternalError(422, "fixture_task_unavailable")
            model = (
                TrialFixture()
                if manifest["software_revision"] == "phase4-trial"
                else OrderCountFixture()
            )
            run = await execute(payload, model, dsn, catalog, graph_events=events)
        else:
            key = os.environ.get("OPENAI_API_KEY")
            if not key:
                raise InternalError(503, "provider_unavailable")
            async with OpenAITurns(manifest["worker"], key) as model:
                run = await execute(payload, model, dsn, catalog, graph_events=events)
        response = {
            "schema_version": 1,
            "run": run,
            "graph": {
                "schema_version": 1,
                "graph_kind": "worker",
                "graph_version": "worker_v1",
                "events": events,
            },
        }
        if not accepts("ExecuteTaskResponse", response):
            raise InternalError(500, "invalid_result")
        if checkpoint and run["result"] != "infrastructure_error":
            await checkpoint.write_bounded(
                "worker_completed",
                {
                    "request_digest": identity,
                    "response": response,
                },
            )
        return response
    except InternalError as exc:
        return JSONResponse({"code": exc.code}, status_code=exc.status)
    except (ValueError, TypeError, ArithmeticError):
        return JSONResponse({"code": "invalid_request"}, status_code=422)
