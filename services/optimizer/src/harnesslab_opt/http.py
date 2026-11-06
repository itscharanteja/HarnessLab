import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from harnesslab_contracts.checkpoint import Checkpoint
from harnesslab_contracts.contracts import HealthResponse
from harnesslab_contracts.internal import InternalError, internal_request

from .graph import optimize
from .live import live_proposer

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
@app.get("/readyz")
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/internal/v1/propose")
async def propose(request: Request):
    try:
        payload = await internal_request(request, "OptimizeRequest")
        if payload["mode"] == "live":
            key = os.environ.get("OPENAI_API_KEY")
            if os.environ.get("HL_MODE") != "live" or not key:
                raise InternalError(403, "mode_disabled")
            return await optimize(payload, live_proposer(payload["model"], key))
        if payload["model"] is not None:
            raise ValueError("fixture_model_mismatch")
        return await optimize(payload, checkpoint=Checkpoint.for_request(request, "optimizer_v1"))
    except InternalError as exc:
        return JSONResponse({"code": exc.code}, status_code=exc.status)
    except (ValueError, KeyError, TypeError):
        return JSONResponse({"code": "invalid_optimizer_input"}, status_code=422)
    except Exception:
        return JSONResponse({"code": "optimizer_unavailable"}, status_code=503)
