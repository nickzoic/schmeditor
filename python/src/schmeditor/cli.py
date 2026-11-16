"""The `schmeditor` command line."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from typing import Any, Optional

from .engine import _MISSING, EditCancelled
from .model import SchemaEditor

__all__ = ["main"]


# ------------------------------------------------------------------------------------ CLI

def _read_json(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path}: not valid JSON: {exc}")
    except OSError as exc:
        raise SystemExit(f"{path}: {exc.strerror or exc}")


def _write_json(path: str, doc: Any, indent: int = 2) -> None:
    """Write atomically, keeping the permissions of an existing file."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".schmeditor_", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=indent, ensure_ascii=False)
            f.write("\n")
        if os.path.exists(path):
            os.chmod(tmp, os.stat(path).st_mode & 0o7777)
        else:
            umask = os.umask(0)
            os.umask(umask)
            os.chmod(tmp, 0o666 & ~umask)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="schmeditor",
        description="Edit a JSON document in the terminal, with every edit checked against a JSON Schema.")
    ap.add_argument("schema", help="JSON Schema file")
    ap.add_argument("document", nargs="?", help="JSON document to edit (created if it does not exist; "
                                                "omit to start from a minimal valid document)")
    ap.add_argument("-o", "--output", help="where Ctrl+S saves (default: the document file)")
    ap.add_argument("--indent", type=int, default=2, help="JSON indentation when saving (default 2)")
    ap.add_argument("--check", action="store_true",
                    help="don't open the editor; just validate the document and list any errors")
    ap.add_argument("--no-format-checks", action="store_true", help='treat "format" as an annotation only')
    args = ap.parse_args(argv)

    schema = _read_json(args.schema)
    if not isinstance(schema, (dict, bool)):
        raise SystemExit(f"{args.schema}: a JSON Schema must be an object")
    document: Any = _MISSING
    existing = bool(args.document) and os.path.exists(args.document)
    if existing:
        document = _read_json(args.document)
    elif args.check:
        raise SystemExit("--check needs an existing document")

    try:
        ed = SchemaEditor(schema, document, validate_formats=not args.no_format_checks,
                          title=os.path.basename(args.schema))
    except (ValueError, TypeError) as exc:                       # e.g. an unresolvable $ref
        raise SystemExit(f"{args.schema}: {exc}")

    if args.check:
        for e in ed.validate():
            print(f"{args.document}{e['path']}: {e['message']}")
        return 0 if ed.is_valid() else 1

    target = args.output or args.document
    if not target and not sys.stdout.isatty():
        raise SystemExit("Standard output is not a terminal. Give an output file with -o FILE.")

    def save(doc: Any) -> str:
        _write_json(target, doc, args.indent)
        return f"Saved to {target}"

    # A document that doesn't exist yet counts as unsaved, so it gets written even if untouched.
    if target and not os.path.exists(target):
        ed._saved = _MISSING
    try:
        doc = ed.run(save_handler=save if target else None, subtitle=target or "")
    except EditCancelled:
        print("Cancelled: nothing saved." if target else "Cancelled.", file=sys.stderr)
        return 1
    if not target:
        print(json.dumps(doc, indent=args.indent, ensure_ascii=False))
    return 0
