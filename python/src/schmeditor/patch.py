"""JSON Patch (RFC 6902): apply a patch to a document, or work one out from two documents.

Pure Python, no dependencies. These functions only edit JSON; they don't look at any schema.
`apply_patch` is exported from the package as `schmeditor.apply_patch`.
"""
from __future__ import annotations

import re
from typing import Any

from .engine import _esc, clone, deep_equal, parse_path, to_ptr

__all__ = ["apply_patch", "diff_patch", "PatchError"]

_INDEX = re.compile(r"(0|[1-9][0-9]*)")


class PatchError(ValueError):
    """A JSON Patch could not be applied. The message names the failing operation."""


# ------------------------------------------------------------------------------------ diff

def diff_patch(a: Any, b: Any) -> list[dict]:
    """A list of operations that turns `a` into `b`.

    Used for whatever an edit changed beyond the one thing the user did (for example properties
    the editor filled in); the main operation of each edit is chosen by the editor itself."""
    ops: list[dict] = []
    _diff(a, b, "", ops)
    return ops


def _diff(a: Any, b: Any, path: str, ops: list[dict]) -> None:
    if deep_equal(a, b):
        return
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a:
            if k in b:
                _diff(a[k], b[k], f"{path}/{_esc(k)}", ops)
        for k in a:
            if k not in b:
                ops.append({"op": "remove", "path": f"{path}/{_esc(k)}"})
        for k in b:
            if k not in a:
                ops.append({"op": "add", "path": f"{path}/{_esc(k)}", "value": clone(b[k])})
    elif isinstance(a, list) and isinstance(b, list):
        # Skip what the arrays share at both ends, then compare what is left in pairs.
        head = 0
        while head < len(a) and head < len(b) and deep_equal(a[head], b[head]):
            head += 1
        tail_a, tail_b = len(a), len(b)
        while tail_a > head and tail_b > head and deep_equal(a[tail_a - 1], b[tail_b - 1]):
            tail_a -= 1
            tail_b -= 1
        shared = min(tail_a, tail_b) - head
        for i in range(shared):
            _diff(a[head + i], b[head + i], f"{path}/{head + i}", ops)
        for _ in range(shared, tail_a - head):
            ops.append({"op": "remove", "path": f"{path}/{head + shared}"})
        for i in range(shared, tail_b - head):
            ops.append({"op": "add", "path": f"{path}/{head + i}", "value": clone(b[head + i])})
    else:
        ops.append({"op": "replace", "path": path, "value": clone(b)})


# ----------------------------------------------------------------------------------- apply

def _array_index(key: str, maximum: int) -> int:
    if not _INDEX.fullmatch(key) or int(key) > maximum:
        raise PatchError(f'invalid array index "{key}"')
    return int(key)


def _locate(root: Any, path: list) -> Any:
    """The value at `path`, which must exist."""
    cur = root
    for k in path:
        if isinstance(cur, list):
            cur = cur[_array_index(k, len(cur) - 1)]
        elif isinstance(cur, dict) and k in cur:
            cur = cur[k]
        else:
            raise PatchError(f'no value at "{to_ptr(path)}"')
    return cur


def _add(root: Any, path: list, value: Any) -> Any:
    if not path:
        return value
    parent, k = _locate(root, path[:-1]), path[-1]
    if isinstance(parent, list):
        parent.insert(len(parent) if k == "-" else _array_index(k, len(parent)), value)
    elif isinstance(parent, dict):
        parent[k] = value
    else:
        raise PatchError(f'cannot add at "{to_ptr(path)}"')
    return root


def _remove(root: Any, path: list) -> Any:
    if not path:
        raise PatchError("cannot remove the whole document")
    parent, k = _locate(root, path[:-1]), path[-1]
    _locate(root, path)
    if isinstance(parent, list):
        del parent[_array_index(k, len(parent) - 1)]
    else:
        del parent[k]
    return root


def apply_patch(doc: Any, patch: list) -> Any:
    """Apply a JSON Patch to a copy of `doc` and return the copy; `doc` itself is not touched.

    Implements add, remove, replace, move, copy and test. Raises PatchError naming the failing
    operation. It only edits the JSON: it does not check the result against any schema."""
    if not isinstance(patch, list):
        raise PatchError("A JSON Patch must be a list of operations")
    root = clone(doc)
    for i, op in enumerate(patch):
        try:
            if not isinstance(op, dict) or not isinstance(op.get("path"), str):
                raise PatchError("not an operation")
            path = _pointer(op["path"])
            kind = op.get("op")
            if kind == "add":
                root = _add(root, path, clone(op.get("value")))
            elif kind == "remove":
                root = _remove(root, path)
            elif kind == "replace":                  # in place, so an object member keeps its position
                _locate(root, path)
                if not path:
                    root = clone(op.get("value"))
                else:
                    parent, k = _locate(root, path[:-1]), path[-1]
                    if isinstance(parent, list):
                        parent[_array_index(k, len(parent) - 1)] = clone(op.get("value"))
                    else:
                        parent[k] = clone(op.get("value"))
            elif kind == "move":
                source = _pointer(op.get("from"))
                if len(path) > len(source) and path[:len(source)] == source:
                    raise PatchError("cannot move into itself")
                value = _locate(root, source)
                root = _add(_remove(root, source), path, value)
            elif kind == "copy":
                root = _add(root, path, clone(_locate(root, _pointer(op.get("from")))))
            elif kind == "test":
                if not deep_equal(_locate(root, path), op.get("value")):
                    raise PatchError("the value is not as expected")
            else:
                raise PatchError(f'unknown operation "{kind}"')
        except (PatchError, ValueError, TypeError) as exc:
            where = f" ({op.get('op')} {op.get('path')})" if isinstance(op, dict) else ""
            raise PatchError(f"JSON Patch operation {i}{where} failed: {exc}") from None
    return root


def _pointer(ptr: Any) -> list:
    if not isinstance(ptr, str):
        raise PatchError("missing JSON Pointer")
    return parse_path(ptr)
