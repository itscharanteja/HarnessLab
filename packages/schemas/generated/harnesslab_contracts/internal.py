import json
import os
import re
from hmac import compare_digest
from pathlib import Path

from .validate import accepts

MAX_BODY = 2 * 1024 * 1024
SECRET = re.compile(r"postgres(?:ql)?://|\bpassword\s*=|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}", re.I)


class InternalError(ValueError):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status, self.code = status, code


def private_data(value: object) -> bool:
    return bool(SECRET.search(json.dumps(value, ensure_ascii=False)))


def read_json(path: Path):
    with path.open("rb") as source:
        data = source.read(MAX_BODY + 1)
    if len(data) > MAX_BODY:
        raise ValueError("Artifact exceeds byte limit")
    return json.loads(data)


async def internal_request(request, contract: str):
    token = os.environ.get("HL_DISPATCHER_TOKEN")
    supplied = request.headers.get("authorization", "").encode()
    if not token or not compare_digest(supplied, f"Bearer {token}".encode()):
        raise InternalError(401, "unauthorized")
    payload = bytearray()
    async for chunk in request.stream():
        payload.extend(chunk)
        if len(payload) > MAX_BODY:
            raise InternalError(413, "payload_too_large")
    try:
        data = json.loads(payload)
        if not accepts(contract, data):
            raise ValueError
    except (ValueError, RecursionError):
        raise InternalError(400, "invalid_request") from None
    return data
