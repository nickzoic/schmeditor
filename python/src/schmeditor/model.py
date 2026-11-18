"""The document model: a document plus a schema, with edits that can never make it less valid."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .engine import (_MISSING, ChangeRejected, EditCancelled, SchemaEngine, _fmt_error, _index, clone,
                     deep_equal, get_at, parse_path, remove_at, set_at, to_ptr)
from .patch import PatchError, apply_patch, diff_patch

__all__ = ["SchemaEditor", "Result", "edit"]

log = logging.getLogger("schmeditor")


# --------------------------------------------------------------------------------- model

@dataclass
class Result:
    """Outcome of an interactive edit."""
    ok: bool
    errors: list[dict] = field(default_factory=list)
    changed: bool = False

    def message(self, here: str = "") -> str:
        return "; ".join(_fmt_error(e, here) for e in self.errors)


class SchemaEditor(SchemaEngine):
    """A document plus a schema, with edits that can never make the document less valid.

    `on_change(document, info)` is called after user edits in the terminal UI. `document` is a
    copy of the whole document and `info` is a dict:

    * `"source"`: `"user"` for edits in the UI, or `"api"` for set/remove/insert/push/set_document
      (only reported with `notify_on_programmatic=True`);
    * `"patch"`: a JSON Patch (RFC 6902), a list of operations. Applied to the document as it was
      before the change (see `apply_patch`), it gives `document`. It uses replace, add and remove
      (and move, for reordering an array item or renaming a property), followed by anything the
      editor changed along with the edit, such as a property that became required and was filled in;
    * `"path"`: JSON Pointer to the main thing that changed (`""` for the whole document);
    * `"value"`: a copy of the new value at `path`. Absent if it was removed. After a move, and
      after insert/push, `path` is the array and `value` its new contents.
    """

    def __init__(self, schema: Any, document: Any = _MISSING, *,
                 on_change: Optional[Callable[[Any, dict], None]] = None,
                 notify_on_programmatic: bool = False, validate_formats: bool = True,
                 title: Optional[str] = None):
        super().__init__(schema, validate_formats)
        self._cb = on_change
        self.notify_on_programmatic = notify_on_programmatic
        self.title = title
        self._doc = self.default_for(schema) if document is _MISSING else clone(document)
        self._set_errors(self.validate_value(self._doc))
        self._saved = clone(self._doc)
        self._undo: list[Any] = []
        self._redo: list[Any] = []
        self._coalesce: Any = None

    # ---- state -------------------------------------------------------------------

    def _set_errors(self, errs: list[dict]) -> None:
        self._errs = errs
        self._counts: dict[str, int] = {}
        for e in errs:
            k = e["keyword"] + "|" + e["message"]
            self._counts[k] = self._counts.get(k, 0) + 1

    @property
    def document(self) -> Any:
        """The live document. Treat as read-only; use get_document() for a copy."""
        return self._doc

    def get_document(self) -> Any:
        return clone(self._doc)

    def set_document(self, document: Any) -> "SchemaEditor":
        """Replace the whole document (it need not be valid; its errors are shown)."""
        self._snapshot()
        before = self._doc
        self._doc = clone(document)
        self._set_errors(self.validate_value(self._doc))
        self._notify([], "api", before, primary=[{"op": "replace", "path": "", "value": clone(document)}])
        return self

    def get(self, path: Any = "") -> Any:
        v = get_at(self._doc, parse_path(path))
        return None if v is _MISSING else clone(v)

    def validate(self) -> list[dict]:
        return [dict(e) for e in self._errs]

    def is_valid(self) -> bool:
        return not self._errs

    def on_change(self, callback: Optional[Callable[[Any, dict], None]]) -> "SchemaEditor":
        self._cb = callback
        return self

    @property
    def modified(self) -> bool:
        return not deep_equal(self._doc, self._saved)

    def mark_saved(self) -> None:
        self._saved = clone(self._doc)

    def _primary(self, before: Any, after: Any, path: list, removed: bool, primary: Optional[list]) -> list:
        """The main operations of an edit, as JSON Patch. `primary` gives them outright (for moves,
        renames and inserts); otherwise the edit set, added or removed whatever is at `path`."""
        if primary is not None:
            return primary
        ptr = to_ptr(path)
        if removed:
            return [{"op": "remove", "path": ptr}]
        was, now = get_at(before, path), get_at(after, path)
        if was is _MISSING:
            return [] if now is _MISSING else [{"op": "add", "path": ptr, "value": clone(now)}]
        return [] if deep_equal(was, now) else [{"op": "replace", "path": ptr, "value": clone(now)}]

    def _make_patch(self, before: Any, after: Any, primary: list) -> list:
        """A JSON Patch that turns `before` into `after`: the edit's main operations, then anything
        else the editor changed along with it. Always checked, so it is never wrong: if the pieces
        didn't add up, the patch replaces the whole document."""
        def works(ops: list) -> bool:
            try:
                return deep_equal(apply_patch(before, ops), after)
            except PatchError:
                return False

        try:
            ops = [clone(o) for o in primary] + diff_patch(apply_patch(before, primary), after)
            if works(ops):
                return ops
        except PatchError:
            pass
        plain = diff_patch(before, after)
        return plain if works(plain) else [{"op": "replace", "path": "", "value": clone(after)}]

    def _notify(self, path: Any, source: str, before: Any, *, removed: bool = False,
                primary: Optional[list] = None) -> None:
        """Tell the callback about a change (the document has already been updated)."""
        if not self._cb or (source != "user" and not self.notify_on_programmatic):
            return
        path = parse_path(path)
        after = self._doc
        info: dict[str, Any] = {
            "source": source,
            "patch": self._make_patch(before, after, self._primary(before, after, path, removed, primary)),
            "path": to_ptr(path),
        }
        value = get_at(after, path)
        if not removed and value is not _MISSING:
            info["value"] = clone(value)
        try:
            self._cb(clone(after), info)
        except Exception:                           # a faulty callback must not break editing
            log.exception("on_change callback failed")

    # ---- checked mutation --------------------------------------------------------

    def try_mutate(self, mutator: Callable[[Any], Any], repair: bool = False) -> tuple[bool, Any, list[dict]]:
        """Apply `mutator` to a copy of the document. Accept only if it adds no new errors.

        With `repair`, newly *missing required properties* (e.g. exposed by an if/then branch)
        are first filled in with default values. Returns (ok, new document or None, errors)."""
        nxt = clone(self._doc)
        try:
            out = mutator(nxt)
            if out is not None:
                nxt = out
        except (ValueError, TypeError, KeyError, IndexError, AttributeError) as exc:
            return False, None, [{"path": "", "keyword": "", "message": str(exc)}]

        def check() -> tuple[list[dict], list[dict]]:
            errs = self.validate_value(nxt)
            counts: dict[str, int] = {}
            for e in errs:
                k = e["keyword"] + "|" + e["message"]
                counts[k] = counts.get(k, 0) + 1
            seen: set[str] = set()
            bad = []
            for e in errs:
                k = e["keyword"] + "|" + e["message"]
                if counts[k] > self._counts.get(k, 0) and k not in seen:
                    seen.add(k)
                    bad.append(e)
            return errs, bad

        errs, bad = check()
        for _ in range(6):
            if not (repair and bad):
                break
            fixed = False
            for e in bad:
                if "key" not in e:
                    continue
                p = parse_path(e["path"])
                o = get_at(nxt, p)
                if not isinstance(o, dict) or e["key"] in o:
                    continue
                eff = self.effective_at(nxt, p)
                sub = self.prop_schema(eff, e["key"]) if eff is not None else None
                if sub is None:
                    continue
                o[e["key"]] = self.default_for(sub)
                fixed = True
            if not fixed:
                break
            errs, bad = check()
        if bad:
            return False, None, bad
        self._pending_errs = errs
        return True, nxt, []

    def _snapshot(self, coalesce: Any = None) -> None:
        if coalesce is not None and coalesce == self._coalesce and self._undo:
            return                                  # keep merging a run of keystrokes into one undo step
        self._undo.append(clone(self._doc))
        del self._undo[:-200]
        self._redo.clear()
        self._coalesce = coalesce

    def break_undo(self) -> None:
        """Make the next edit start a new undo step."""
        self._coalesce = None

    def commit(self, mutator: Callable[[Any], Any], path: Any = "", *, repair: bool = True,
               source: str = "user", coalesce: Any = None, removed: bool = False,
               primary: Optional[list] = None) -> Result:
        """Apply an edit if it adds no new errors. `path` is what the change callback is told
        about; `removed` says that whatever was there is gone; `primary` gives the edit's main
        JSON Patch operations when they aren't a simple set, add or remove at `path`."""
        ok, nxt, errors = self.try_mutate(mutator, repair)
        if not ok:
            return Result(False, errors)
        before = self._doc
        changed = not deep_equal(before, nxt)
        if changed:
            self._snapshot(coalesce)
            self._doc = nxt
            self._set_errors(self._pending_errs)
            self._notify(path, source, before, removed=removed, primary=primary)
        return Result(True, [], changed)

    def undo(self) -> bool:
        if not self._undo:
            return False
        self._redo.append(clone(self._doc))
        before = self._doc
        self._doc = self._undo.pop()
        self._set_errors(self.validate_value(self._doc))
        self._coalesce = None
        self._notify([], "user", before, primary=[])
        return True

    def redo(self) -> bool:
        if not self._redo:
            return False
        self._undo.append(clone(self._doc))
        before = self._doc
        self._doc = self._redo.pop()
        self._set_errors(self.validate_value(self._doc))
        self._coalesce = None
        self._notify([], "user", before, primary=[])
        return True

    # ---- programmatic edits (raise ChangeRejected) --------------------------------

    def _api(self, mutator: Callable[[Any], Any], path: Any, **how: Any) -> "SchemaEditor":
        r = self.commit(mutator, path, repair=False, source="api", **how)
        if not r.ok:
            raise ChangeRejected(r.errors)
        return self

    def set(self, path: Any, value: Any) -> "SchemaEditor":
        p = parse_path(path)
        return self._api(lambda d: set_at(d, p, clone(value)), p)

    def remove(self, path: Any) -> "SchemaEditor":
        p = parse_path(path)
        return self._api(lambda d: remove_at(d, p), p, removed=True)

    def insert(self, path: Any, index: int, value: Any) -> "SchemaEditor":
        p = parse_path(path)

        def go(d: Any) -> None:
            arr = get_at(d, p)
            if not isinstance(arr, list):
                raise ValueError("Not an array: " + to_ptr(p))
            if not isinstance(index, int) or not 0 <= index <= len(arr):
                raise ValueError(f"Invalid array index {index}")
            arr.insert(index, clone(value))

        return self._api(go, p, primary=[{"op": "add", "path": to_ptr(p + [index]), "value": clone(value)}])

    def push(self, path: Any, value: Any) -> "SchemaEditor":
        p = parse_path(path)

        def go(d: Any) -> None:
            arr = get_at(d, p)
            if not isinstance(arr, list):
                raise ValueError("Not an array: " + to_ptr(p))
            arr.append(clone(value))

        current = get_at(self._doc, p)
        end = len(current) if isinstance(current, list) else 0
        return self._api(go, p, primary=[{"op": "add", "path": to_ptr(p + [end]), "value": clone(value)}])

    # ---- interactive operations (return a Result, never raise) ---------------------

    def info(self, path) -> tuple[Any, dict, list[tuple[list[dict], int]]]:
        """(value, effective schema, alternatives chain) for the node at `path`."""
        path = list(path)
        raw = self.schema_at(self._doc, path)
        value = get_at(self._doc, path)
        if raw is None or value is _MISSING:
            return value, {}, []
        s, chain = self.resolve(raw, value, to_ptr(path))
        return value, s, chain

    def ui_set(self, path, value: Any, *, coalesce: Any = None) -> Result:
        path = list(path)
        return self.commit(lambda d: set_at(d, path, value), path, coalesce=coalesce)

    def ui_replace_with_default(self, path) -> Result:
        path = list(path)
        raw = self.schema_at(self._doc, path)
        nv = self.default_for(raw if raw is not None else {})
        return self.ui_set(path, nv)

    def ui_switch(self, path, level: int, index: int) -> Result:
        """Choose another alternative (oneOf/anyOf branch or type) for the node at `path`."""
        path = list(path)
        _, _, chain = self.info(path)
        if level >= len(chain):
            return Result(False, [{"path": "", "keyword": "", "message": "No alternatives here"}])
        nv = self.default_for(chain[level][0][index]["schema"])
        r = self.ui_set(path, nv)
        if r.ok:
            ptr = to_ptr(path)
            self.variant_choice = {k: v for k, v in self.variant_choice.items() if not (k[0] == ptr and k[1] >= level)}
            self.variant_choice[(ptr, level)] = index
        return r

    def addable_properties(self, path) -> tuple[list[dict], bool]:
        """(absent declared properties that may be added, whether free-form names are allowed)."""
        path = list(path)
        value, s, _ = self.info(path)
        if not isinstance(value, dict):
            return [], False
        out = []
        req = set(s["required"]) if isinstance(s.get("required"), list) else set()
        for k in (s["properties"] if isinstance(s.get("properties"), dict) else {}):
            sub = self.prop_schema(s, k)
            if k in value or sub is None:
                continue
            ns = self.norm(sub)
            out.append({"key": k, "title": ns.get("title") or k, "description": ns.get("description", ""),
                        "required": k in req})
        pats = s.get("patternProperties")
        free = s.get("additionalProperties") is not False or (isinstance(pats, dict) and bool(pats))
        return out, free

    def ui_add_property(self, path, key: str) -> Result:
        path = list(path)
        value, s, _ = self.info(path)
        if not isinstance(value, dict):
            return Result(False, [{"path": "", "keyword": "", "message": "Not an object"}])
        if key == "" or key == "__proto__":
            return Result(False, [{"path": "", "keyword": "", "message": "Enter a property name"}])
        if key in value:
            return Result(False, [{"path": "", "keyword": "", "message": f'Property "{key}" already exists'}])
        sub = self.prop_schema(s, key)
        if sub is None:
            return Result(False, [{"path": "", "keyword": "", "message": f'Property "{key}" is not allowed here'}])
        nv = self.default_for(sub)
        return self.commit(lambda d: get_at(d, path).__setitem__(key, nv), path + [key])

    def ui_add_item(self, path) -> Result:
        path = list(path)
        value, s, _ = self.info(path)
        if not isinstance(value, list):
            return Result(False, [{"path": "", "keyword": "", "message": "Not an array"}])
        nxt = self.item_schema(s, len(value))
        if nxt is False:
            return Result(False, [{"path": "", "keyword": "", "message": "No more items are allowed here"}])
        first: Optional[Result] = None
        for nv in self.candidates(nxt):
            r = self.commit(lambda d, nv=nv: get_at(d, path).append(clone(nv)), path + [len(value)])
            if r.ok:
                return r
            first = first or r
        return first or Result(False)

    def ui_remove(self, path) -> Result:
        path = list(path)
        return self.commit(lambda d: remove_at(d, path), path, repair=False, removed=True)

    def ui_move(self, path, delta: int) -> Result:
        path = list(path)
        parent = path[:-1]

        def go(d: Any) -> None:
            arr = get_at(d, parent)
            i = _index(path[-1])
            if not isinstance(arr, list) or i is None or not 0 <= i + delta < len(arr):
                raise ValueError("Can't move the item there")
            arr.insert(i + delta, arr.pop(i))

        # Moving changes two items, so the change is reported on the array itself.
        index = _index(path[-1]) if path else None
        primary = None if index is None else [{"op": "move", "from": to_ptr(path), "path": to_ptr(parent + [index + delta])}]
        return self.commit(go, parent, primary=primary)

    def ui_rename(self, path, new_key: str) -> Result:
        path = list(path)
        parent, old = path[:-1], str(path[-1])

        def go(d: Any) -> None:
            o = get_at(d, parent)
            if new_key == "" or new_key == "__proto__":
                raise ValueError("Invalid property name")
            if new_key in o and new_key != old:
                raise ValueError(f'Property "{new_key}" already exists')
            items = [(new_key if k == old else k, v) for k, v in o.items()]
            o.clear()
            o.update(items)

        move = [{"op": "move", "from": to_ptr(parent + [old]), "path": to_ptr(parent + [new_key])}]
        return self.commit(go, parent + [new_key], primary=move)

    # ---- the terminal UI -----------------------------------------------------------

    def run(self, *, save_handler: Optional[Callable[[Any], Optional[str]]] = None,
            subtitle: str = "") -> Any:
        """Open the terminal UI. Returns the document when the user accepts it with Ctrl+S
        (or, with a `save_handler`, when they quit). Raises EditCancelled otherwise.

        `save_handler(document)` makes Ctrl+S save and keep editing instead of finishing. It may
        return a short message to show, and may raise OSError to report a failure."""
        try:
            from .tui import EditorApp
        except ImportError as exc:  # pragma: no cover
            raise ImportError("The terminal UI needs the Textual library: pip install textual") from exc
        app = EditorApp(self, save_handler=save_handler, subtitle=subtitle)
        outcome = app.run()
        if outcome is None or outcome[0] != "ok":
            raise EditCancelled()
        return outcome[1]


def edit(schema: Any, document: Any = _MISSING, *, title: Optional[str] = None,
         on_change: Optional[Callable[[Any, dict], None]] = None,
         validate_formats: bool = True) -> Any:
    """Edit `document` against `schema` in the terminal and return the edited document.

    Omit `document` to start from a minimal valid document built from the schema.
    Raises EditCancelled if the user quits without accepting (Ctrl+S accepts)."""
    ed = SchemaEditor(schema, document, on_change=on_change, validate_formats=validate_formats, title=title)
    return ed.run()
