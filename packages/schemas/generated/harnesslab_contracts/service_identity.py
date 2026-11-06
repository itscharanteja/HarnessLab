import json
import os
import re
from base64 import urlsafe_b64decode
from time import time
from urllib.parse import urlsplit

import httpx

METADATA = (
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity"
)
CACHE: dict[str, tuple[str, int]] = {}


async def service_identity(target: str) -> dict[str, str]:
    if os.environ.get("HL_CLOUD_RUN_IDENTITY") != "1":
        return {}
    url = urlsplit(target)
    if (
        url.scheme != "https"
        or not url.hostname
        or not url.hostname.endswith(".run.app")
        or url.hostname != url.netloc
    ):
        raise ValueError("invalid_service_identity_audience")
    audience = f"https://{url.hostname}"
    token, expires = CACHE.get(audience, ("", 0))
    if expires <= time() + 60:
        async with httpx.AsyncClient(timeout=2.5, trust_env=False) as client:
            response = await client.get(
                METADATA, params={"audience": audience}, headers={"Metadata-Flavor": "Google"}
            )
            response.raise_for_status()
            token = response.text
        if len(token) > 8192 or not re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}", token):
            raise ValueError("invalid_service_identity")
        payload = token.split(".")[1]
        claims = json.loads(urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        expires = claims.get("exp")
        if claims.get("aud") != audience or type(expires) is not int or expires <= time() + 60:
            raise ValueError("invalid_service_identity")
        CACHE[audience] = (token, expires)
    return {"X-Serverless-Authorization": f"Bearer {token}"}
