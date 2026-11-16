"""schmeditor: a schema-driven JSON editor for the terminal.

Edit a JSON document in a Textual user interface. Every edit is checked against a JSON
Schema, and an edit that would introduce a new validation error is refused, so a document
that starts out valid stays valid. (A document that starts out invalid is shown with its
errors, and edits can only reduce them.)

Command line::

    schmeditor SCHEMA.json [DOCUMENT.json] [-o OUTPUT.json]
    python -m schmeditor SCHEMA.json DOCUMENT.json

As a library::

    from schmeditor import edit, SchemaEditor, EditCancelled

    # Open the terminal UI and return the edited document.
    try:
        doc = edit(schema, document)          # `document` is optional
    except EditCancelled:
        ...

    # Or drive a document programmatically, with or without the UI.
    ed = SchemaEditor(schema, document, on_change=lambda doc, info: print(info))
    ed.set("/name", "Ada")                    # JSON Pointer or list of keys; raises
    ed.push("/tags", "math")                  # ChangeRejected if the result is invalid
    ed.remove("/address")
    ed.insert("/tags", 0, "first")
    ed.validate()                             # [{"path", "keyword", "message"}, ...]
    ed.get_document(); ed.set_document(doc)
    doc = ed.run()                            # same as edit(), on this object

Supported schema keywords: type (including type lists), enum, const, default, title,
description, properties, patternProperties, additionalProperties, required, minProperties,
maxProperties, propertyNames, dependentRequired, dependentSchemas, dependencies, items
(schema or tuple), prefixItems, additionalItems, minItems, maxItems, uniqueItems,
contains/minContains/maxContains, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
multipleOf, minLength, maxLength, pattern, format, allOf, anyOf, oneOf, not, if/then/else,
and local $ref ("#", "#/pointer", "#anchor"). Remote $refs are not supported.
"""
from .engine import ChangeRejected, EditCancelled, SchemaEngine
from .model import Result, SchemaEditor, edit

__version__ = "0.1.0"
__all__ = ["edit", "SchemaEditor", "SchemaEngine", "Result", "ChangeRejected", "EditCancelled",
           "__version__"]
