#!/usr/bin/env python3
"""Check that the JavaScript and Python validators agree.

Builds a corpus of (schema, document) pairs (the example documents with random mutations, plus
edge cases for individual keywords), validates each with both implementations and compares the
errors they report. Exits 1 if any differ.

    cd javascript && npm install      # once, for jsdom
    python tools/compare_validators.py [--seed N] [--mutations N]
"""
import argparse
import copy
import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python" / "src"))
from schmeditor.engine import SchemaEngine  # noqa: E402

POOL = ["", "x", "ab", "ABC123", "a@b.co", "2024-02-30", "2024-02-28", "3000", "staff", "delivery", "pickup",
        0, 1, -1, 2.5, 3, 99, 100, 1000, 0.5, 0.05, True, False, None, [], [1, 2], ["a", "a"], {}, {"a": 1},
        {"postcode": "12"}, {"kind": "entity"}, {"type": "string"}, {"type": "array"}, {"foo": 1}, "object",
        "string", "#", "#/$defs/x", "urgent", "mobile"]
SPOOL = POOL + [["a", 1, True, False], [1, 2, 3], [100, 200, 300], [50, 100, 150], [1, "a"], {"k": 1},
                {"k": 1, "t": 2}, {"k": 2, "e": 1}, {"a": 1, "b": 2}, {"c": 1}, {"e": 1, "f": 1},
                {"max_a": 1, "max_b": -1}, {"maxlongname_x": 1}, "2024-02-29T10:00:00Z", "2024-02-29T25:00:00Z",
                "2024-02-29", "10.0.0.256", "10.0.0.255", "3f2b8c1e-9d4a-4e6b-8a1f-2c7d5e9b0a13", 0.3, 0.15,
                1.0, 10, 11]
KEYWORD_CASES = [
    {"type": "array", "prefixItems": [{"type": "number"}, {"type": "number"}], "items": False, "minItems": 2},
    {"type": "array", "items": [{"type": "string"}, {"type": "integer"}], "additionalItems": {"type": "boolean"},
     "minItems": 2},
    {"type": "array", "items": {"type": "integer"}, "contains": {"minimum": 100}, "minContains": 1, "maxContains": 2},
    {"type": "object", "patternProperties": {"^max_": {"type": "integer", "minimum": 0}},
     "additionalProperties": False, "propertyNames": {"maxLength": 8}},
    {"type": "number", "exclusiveMinimum": 0, "exclusiveMaximum": 1, "multipleOf": 0.05},
    {"type": "integer", "minimum": 0, "exclusiveMinimum": True, "maximum": 10},
    {"enum": [1, "a", None, [1], {"a": True}]},
    {"not": {"type": "string"}, "type": ["string", "number"]},
    {"type": "object", "dependentRequired": {"a": ["b"]}, "dependentSchemas": {"c": {"required": ["d"]}},
     "dependencies": {"e": ["f"]}},
    {"type": "object", "if": {"properties": {"k": {"const": 1}}, "required": ["k"]},
     "then": {"required": ["t"]}, "else": {"required": ["e"]}},
    {"type": "string", "format": "date-time"}, {"type": "string", "format": "date"},
    {"type": "string", "format": "ipv4"}, {"type": "string", "format": "uuid"},
]


def paths(value, prefix=()):
    yield prefix
    if isinstance(value, dict):
        for k, v in value.items():
            yield from paths(v, prefix + (k,))
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from paths(v, prefix + (i,))


def mutate(rng, doc):
    doc = copy.deepcopy(doc)
    for _ in range(rng.randint(1, 3)):
        path = rng.choice(list(paths(doc)))
        if not path:
            doc = copy.deepcopy(rng.choice(POOL))
            continue
        parent = doc
        for k in path[:-1]:
            parent = parent[k]
        k, r = path[-1], rng.random()
        if r < 0.25 and isinstance(parent, dict):
            del parent[k]
        elif r < 0.35 and isinstance(parent, dict):
            parent[rng.choice(["zzz", "minLength", "a", "max_x", "Team", "role", "department"])] = copy.deepcopy(rng.choice(POOL))
        elif r < 0.4 and isinstance(parent, list):
            parent.append(copy.deepcopy(rng.choice(POOL)))
        else:
            parent[k] = copy.deepcopy(rng.choice(POOL))
    return doc


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--mutations", type=int, default=400, help="mutated documents per example (default 400)")
    args = ap.parse_args()
    rng = random.Random(args.seed)
    load = lambda name: json.loads((ROOT / "examples" / name).read_text(encoding="utf-8"))
    contact, contact_doc, meta = load("contact.schema.json"), load("contact.json"), load("editor-metaschema.json")

    corpus = [{"schema": contact, "doc": mutate(rng, contact_doc)} for _ in range(args.mutations)]
    corpus += [{"schema": meta, "doc": mutate(rng, contact)} for _ in range(args.mutations)]
    small = {"type": "object", "properties": {"a": {"type": "string", "minLength": 2},
                                              "b": {"oneOf": [{"type": "integer"}, {"type": "null"}]}},
             "required": ["a"], "items": [{"type": "string"}]}
    corpus += [{"schema": meta, "doc": mutate(rng, small)} for _ in range(args.mutations // 4)]
    corpus += [{"schema": s, "doc": v} for s in KEYWORD_CASES for v in SPOOL]

    py = [sorted([e["path"], e["keyword"], e["message"]] for e in SchemaEngine(c["schema"]).validate_value(c["doc"]))
          for c in corpus]
    with tempfile.TemporaryDirectory() as tmp:
        corpus_file, out_file = Path(tmp, "corpus.json"), Path(tmp, "js.json")
        corpus_file.write_text(json.dumps(corpus))
        done = subprocess.run(["node", str(ROOT / "tools" / "compare_validators.js"), str(corpus_file), str(out_file)],
                              capture_output=True, text=True)
        if done.returncode:
            sys.exit(f"The JavaScript side failed (did you run `npm install` in javascript/?):\n{done.stderr}")
        js = json.loads(out_file.read_text())

    key = lambda errors: sorted(errors, key=json.dumps)
    differ = [i for i, (a, b) in enumerate(zip(py, js)) if key(a) != key(b)]
    with_errors = sum(1 for e in py if e)
    print(f"{len(corpus)} cases ({with_errors} with at least one error): "
          f"{len(corpus) - len(differ)} identical, {len(differ)} different")
    for i in differ[:5]:
        print("\nDIFFERENT:", json.dumps(corpus[i]["doc"])[:200])
        print("  python only:", [e for e in key(py[i]) if e not in key(js[i])][:3])
        print("  js only:    ", [e for e in key(js[i]) if e not in key(py[i])][:3])
    return 1 if differ else 0


if __name__ == "__main__":
    sys.exit(main())
