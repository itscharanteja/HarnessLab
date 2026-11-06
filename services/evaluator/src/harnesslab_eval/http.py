from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from harnesslab_contracts.contracts import HealthResponse
from harnesslab_contracts.internal import InternalError, internal_request
from harnesslab_contracts.validate import accepts

from .artifacts import reference_for
from .grader import grade_run

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
@app.get("/readyz")
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@app.post("/internal/v1/grade-task")
async def grade_task(request: Request):
    try:
        payload = await internal_request(request, "GradeTaskRequest")
        run = payload["run"]
        result = grade_run(run, reference_for(run))
        if not accepts("GradeTaskResponse", result):
            raise ValueError("Invalid grade")
        return result
    except InternalError as exc:
        return JSONResponse({"code": exc.code}, status_code=exc.status)
    except (ValueError, TypeError, ArithmeticError):
        return JSONResponse({"code": "invalid_envelope"}, status_code=422)
