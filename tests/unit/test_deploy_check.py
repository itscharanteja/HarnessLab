import asyncio
import json
from base64 import urlsafe_b64encode
from copy import deepcopy
from pathlib import Path
from time import time

import httpx
import pytest
from harnesslab_contracts import service_identity as identity

from scripts.deploy_check import manifests, validate
from scripts.live_checks import approved_cap


def fixture():
    return json.loads(Path("infra/cloud-run/fixture.example.json").read_text())


def test_deployment_plan_pins_images_and_separates_credentials():
    config = fixture()
    validate(config, "fixture")
    resources, roles = manifests(config)
    revision = resources["dispatcher"]["spec"]["template"]["metadata"]["annotations"]
    assert revision["run.googleapis.com/cpu-throttling"] == "false"
    service = resources["dispatcher"]["metadata"]["annotations"]
    assert service["run.googleapis.com/minScale"] == service["run.googleapis.com/maxScale"] == "1"
    assert resources["holdout"]["kind"] == "Job"
    assert roles["holdout"]["invokers"] == []
    assert set(roles["holdout"]["secret_accessor"]).isdisjoint(
        secret
        for name, role in roles.items()
        if name != "holdout"
        for secret in role["secret_accessor"]
    )
    assert roles["evaluator"]["artifact_reader"] == ["hl-example-references"]
    assert roles["optimizer"]["artifact_reader"] == []
    assert config["services"]["api"]["account"] in roles["dispatcher"]["invokers"]


def test_preflight_refuses_floating_or_shared_images_and_unapproved_live():
    config = fixture()
    bad = deepcopy(config)
    bad["services"]["runner"]["image"] = (
        bad["services"]["runner"]["image"].split("@")[0] + ":latest"
    )
    with pytest.raises(ValueError, match="unpinned_runner_image"):
        validate(bad, "fixture")
    bad = deepcopy(config)
    bad["buckets"]["holdout"] = bad["buckets"]["references"]
    with pytest.raises(ValueError, match="artifact_bucket_isolation"):
        validate(bad, "fixture")
    bad = deepcopy(config)
    bad["release"]["mode"] = "live"
    with pytest.raises(ValueError, match="invalid_release_budget"):
        validate(bad, "fixture")


def test_live_command_needs_explicit_authorization_and_positive_cap(monkeypatch):
    monkeypatch.delenv("HL_LIVE_AUTHORIZED", raising=False)
    monkeypatch.setenv("MAX_SPEND_MICRO_USD", "500")
    with pytest.raises(ValueError, match="explicit_live_authorization"):
        approved_cap()
    monkeypatch.setenv("HL_LIVE_AUTHORIZED", "1")
    assert approved_cap() == 500


def test_python_cloud_identity_uses_the_checkpoint_service_audience(monkeypatch):
    monkeypatch.setenv("HL_CLOUD_RUN_IDENTITY", "1")
    audience = "https://fixture-dispatcher.a.run.app"
    payload = (
        urlsafe_b64encode(json.dumps({"aud": audience, "exp": int(time()) + 300}).encode())
        .decode()
        .rstrip("=")
    )
    token = f"eyJ9.{payload}.sig"
    requests = []

    def transport(request):
        assert request.url.host == "metadata.google.internal"
        assert request.url.params["audience"] == audience
        assert request.headers["metadata-flavor"] == "Google"
        requests.append(request)
        return httpx.Response(200, text=token)

    original = httpx.AsyncClient
    monkeypatch.setattr(identity, "CACHE", {})
    monkeypatch.setattr(
        identity.httpx,
        "AsyncClient",
        lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(transport)),
    )

    async def check():
        for _ in range(2):
            assert await identity.service_identity(audience + "/internal/v1/checkpoint") == {
                "X-Serverless-Authorization": f"Bearer {token}"
            }

    asyncio.run(check())
    assert len(requests) == 1


def test_live_smoke_lost_response_keeps_the_effect_marker(benchmark_request, tmp_path, monkeypatch):
    from harnesslab_contracts.replay import digest

    from scripts import live_checks

    request = benchmark_request()
    request["manifest"]["mode"] = "live"
    price = {"input": "1000000", "output": "1000000"}
    request["manifest"]["price_profile_digest"] = digest(price)
    monkeypatch.setenv("HL_LIVE_SMOKE_INPUT", str(tmp_path / "approved.json"))
    (tmp_path / "approved.json").write_text(json.dumps({"execute": request, "price": price}))
    attempts = []

    def lost(*args):
        attempts.append(args[1])
        raise httpx.ConnectError("lost response")

    monkeypatch.setattr(live_checks, "service", lost)
    with pytest.raises(httpx.ConnectError):
        live_checks.smoke(None, 15000, tmp_path)
    with pytest.raises(FileExistsError):
        live_checks.smoke(None, 15000, tmp_path)
    assert attempts == ["runner"]
    marker = tmp_path / f"{request['manifest']['run_id']}.effect.json"
    assert json.loads(marker.read_text())["reserve_microusd"] == 15000
