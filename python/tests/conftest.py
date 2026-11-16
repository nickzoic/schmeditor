import json
from pathlib import Path

import pytest

EXAMPLES = Path(__file__).resolve().parents[2] / "examples"


def _load(name):
    with open(EXAMPLES / name, encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture()
def contact_schema():
    return _load("contact.schema.json")


@pytest.fixture()
def contact_doc():
    return _load("contact.json")


@pytest.fixture()
def metaschema():
    return _load("editor-metaschema.json")
