import json
from importlib.resources import files

from jsonschema import Draft202012Validator

_schema = json.loads(files("harnesslab_contracts").joinpath("v1.json").read_text(encoding="utf-8"))
_validator = Draft202012Validator(_schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def accepts(name: str, payload: object) -> bool:
    if name not in _schema["$defs"]:
        raise ValueError(f"Unknown v1 contract {name}")
    return _validator.evolve(schema={"$ref": f"#/$defs/{name}"}).is_valid(payload)


def definition(name: str) -> dict:
    """Return the named contract with its local references expanded."""

    def expand(value):
        if isinstance(value, dict):
            if "$ref" in value:
                return expand(_schema["$defs"][value["$ref"].removeprefix("#/$defs/")])
            return {key: expand(child) for key, child in value.items()}
        if isinstance(value, list):
            return [expand(child) for child in value]
        return value

    return expand(_schema["$defs"][name])
