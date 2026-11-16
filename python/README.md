# schmeditor (Python)

A schema-driven JSON editor for the terminal, built on [Textual](https://textual.textualize.io/).
Every edit is checked against a JSON Schema, and an edit that would add a validation error is
refused, so a valid document stays valid.

```
pip install schmeditor        # or, from a checkout:  pip install -e '.[test]'
schmeditor schema.json document.json
```

See the [project README](https://github.com/nickzoic/schmeditor#readme) for the full
documentation: keys, library API, supported schema keywords and how edits are checked.
