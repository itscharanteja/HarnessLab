from hashlib import sha256

import rfc8785


def digest(value: object) -> str:
    return sha256(rfc8785.dumps(value)).hexdigest()


def trace_digest(events: list[dict]) -> str:
    replay = [
        {key: value for key, value in event.items() if key not in {"run_id", "elapsed_ms"}}
        for event in events
    ]
    for event in replay:
        if event["kind"] == "model_usage":
            event["payload"] = {"input_tokens": 0, "output_tokens": 0, "request_id": None}
    return digest(replay)
