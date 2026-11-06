import os
from uuid import uuid4

import httpx


def urls():
    origin = f"http://localhost:{os.environ.get('WEB_PORT', '3000')}"
    proxy = f"http://127.0.0.1:{os.environ.get('WEB_PORT', '3000')}/api/v1"
    direct = f"http://127.0.0.1:{os.environ.get('API_PORT', '4000')}/v1"
    return origin, proxy, direct


def test_proxy_strips_identity_headers_and_rejects_bad_credentials():
    _, proxy, direct = urls()
    claimed = {"x-hl-operator": "true", "x-hl-principal": f"operator:{uuid4()}"}
    response = httpx.get(direct + "/experiments", headers=claimed)
    assert response.status_code == 401
    assert response.json()["code"] == "proxy_required"
    assert set(response.json()) == {"code", "message", "request_id"}
    response = httpx.get(proxy + "/experiments", headers={**claimed, "x-hl-proxy-token": "forged"})
    assert response.status_code == 200
    assert response.json() == {"items": [], "next_cursor": None} or all(
        row["scope"] in {"demo_fixture", "full_live"} for row in response.json()["items"]
    )
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=Lax" in cookie
    assert response.headers["cache-control"] == "no-store"
    response = httpx.get(proxy + "/experiments", headers={"authorization": "Bearer forged"})
    assert response.status_code == 401
    assert response.json()["code"] == "invalid_token"


def test_mutations_reject_cross_origin_unbounded_bodies_and_public_live_dispatch():
    origin, proxy, _ = urls()
    request = {"scope": "full_live", "max_spend_microusd": 1}
    headers = {"origin": origin, "idempotency-key": str(uuid4())}
    forged = {**headers, "x-hl-operator": "true", "x-hl-user-id": str(uuid4())}
    response = httpx.post(proxy + "/experiments", headers=forged, json=request)
    assert response.status_code == 401
    assert response.json()["code"] == "operator_required"
    response = httpx.post(
        proxy + "/experiments",
        headers={**headers, "origin": "https://invalid.example"},
        json={"scope": "demo_fixture"},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "origin_forbidden"
    response = httpx.post(
        proxy + "/experiments",
        headers={**headers, "content-type": "application/json"},
        content=b'{"scope":"' + b"x" * 17000 + b'"}',
    )
    assert response.status_code == 400
    response = httpx.post(
        proxy + "/experiments",
        headers=headers,
        json={"scope": "demo_fixture", "sql": "select 1"},
    )
    assert response.status_code == 400
    response = httpx.post(
        proxy + "/experiments",
        headers={**headers, "authorization": "Bearer fixture-local-operator-token-00000001"},
        json=request,
    )
    assert response.status_code == 403
    assert response.json()["code"] == "live_disabled"
    response = httpx.post(
        proxy + "/channels/production/rollback",
        headers=forged,
        json={"expected_revision": 1, "reason": "Attempt from anonymous client"},
    )
    assert response.status_code == 401
