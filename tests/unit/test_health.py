import pytest
from fastapi.testclient import TestClient
from harnesslab_eval.http import app as evaluator
from harnesslab_opt.http import app as optimizer
from harnesslab_runner.http import app as runner


@pytest.mark.parametrize("app", [runner, evaluator, optimizer])
def test_private_http_service_probes(app):
    with TestClient(app) as client:
        assert client.get("/healthz").json() == {"status": "ok"}
        assert client.get("/readyz").json() == {"status": "ok"}
        assert client.get("/openapi.json").status_code == 404
