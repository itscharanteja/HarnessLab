import json
from pathlib import Path

import pytest
from harnesslab_contracts import contracts
from harnesslab_contracts.validate import accepts
from jsonschema import Draft202012Validator

SCHEMAS = Path(__file__).resolve().parents[2] / "packages" / "schemas" / "contracts"
VECTORS = json.loads((SCHEMAS / "examples.json").read_text(encoding="utf-8"))


def test_schema_conforms_to_its_meta_schema():
    Draft202012Validator.check_schema(json.loads((SCHEMAS / "v1.json").read_text(encoding="utf-8")))


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: f"{v['contract']}: {v['label']}")
def test_contract_vector(vector):
    name = vector["contract"]
    assert accepts(name, vector["payload"]) is vector["valid"]
    if vector["valid"]:
        getattr(contracts, name).model_validate(vector["payload"])
