import os
import time
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import httpx


def main():
    base = os.environ.get(
        "HL_WEB_BASE_URL", f"http://localhost:{os.environ.get('WEB_PORT', '3000')}"
    )
    parts = urlsplit(base)
    if parts.scheme not in {"http", "https"} or not parts.netloc or parts.path not in {"", "/"}:
        raise SystemExit("Use a site origin for HL_WEB_BASE_URL")
    origin = f"{parts.scheme}://{parts.netloc}"
    with httpx.Client(base_url=origin, timeout=8) as client:
        try:
            client.get("/api/v1/experiments?limit=1").raise_for_status()
            started = client.post(
                "/api/v1/experiments",
                json={"scope": "demo_fixture"},
                headers={"Origin": origin, "Idempotency-Key": str(uuid4())},
            )
            started.raise_for_status()
            experiment = started.json()["id"]
            path = f"/api/v1/experiments/{experiment}"
            deadline = time.monotonic() + 130
            while time.monotonic() < deadline:
                state = client.get(path)
                state.raise_for_status()
                data = state.json()["experiment"]
                if data["mode"] != "fixture":
                    raise SystemExit("Unexpected experiment mode")
                if data["status"] in {"completed", "failed", "cancelled"}:
                    if data["status"] != "completed":
                        raise SystemExit(f"Fixture experiment ended as {data['status']}")
                    report = client.get(path + "/comparisons")
                    report.raise_for_status()
                    reports = report.json()["items"]
                    if not reports or any(
                        row["mode"] != "fixture" or row["winner"] for row in reports
                    ):
                        raise SystemExit("Fixture comparison unavailable")
                    break
                time.sleep(2)
            else:
                raise SystemExit("Fixture experiment exceeded its wait limit")
            os.umask(0o077)
            directory = Path(".artifacts")
            directory.mkdir(mode=0o700, exist_ok=True)
            artifact = directory / f"demo-{experiment}.json"
            artifact.write_text(report.text + "\n")
        except httpx.HTTPStatusError as error:
            code = error.response.json().get("code", "request_failed")
            raise SystemExit(
                f"Fixture request failed ({error.response.status_code}, {code})"
            ) from None
        except (httpx.RequestError, ValueError, KeyError) as error:
            raise SystemExit(f"Fixture request failed ({type(error).__name__})") from None
    print(f"Fixture model · Development only · {len(reports)} comparisons")
    print(f"Private local report: {artifact}")
    print(origin + f"/experiments/{experiment}/compare")


if __name__ == "__main__":
    main()
