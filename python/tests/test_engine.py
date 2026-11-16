"""Validation, interpretation and defaults: no UI involved."""
import pytest

from schmeditor import SchemaEditor, SchemaEngine
from schmeditor.engine import deep_equal, type_of


def errors(schema, value):
    return sorted(e["keyword"] for e in SchemaEngine(schema).validate_value(value))


def test_examples_are_valid(contact_schema, contact_doc, metaschema):
    assert SchemaEngine(contact_schema).validate_value(contact_doc) == []
    assert SchemaEngine(metaschema).validate_value(contact_schema) == []
    assert SchemaEngine(metaschema).validate_value(metaschema) == []


def test_default_documents(contact_schema, metaschema):
    assert SchemaEditor(contact_schema).get_document() == {"name": "Unnamed", "tags": ["x"]}
    assert SchemaEditor(metaschema).get_document() == {"type": "string"}


@pytest.mark.parametrize("schema, value, expected", [
    ({"type": "string", "minLength": 2}, "a", ["minLength"]),
    ({"type": "string", "pattern": "^[0-9]+$"}, "12a", ["pattern"]),
    ({"type": "integer", "minimum": 0, "maximum": 10}, 11, ["maximum"]),
    ({"type": "integer"}, 1.5, ["type"]),
    ({"type": "integer"}, 4.0, []),
    ({"type": "number", "multipleOf": 0.05}, 0.15, []),
    ({"type": "number", "multipleOf": 0.05}, 0.12, ["multipleOf"]),
    ({"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1}, 1, ["exclusiveMaximum"]),
    ({"type": "integer", "minimum": 0, "exclusiveMinimum": True}, 0, ["minimum"]),
    ({"enum": [1, "a", None]}, True, ["enum"]),
    ({"enum": [1]}, 1.0, []),
    ({"const": {"a": [1, 2]}}, {"a": [1, 2]}, []),
    ({"type": ["string", "null"]}, None, []),
    ({"type": "array", "uniqueItems": True}, [1, 2, 1], ["uniqueItems"]),
    ({"type": "array", "uniqueItems": True}, [1, True], []),
    ({"type": "array", "minItems": 2, "maxItems": 3}, [1], ["minItems"]),
    ({"type": "array", "prefixItems": [{"type": "number"}], "items": False}, [1, 2], ["false"]),
    ({"type": "array", "items": [{"type": "string"}], "additionalItems": {"type": "boolean"}}, ["a", True, 3], ["type"]),
    ({"type": "array", "items": {"type": "integer"}, "contains": {"minimum": 100}}, [1, 2], ["contains"]),
    ({"type": "array", "contains": {"minimum": 100}, "maxContains": 1}, [100, 200], ["maxContains"]),
    ({"type": "object", "required": ["a"]}, {}, ["required"]),
    ({"type": "object", "additionalProperties": False, "properties": {"a": {}}}, {"a": 1, "b": 2}, ["additionalProperties"]),
    ({"type": "object", "patternProperties": {"^x": {"type": "integer"}}}, {"x1": "no"}, ["type"]),
    ({"type": "object", "propertyNames": {"maxLength": 2}}, {"abc": 1}, ["propertyNames"]),
    ({"type": "object", "minProperties": 1}, {}, ["minProperties"]),
    ({"dependentRequired": {"a": ["b"]}}, {"a": 1}, ["dependentRequired"]),
    ({"dependencies": {"a": ["b"]}}, {"a": 1}, ["dependencies"]),
    ({"dependentSchemas": {"a": {"required": ["c"]}}}, {"a": 1}, ["required"]),
    ({"oneOf": [{"type": "integer"}, {"minimum": 0}]}, 5, ["oneOf"]),
    ({"anyOf": [{"type": "string"}, {"type": "null"}]}, 3, ["anyOf"]),
    ({"not": {"type": "string"}}, "x", ["not"]),
    ({"allOf": [{"minimum": 1}, {"maximum": 3}]}, 5, ["maximum"]),
    ({"if": {"properties": {"k": {"const": 1}}, "required": ["k"]}, "then": {"required": ["t"]},
      "else": {"required": ["e"]}}, {"k": 1}, ["required"]),
    ({"type": "string", "format": "date"}, "2024-02-30", ["format"]),
    ({"type": "string", "format": "date-time"}, "2024-02-29T10:00:00Z", []),
    ({"type": "string", "format": "ipv4"}, "10.0.0.256", ["format"]),
    ({"$defs": {"n": {"type": "integer"}}, "$ref": "#/$defs/n"}, "x", ["type"]),
    ({"$defs": {"n": {"$anchor": "num", "type": "integer"}}, "$ref": "#num"}, "x", ["type"]),
])
def test_validation(schema, value, expected):
    assert errors(schema, value) == expected


def test_formats_can_be_annotation_only():
    schema = {"type": "string", "format": "email"}
    assert SchemaEngine(schema, validate_formats=False).validate_value("nope") == []


def test_json_equality_is_not_python_equality():
    assert not deep_equal(True, 1)
    assert not deep_equal([True], [1])
    assert deep_equal(1, 1.0)
    assert type_of(True) == "boolean" and type_of(3.0) == "integer" and type_of(3.5) == "number"


def test_remote_and_missing_refs_are_reported():
    with pytest.raises(ValueError, match="Unsupported"):
        SchemaEditor({"$ref": "https://example.com/x.json"}, 1)
    with pytest.raises(ValueError, match="Unresolvable"):
        SchemaEditor({"$ref": "#/$defs/missing"}, 1)


def test_recursive_refs_terminate(contact_schema):
    tree = {"$ref": "#/$defs/n", "$defs": {"n": {"type": "object", "required": ["kids"],
            "properties": {"kids": {"type": "array", "items": {"$ref": "#/$defs/n"}}}}}}
    assert SchemaEditor(tree).get_document() == {"kids": []}


@pytest.mark.parametrize("schema, expected", [
    ({"type": "integer", "minimum": 5}, 5),
    ({"type": "integer", "exclusiveMinimum": 5}, 6),
    ({"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1, "multipleOf": 0.05}, 0.05),
    ({"type": "number", "minimum": 0, "maximum": 10}, 5),
    ({"type": "string", "minLength": 3}, "xxx"),
    ({"type": "string", "format": "email"}, "user@example.com"),
    ({"enum": ["a", "b"]}, "a"),
    ({"type": "array", "minItems": 2, "items": {"type": "string", "enum": ["a", "b"]}, "uniqueItems": True}, ["a", "b"]),
    ({"oneOf": [{"type": "integer", "minimum": 3}, {"type": "null"}]}, 3),
    ({"type": "object", "required": ["a"], "properties": {"a": {"type": "boolean"}}}, {"a": False}),
])
def test_defaults_satisfy_the_schema(schema, expected):
    value = SchemaEditor(schema).get_document()
    assert value == expected
    assert SchemaEngine(schema).validate_value(value) == []
