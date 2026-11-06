from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256

import rfc8785
from harnesslab_contracts.validate import accepts
from ruamel.yaml import YAML, YAMLError
from ruamel.yaml.events import AliasEvent


def json_types(value: object) -> bool:
    if type(value) in {str, int, bool, type(None)}:
        return True
    if type(value) is list:
        return all(json_types(child) for child in value)
    if type(value) is dict:
        return all(type(key) is str and key != "<<" and json_types(v) for key, v in value.items())
    return False


def digest(value: object) -> str:
    return sha256(rfc8785.dumps(value)).hexdigest()


@dataclass(frozen=True)
class Harness:
    config: dict
    yaml_bytes: bytes
    canonical: bytes
    content_hash: str


def read_harness(source: bytes) -> Harness:
    if len(source) > 16 * 1024:
        raise ValueError("Harness YAML exceeds 16 KiB")
    yaml = YAML(typ="safe", pure=True)
    yaml.allow_duplicate_keys = False
    try:
        text = source.decode("utf-8")
        for event in yaml.parse(text):
            if (
                isinstance(event, AliasEvent)
                or getattr(event, "anchor", None) is not None
                or getattr(event, "tag", None) is not None
                or getattr(event, "value", None) == "<<"
                and getattr(event, "style", None) is None
            ):
                raise ValueError("Unsupported YAML feature")
        config = yaml.load(text)
    except (YAMLError, UnicodeError, ValueError, RecursionError):
        raise ValueError("Invalid harness YAML") from None
    if not json_types(config) or not accepts("HarnessConfig", config):
        raise ValueError("Invalid harness config")
    canonical = rfc8785.dumps(config)
    return Harness(config, source, canonical, sha256(canonical).hexdigest())


def apply_patch(parent: dict, operations: list[dict]) -> dict:
    if not accepts("HarnessConfig", parent) or not json_types(parent):
        raise ValueError("Invalid parent config")
    if type(operations) is not list or not 1 <= len(operations) <= 2:
        raise ValueError("Expected one or two replacements")
    merged = deepcopy(parent)
    paths = set()
    for op in operations:
        if not json_types(op) or not accepts("PatchOperation", op) or op["path"] in paths:
            raise ValueError("Invalid replacement")
        paths.add(op["path"])
        _, section, key = op["path"].split("/")
        if merged[section][key] == op["value"]:
            raise ValueError("No-op replacement")
        merged[section][key] = op["value"]
    if not accepts("HarnessConfig", merged):
        raise ValueError("Invalid patched config")
    return merged
