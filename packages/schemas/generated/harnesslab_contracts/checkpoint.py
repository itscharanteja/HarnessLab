import json
import os
from dataclasses import dataclass

import httpx

from .internal import InternalError
from .service_identity import service_identity
from .validate import accepts


@dataclass(frozen=True)
class Checkpoint:
    url: str
    token: str
    lease_token: str
    work_id: str
    fence: int
    version: str

    @classmethod
    def for_request(cls, request, version: str):
        url = os.environ.get("HL_CHECKPOINT_URL")
        token = os.environ.get("HL_CHECKPOINT_TOKEN")
        work_id = request.headers.get("x-hl-work-id")
        if not url or not token or not work_id:
            return None
        lease = request.headers.get("x-hl-lease-token")
        try:
            fence = int(request.headers.get("x-hl-fence", ""))
        except ValueError:
            raise InternalError(400, "invalid_lease") from None
        if not accepts("Uuid", work_id) or not accepts("Uuid", lease) or fence < 1:
            raise InternalError(400, "invalid_lease")
        return cls(url, token, lease, work_id, fence, version)

    async def exchange(self, key: str, state=None):
        body = {
            "schema_version": 1,
            "work_id": self.work_id,
            "fence": self.fence,
            "graph_version": self.version,
            "state_version": 1,
            "operation": "read" if state is None else "write",
            "seq": 0,
            "write_key": key,
            "state": state,
        }
        if not accepts("CheckpointRequest", body):
            raise InternalError(503, "checkpoint_invalid")
        try:
            async with httpx.AsyncClient(timeout=4, trust_env=False) as client:
                response = await client.post(
                    self.url,
                    json=body,
                    headers={
                        "authorization": f"Bearer {self.token}",
                        "x-hl-lease-token": self.lease_token,
                        **await service_identity(self.url),
                    },
                )
                response.raise_for_status()
                result = response.json()
                if not accepts("CheckpointResponse", result):
                    raise ValueError
                return result["state"]
        except (ValueError, httpx.HTTPError):
            raise InternalError(503, "checkpoint_unavailable") from None

    async def write_bounded(self, key: str, state: dict):
        if len(json.dumps(state, ensure_ascii=False).encode()) <= 450_000:
            await self.exchange(key, state)
