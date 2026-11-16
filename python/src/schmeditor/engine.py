"""The schema engine: JSON Schema validation, interpretation and default values.

Pure Python with no dependencies. Everything here depends only on the schema; the document
being edited lives in `schmeditor.model`, and the terminal UI in `schmeditor.tui`.
"""
from __future__ import annotations

import copy
import datetime as _dt
import json
import re
from typing import Any, Callable, Optional

__all__ = ["SchemaEngine", "ChangeRejected", "EditCancelled"]

_MISSING: Any = object()          # "no value": None is a real JSON value (null)


class ChangeRejected(ValueError):
    """An edit was refused because it would make the document less valid."""

    def __init__(self, errors: list[dict]):
        self.errors = errors
        super().__init__("Change rejected: " + "; ".join(_fmt_error(e) for e in errors))


class EditCancelled(Exception):
    """The user left the editor without accepting the document."""


# --------------------------------------------------------------------------- utilities

def clone(v: Any) -> Any:
    return copy.deepcopy(v)


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def deep_equal(a: Any, b: Any) -> bool:
    """JSON equality: true is not 1, and 1 equals 1.0."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_num(a) and _is_num(b):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(deep_equal(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def type_of(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, int):
        return "integer"
    if isinstance(v, float):
        return "integer" if v.is_integer() else "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    if isinstance(v, dict):
        return "object"
    return "unknown"


def is_type(v: Any, t: str) -> bool:
    vt = type_of(v)
    return vt in ("number", "integer") if t == "number" else vt == t


def _esc(tok: Any) -> str:
    return str(tok).replace("~", "~0").replace("/", "~1")


def _unesc(tok: str) -> str:
    return tok.replace("~1", "/").replace("~0", "~")


def to_ptr(path) -> str:
    return "".join("/" + _esc(p) for p in path)


def parse_path(p: Any) -> list:
    """A JSON Pointer string ("/a/0/b"), or a list/tuple of keys."""
    if isinstance(p, (list, tuple)):
        return list(p)
    if p is None or p == "":
        return []
    if not isinstance(p, str) or not p.startswith("/"):
        raise ValueError('Path must be a JSON Pointer like "/a/0/b" or a list of keys')
    return [_unesc(t) for t in p[1:].split("/")]


def _index(k: Any) -> Optional[int]:
    if isinstance(k, bool):
        return None
    if isinstance(k, int):
        return k
    if isinstance(k, str) and k.isascii() and k.isdigit():
        return int(k)
    return None


def get_at(doc: Any, path, default: Any = _MISSING) -> Any:
    cur = doc
    for k in path:
        if isinstance(cur, dict):
            k = str(k)
            if k not in cur:
                return default
            cur = cur[k]
        elif isinstance(cur, list):
            i = _index(k)
            if i is None or not 0 <= i < len(cur):
                return default
            cur = cur[i]
        else:
            return default
    return cur


def set_at(doc: Any, path, value: Any) -> Any:
    """Set a value inside `doc` (in place) and return the root. "-" appends to a list."""
    path = list(path)
    if not path:
        return value
    parent = get_at(doc, path[:-1])
    k = path[-1]
    if isinstance(parent, list):
        if k == "-":
            parent.append(value)
        else:
            i = _index(k)
            if i is None or not 0 <= i <= len(parent):
                raise ValueError(f'Invalid array index "{k}"')
            if i == len(parent):
                parent.append(value)
            else:
                parent[i] = value
    elif isinstance(parent, dict):
        parent[str(k)] = value
    else:
        raise ValueError("Path does not exist: " + to_ptr(path))
    return doc


def remove_at(doc: Any, path) -> Any:
    path = list(path)
    if not path:
        raise ValueError("The root of the document cannot be removed")
    parent = get_at(doc, path[:-1])
    k = path[-1]
    if isinstance(parent, list):
        i = _index(k)
        if i is None or not 0 <= i < len(parent):
            raise ValueError(f'Invalid array index "{k}"')
        del parent[i]
    elif isinstance(parent, dict) and str(k) in parent:
        del parent[str(k)]
    else:
        raise ValueError("Path does not exist: " + to_ptr(path))
    return doc


def _dumps(v: Any) -> str:
    """Compact JSON, formatted like JavaScript's JSON.stringify."""
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)


def _fmt_error(e: dict, here: str = "") -> str:
    path = e.get("path", "")
    return (f"{path}: " if path and path != here else "") + e["message"]


# ------------------------------------------------------------------------------ formats

def _valid_date(s: str) -> bool:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return False
    try:
        _dt.date.fromisoformat(s)
        return True
    except ValueError:
        return False


def _valid_datetime(s: str) -> bool:
    m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?(Z|z|[+-]\d{2}:\d{2})", s)
    if not m or not _valid_date(m.group(1)):
        return False
    h, mi, se = (int(x) for x in m.group(2).split(":"))
    return h < 24 and mi < 60 and se < 61


FORMATS: dict[str, Callable[[str], bool]] = {
    "email": lambda s: bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", s)),
    "date": _valid_date,
    "date-time": _valid_datetime,
    "time": lambda s: bool(re.fullmatch(r"\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})", s)),
    "uri": lambda s: bool(re.fullmatch(r"[a-zA-Z][a-zA-Z0-9+.-]*:\S*", s)),
    "uuid": lambda s: bool(re.fullmatch(r"[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", s)),
    "ipv4": lambda s: bool(re.fullmatch(r"(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}", s)),
}
FORMAT_DEFAULTS: dict[str, Any] = {
    "email": "user@example.com",
    "uri": "https://example.com",
    "date": lambda: _dt.date.today().isoformat(),
    "date-time": lambda: _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "time": "00:00:00Z",
    "uuid": "00000000-0000-4000-8000-000000000000",
    "ipv4": "0.0.0.0",
}
ALL_TYPES = ["string", "number", "boolean", "object", "array", "null"]


# ------------------------------------------------------------------------ schema merging

def merge_schemas(a: dict, b: dict) -> dict:
    """Combine two normalised schemas into one that accepts only what both accept."""
    out = dict(a)
    for k, v in b.items():
        if k not in out:
            out[k] = v
            continue
        av = out[k]
        if k in ("properties", "patternProperties") and isinstance(av, dict) and isinstance(v, dict):
            m = dict(av)
            for pk, pv in v.items():
                m[pk] = {"allOf": [m[pk], pv]} if pk in m else pv
            out[k] = m
        elif k == "required" and isinstance(av, list) and isinstance(v, list):
            out[k] = list(dict.fromkeys(av + v))
        elif k == "enum" and isinstance(av, list) and isinstance(v, list):
            out[k] = [x for x in av if any(deep_equal(x, y) for y in v)]
        elif k == "type":
            res: list[str] = []
            for ta in ([av] if isinstance(av, str) else av):
                for tb in ([v] if isinstance(v, str) else v):
                    if ta == tb:
                        res.append(ta)
                    elif {ta, tb} == {"integer", "number"}:
                        res.append("integer")
            res = list(dict.fromkeys(res))
            out[k] = v if not res else res[0] if len(res) == 1 else res
        elif k in ("minimum", "minLength", "minItems", "minProperties", "exclusiveMinimum", "minContains"):
            out[k] = max(av, v) if _is_num(av) and _is_num(v) else v
        elif k in ("maximum", "maxLength", "maxItems", "maxProperties", "exclusiveMaximum", "maxContains"):
            out[k] = min(av, v) if _is_num(av) and _is_num(v) else v
        elif k == "additionalProperties":
            out[k] = False if av is False or v is False else v
        elif k in ("oneOf", "anyOf"):
            out["allOf"] = list(out.get("allOf", [])) + [{k: v}]
        else:
            out[k] = v
    return out


# ------------------------------------------------------------------------------- engine

class SchemaEngine:
    """Everything that depends only on the schema: validation, interpretation, defaults."""

    def __init__(self, schema: Any, validate_formats: bool = True):
        if not isinstance(schema, (dict, bool)):
            raise TypeError("schema must be a JSON Schema object (a dict)")
        self.schema = schema
        self.validate_formats = validate_formats
        self.variant_choice: dict[tuple[str, int], int] = {}   # (pointer, nesting level) -> chosen alternative
        self._re_cache: dict[str, re.Pattern] = {}
        self._anchor_map: Optional[dict[str, Any]] = None
        self._ff = 0                                           # >0: silent validity checks stop at the first error

    # ---- references --------------------------------------------------------------

    def _re(self, pattern: str) -> re.Pattern:
        rx = self._re_cache.get(pattern)
        if rx is None:
            translated = re.sub(r"\(\?<(?![=!])", "(?P<", pattern)      # JS named groups -> Python
            rx = self._re_cache[pattern] = re.compile(translated, re.ASCII)
        return rx

    def _anchors(self) -> dict[str, Any]:
        if self._anchor_map is None:
            found: dict[str, Any] = {}

            def walk(n: Any) -> None:
                if isinstance(n, list):
                    for x in n:
                        walk(x)
                elif isinstance(n, dict):
                    if isinstance(n.get("$anchor"), str):
                        found[n["$anchor"]] = n
                    if isinstance(n.get("$id"), str) and n["$id"].startswith("#"):
                        found[n["$id"][1:]] = n
                    for x in n.values():
                        walk(x)

            walk(self.schema)
            self._anchor_map = found
        return self._anchor_map

    def lookup(self, ref: Any) -> Any:
        if not isinstance(ref, str) or not ref.startswith("#"):
            raise ValueError(f'Unsupported $ref (only local "#..." references work): {ref}')
        if ref == "#":
            return self.schema
        from urllib.parse import unquote
        frag = unquote(ref[1:])
        if not frag.startswith("/"):
            if frag not in self._anchors():
                raise ValueError(f"Unresolvable $ref: {ref}")
            return self._anchors()[frag]
        cur = self.schema
        for tok in (_unesc(t) for t in frag[1:].split("/")):
            if isinstance(cur, dict) and tok in cur:
                cur = cur[tok]
            elif isinstance(cur, list) and _index(tok) is not None and _index(tok) < len(cur):
                cur = cur[_index(tok)]
            else:
                raise ValueError(f"Unresolvable $ref: {ref}")
        return cur

    # ---- validation --------------------------------------------------------------

    def validate_value(self, value: Any) -> list[dict]:
        errs: list[dict] = []
        self._v(self.schema, value, "", errs, 0)
        return errs

    def valid(self, schema: Any, value: Any, depth: int = 0) -> bool:
        """Silent validity check; stops at the first error, which keeps oneOf/anyOf cheap."""
        errs: list[dict] = []
        self._ff += 1
        try:
            self._v(schema, value, "", errs, depth + 1)
        finally:
            self._ff -= 1
        return not errs

    def _v(self, schema: Any, value: Any, ptr: str, errs: list[dict], depth: int) -> None:
        if schema is True or schema is None or schema is _MISSING:
            return

        def add(keyword: str, message: str, path: Optional[str] = None, **extra: Any) -> None:
            errs.append({"path": ptr if path is None else path, "keyword": keyword, "message": message, **extra})

        if schema is False:
            return add("false", "No value is allowed here")
        if not isinstance(schema, dict) or depth > 60:
            return
        silent = self._ff > 0                      # only validity matters, so stop at the first error

        def stop() -> bool:
            return silent and bool(errs)

        d1 = depth + 1
        props = schema["properties"] if isinstance(schema.get("properties"), dict) else {}
        pats = schema["patternProperties"] if isinstance(schema.get("patternProperties"), dict) else {}

        # 1. Cheap checks first, so wrong alternatives are rejected before any recursion.
        if "const" in schema and not deep_equal(schema["const"], value):
            add("const", "Must equal " + _dumps(schema["const"]))
        if isinstance(schema.get("enum"), list) and not any(deep_equal(e, value) for e in schema["enum"]):
            add("enum", "Must be one of the allowed values")
        if "type" in schema:
            ts = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
            if not any(is_type(value, t) for t in ts):
                add("type", "Must be of type " + " or ".join(map(str, ts)))
        if stop():
            return

        if _is_num(value):
            mn, mx = schema.get("minimum"), schema.get("maximum")
            ex_mn, ex_mx = schema.get("exclusiveMinimum"), schema.get("exclusiveMaximum")
            if _is_num(mn) and (value <= mn if ex_mn is True else value < mn):
                add("minimum", ("Must be greater than " if ex_mn is True else "Must be at least ") + _num(mn))
            if _is_num(mx) and (value >= mx if ex_mx is True else value > mx):
                add("maximum", ("Must be less than " if ex_mx is True else "Must be at most ") + _num(mx))
            if _is_num(ex_mn) and value <= ex_mn:
                add("exclusiveMinimum", "Must be greater than " + _num(ex_mn))
            if _is_num(ex_mx) and value >= ex_mx:
                add("exclusiveMaximum", "Must be less than " + _num(ex_mx))
            mo = schema.get("multipleOf")
            if _is_num(mo) and mo > 0:
                q = value / mo
                if abs(q - round(q)) > 1e-9:
                    add("multipleOf", "Must be a multiple of " + _num(mo))

        if isinstance(value, str):
            n = len(value)
            if "minLength" in schema and n < schema["minLength"]:
                add("minLength", f"Must be at least {schema['minLength']} characters")
            if "maxLength" in schema and n > schema["maxLength"]:
                add("maxLength", f"Must be at most {schema['maxLength']} characters")
            if isinstance(schema.get("pattern"), str) and not self._re(schema["pattern"]).search(value):
                add("pattern", "Must match the pattern " + schema["pattern"])
            fmt = schema.get("format")
            if self.validate_formats and isinstance(fmt, str) and fmt in FORMATS and not FORMATS[fmt](value):
                add("format", f"Must be a valid {fmt}")

        if isinstance(value, list):
            if "minItems" in schema and len(value) < schema["minItems"]:
                add("minItems", f"Must have at least {schema['minItems']} items")
            if "maxItems" in schema and len(value) > schema["maxItems"]:
                add("maxItems", f"Must have at most {schema['maxItems']} items")
            if schema.get("uniqueItems") is True and not stop():
                if any(deep_equal(value[i], value[j]) for i in range(len(value)) for j in range(i + 1, len(value))):
                    add("uniqueItems", "Items must be unique")

        if isinstance(value, dict):
            if "minProperties" in schema and len(value) < schema["minProperties"]:
                add("minProperties", f"Must have at least {schema['minProperties']} properties")
            if "maxProperties" in schema and len(value) > schema["maxProperties"]:
                add("maxProperties", f"Must have at most {schema['maxProperties']} properties")
            if isinstance(schema.get("required"), list):
                for k in schema["required"]:
                    if k not in value:
                        add("required", f'Missing required property "{k}"', key=k)
            for k in value:
                if schema.get("additionalProperties") is False and k not in props \
                        and not any(self._re(p).search(k) for p in pats):
                    add("additionalProperties", f'Property "{k}" is not allowed')
                if "propertyNames" in schema and not self.valid(schema["propertyNames"], k, d1):
                    add("propertyNames", f'Property name "{k}" is not allowed')
        if stop():
            return

        # 2. Combinators.
        if "$ref" in schema:
            self._v(self.lookup(schema["$ref"]), value, ptr, errs, d1)
        if isinstance(schema.get("allOf"), list):
            for s in schema["allOf"]:
                self._v(s, value, ptr, errs, d1)
        if stop():
            return
        if isinstance(schema.get("anyOf"), list) and not any(self.valid(s, value, d1) for s in schema["anyOf"]):
            add("anyOf", "Must match at least one of the allowed alternatives")
        if isinstance(schema.get("oneOf"), list):
            n = sum(1 for s in schema["oneOf"] if self.valid(s, value, d1))
            if n == 0:
                add("oneOf", "Must match exactly one of the allowed alternatives")
            elif n > 1:
                add("oneOf", "Matches more than one of the mutually exclusive alternatives")
        if "not" in schema and self.valid(schema["not"], value, d1):
            add("not", "Matches a schema it must not match")
        if "if" in schema:
            branch = schema.get("then", _MISSING) if self.valid(schema["if"], value, d1) else schema.get("else", _MISSING)
            if branch is not _MISSING:
                self._v(branch, value, ptr, errs, d1)
        if stop():
            return

        # 3. Recursion into children.
        if isinstance(value, list):
            prefix = schema["prefixItems"] if isinstance(schema.get("prefixItems"), list) else \
                schema["items"] if isinstance(schema.get("items"), list) else []
            if isinstance(schema.get("prefixItems"), list):
                rest = schema.get("items", _MISSING)
            elif isinstance(schema.get("items"), list):
                rest = schema.get("additionalItems", _MISSING)
            else:
                rest = schema.get("items", _MISSING)
            for i, it in enumerate(value):
                sub = prefix[i] if i < len(prefix) else rest
                if sub is not _MISSING:
                    self._v(sub, it, f"{ptr}/{i}", errs, d1)
            if "contains" in schema:
                n = sum(1 for it in value if self.valid(schema["contains"], it, d1))
                lo = schema.get("minContains", 1)
                if n < lo:
                    add("contains", f"Must contain at least {lo} matching item" + ("" if lo == 1 else "s"))
                if "maxContains" in schema and n > schema["maxContains"]:
                    add("maxContains", f"Must contain at most {schema['maxContains']} matching items")

        if isinstance(value, dict):
            for k in props:                          # schema order: discriminating keys come first
                if k in value:
                    self._v(props[k], value[k], f"{ptr}/{_esc(k)}", errs, d1)
            ap = schema.get("additionalProperties", _MISSING)
            for k, v in value.items():
                kp = f"{ptr}/{_esc(k)}"
                matched = k in props
                for p in pats:
                    if self._re(p).search(k):
                        matched = True
                        self._v(pats[p], v, kp, errs, d1)
                if not matched and ap is not _MISSING and ap is not False:
                    self._v(ap, v, kp, errs, d1)
            dr = schema.get("dependentRequired")
            if isinstance(dr, dict):
                for k, req in dr.items():
                    if k in value:
                        for r in req:
                            if r not in value:
                                add("dependentRequired", f'"{r}" is required when "{k}" is present', key=r)
            ds = schema.get("dependentSchemas")
            if isinstance(ds, dict):
                for k, sub in ds.items():
                    if k in value:
                        self._v(sub, value, ptr, errs, d1)
            deps = schema.get("dependencies")
            if isinstance(deps, dict):
                for k, dep in deps.items():
                    if k in value:
                        if isinstance(dep, list):
                            for r in dep:
                                if r not in value:
                                    add("dependencies", f'"{r}" is required when "{k}" is present', key=r)
                        else:
                            self._v(dep, value, ptr, errs, d1)

    # ---- interpreting schemas ----------------------------------------------------

    def norm(self, schema: Any, value: Any = _MISSING, depth: int = 0) -> dict:
        """Flatten $ref and allOf and, given a value, if/then/else and dependent schemas."""
        if schema is True or schema is None or schema is _MISSING:
            return {}
        if schema is False:
            return {"not": {}}
        if not isinstance(schema, dict) or depth > 40:
            return {}
        s = dict(schema)
        if "$ref" in s:
            target = self.norm(self.lookup(s.pop("$ref")), value, depth + 1)
            s = merge_schemas(target, s)
        for _ in range(10):
            if "allOf" not in s:
                break
            for part in s.pop("allOf"):
                s = merge_schemas(s, self.norm(part, value, depth + 1))
        if value is not _MISSING:
            if "if" in s:
                cond = s.pop("if")
                then, other = s.pop("then", _MISSING), s.pop("else", _MISSING)
                branch = then if self.valid(cond, value, depth) else other
                if branch is not _MISSING:
                    s = merge_schemas(s, self.norm(branch, value, depth + 1))
            if isinstance(value, dict):
                for key in ("dependentSchemas", "dependencies"):
                    deps = s.get(key)
                    if not isinstance(deps, dict):
                        continue
                    del s[key]
                    for k, sub in deps.items():
                        if k in value and not isinstance(sub, list):
                            s = merge_schemas(s, self.norm(sub, value, depth + 1))
        return s

    def types_of(self, s: dict) -> list[str]:
        """The JSON types a normalised schema allows (best effort when `type` is omitted)."""
        if "type" in s:
            return list(dict.fromkeys(s["type"] if isinstance(s["type"], list) else [s["type"]]))
        if "const" in s:
            return [type_of(s["const"])]
        if isinstance(s.get("enum"), list) and s["enum"]:
            return list(dict.fromkeys(type_of(v) for v in s["enum"]))
        if any(k in s for k in ("properties", "patternProperties", "additionalProperties", "required",
                                "minProperties", "maxProperties", "propertyNames")):
            return ["object"]
        if any(k in s for k in ("items", "prefixItems", "minItems", "maxItems", "contains")) or s.get("uniqueItems"):
            return ["array"]
        if any(k in s for k in ("minLength", "maxLength", "pattern", "format")):
            return ["string"]
        if any(k in s for k in ("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf")):
            return ["number"]
        return list(ALL_TYPES)

    def prop_schema(self, s: dict, key: str) -> Any:
        """The schema for property `key` of a normalised object schema; None if not allowed."""
        parts = []
        if isinstance(s.get("properties"), dict) and key in s["properties"]:
            parts.append(s["properties"][key])
        if isinstance(s.get("patternProperties"), dict):
            parts.extend(sub for p, sub in s["patternProperties"].items() if self._re(p).search(key))
        if not parts:
            ap = s.get("additionalProperties", _MISSING)
            if ap is False:
                return None
            return {} if ap is _MISSING or ap is True else ap
        if len(parts) == 1:
            return None if parts[0] is False else parts[0]
        return {"allOf": parts}

    def item_schema(self, s: dict, i: int) -> Any:
        """The schema for array item `i` (False if no such item is allowed)."""
        if isinstance(s.get("prefixItems"), list):
            prefix, rest = s["prefixItems"], s.get("items", _MISSING)
        elif isinstance(s.get("items"), list):
            prefix, rest = s["items"], s.get("additionalItems", _MISSING)
        else:
            prefix, rest = [], s.get("items", _MISSING)
        if i < len(prefix):
            return prefix[i]
        return {} if rest is _MISSING else rest

    def prefix_len(self, s: dict) -> int:
        if isinstance(s.get("prefixItems"), list):
            return len(s["prefixItems"])
        return len(s["items"]) if isinstance(s.get("items"), list) else 0

    def branch_label(self, b: Any, i: int) -> str:
        if isinstance(b, dict):
            if b.get("title"):
                return str(b["title"])
            if isinstance(b.get("$ref"), str):
                try:
                    t = self.lookup(b["$ref"])
                    if isinstance(t, dict) and t.get("title"):
                        return str(t["title"])
                except ValueError:
                    pass
                return b["$ref"].split("/")[-1]
            if "const" in b:
                return _dumps(b["const"])
            if "type" in b:
                return " | ".join(b["type"] if isinstance(b["type"], list) else [b["type"]])
        return f"Option {i + 1}"

    def variants(self, s: dict, value: Any, ptr: str = "", level: int = 0) -> Optional[tuple[list[dict], int]]:
        """Alternatives the user can switch between: oneOf/anyOf branches or a list of types."""
        key = "oneOf" if isinstance(s.get("oneOf"), list) else "anyOf" if isinstance(s.get("anyOf"), list) else None
        lst: Optional[list[dict]] = None
        if key:
            base = {k: v for k, v in s.items() if k != key}
            lst = [{"label": self.branch_label(b, i), "schema": merge_schemas(base, self.norm(b))}
                   for i, b in enumerate(s[key])]
            counts: dict[str, int] = {}
            for v in lst:
                counts[v["label"]] = counts.get(v["label"], 0) + 1
            for i, v in enumerate(lst):
                if counts[v["label"]] > 1:
                    v["label"] += f" #{i + 1}"
        elif "const" not in s and not isinstance(s.get("enum"), list):
            ts = self.types_of(s)
            if len(ts) > 1:
                lst = [{"label": t, "schema": {**s, "type": t}} for t in ts]
        if not lst:
            return None
        prefer = self.variant_choice.get((ptr, level))
        if prefer is not None and 0 <= prefer < len(lst) and self.valid(lst[prefer]["schema"], value):
            return lst, prefer
        idx = next((i for i, v in enumerate(lst) if self.valid(v["schema"], value)), -1)
        if idx < 0:
            idx = next((i for i, v in enumerate(lst)
                        if any(is_type(value, t) for t in self.types_of(self.norm(v["schema"], value)))), 0)
        return lst, idx

    def resolve(self, raw: Any, value: Any, ptr: str = "") -> tuple[dict, list[tuple[list[dict], int]]]:
        """Normalise `raw` for `value`, descending through alternatives.

        Returns (effective schema, [(alternatives, chosen index), ...] outermost first)."""
        chain: list[tuple[list[dict], int]] = []
        s = self.norm(raw, value)
        for level in range(8):
            v = self.variants(s, value, ptr, level)
            if not v:
                break
            chain.append(v)
            s = self.norm(v[0][v[1]]["schema"], value)
        return s, chain

    def schema_at(self, doc: Any, path) -> Any:
        """The raw schema that applies to the node at `path` (None if nothing is allowed there)."""
        raw, val = self.schema, doc
        path = list(path)
        for i, k in enumerate(path):
            s, _ = self.resolve(raw, val, to_ptr(path[:i]))
            if isinstance(val, dict):
                raw, val = self.prop_schema(s, str(k)), val.get(str(k), _MISSING)
            elif isinstance(val, list) and _index(k) is not None and _index(k) < len(val):
                raw, val = self.item_schema(s, _index(k)), val[_index(k)]
            else:
                return None
            if raw is None or val is _MISSING:
                return None
        return raw

    def effective_at(self, doc: Any, path) -> Optional[dict]:
        raw = self.schema_at(doc, path)
        if raw is None:
            return None
        return self.resolve(raw, get_at(doc, path), to_ptr(path))[0]

    # ---- default values ----------------------------------------------------------

    def candidates(self, schema: Any, depth: int = 0) -> list[Any]:
        """Values worth trying when adding to an array, best first (default, then enum values
        or alternatives), so that e.g. a uniqueItems list can still grow."""
        s = self.norm(schema)
        out: list[Any] = []
        if "default" in s:
            out.append(clone(s["default"]))
        if "const" in s:
            out.append(clone(s["const"]))
        elif isinstance(s.get("enum"), list) and s["enum"]:
            out.extend(clone(v) for v in s["enum"])
        else:
            key = "oneOf" if isinstance(s.get("oneOf"), list) else "anyOf" if isinstance(s.get("anyOf"), list) else None
            if key and "default" not in s:
                base = {k: v for k, v in s.items() if k != key}
                out.extend(self.default_for(merge_schemas(base, self.norm(b)), depth + 1) for b in s[key])
            elif "default" not in s:
                out.append(self.default_for(schema, depth + 1))
        return out or [self.default_for(schema, depth + 1)]

    def default_for(self, schema: Any, depth: int = 0) -> Any:
        """The smallest sensible value for a schema (new items, properties, type switches)."""
        if depth > 8:
            return None
        s = self.norm(schema)
        if "default" in s:
            return clone(s["default"])
        if "const" in s:
            return clone(s["const"])
        if isinstance(s.get("enum"), list) and s["enum"]:
            return clone(s["enum"][0])
        key = "oneOf" if isinstance(s.get("oneOf"), list) else "anyOf" if isinstance(s.get("anyOf"), list) else None
        if key:
            base = {k: v for k, v in s.items() if k != key}
            first: Any = _MISSING
            for b in s[key]:
                m = merge_schemas(base, self.norm(b))
                v = self.default_for(m, depth + 1)
                if first is _MISSING:
                    first = v
                if self.valid(m, v):
                    return v
            return None if first is _MISSING else first
        t = self.types_of(s)[0]
        if t == "object":
            o: dict[str, Any] = {}
            if depth > 6:
                return o

            def fill(sx: dict) -> None:
                for k in sx["required"] if isinstance(sx.get("required"), list) else []:
                    if k in o:
                        continue
                    sub = self.prop_schema(sx, k)
                    if sub is not None:
                        o[k] = self.default_for(sub, depth + 1)

            fill(s)
            fill(self.norm(schema, o))              # picks up if/then/else and dependent requirements
            need = s.get("minProperties", 0)
            for k, sub in (s["properties"].items() if isinstance(s.get("properties"), dict) else []):
                if len(o) >= need:
                    break
                if k not in o:
                    o[k] = self.default_for(sub, depth + 1)
            return o
        if t == "array":
            a: list[Any] = []
            if depth > 6:
                return a
            for i in range(s.get("minItems", 0)):
                item = self.item_schema(s, i)
                if s.get("uniqueItems") is True:         # choose values that don't repeat
                    cands = self.candidates(item, depth + 1)
                    v = next((c for c in cands if not any(deep_equal(x, c) for x in a)), cands[0])
                else:
                    v = self.default_for(item, depth + 1)
                a.append(v)
            return a
        if t == "string":
            fd = FORMAT_DEFAULTS.get(s.get("format"))
            text = "" if fd is None else fd() if callable(fd) else fd
            while len(text) < s.get("minLength", 0):
                text += "x"
            if "maxLength" in s:
                text = text[: s["maxLength"]]
            return text
        if t in ("number", "integer"):
            step = s["multipleOf"] if _is_num(s.get("multipleOf")) and s["multipleOf"] > 0 else (1 if t == "integer" else None)
            lo = hi = None
            lo_strict = hi_strict = False
            if _is_num(s.get("minimum")):
                lo, lo_strict = s["minimum"], s.get("exclusiveMinimum") is True
            if _is_num(s.get("exclusiveMinimum")) and (lo is None or s["exclusiveMinimum"] >= lo):
                lo, lo_strict = s["exclusiveMinimum"], True
            if _is_num(s.get("maximum")):
                hi, hi_strict = s["maximum"], s.get("exclusiveMaximum") is True
            if _is_num(s.get("exclusiveMaximum")) and (hi is None or s["exclusiveMaximum"] <= hi):
                hi, hi_strict = s["exclusiveMaximum"], True
            v: float = 0
            if lo is not None and hi is not None and not step:
                v = (lo + hi) / 2
            else:
                if lo is not None and (v < lo or (lo_strict and v <= lo)):
                    v = -(-lo // step) * step if step else lo
                    if lo_strict and v <= lo:
                        v = v + step if step else lo + 1
                if hi is not None and (v > hi or (hi_strict and v >= hi)):
                    v = (hi // step) * step if step else hi
                    if hi_strict and v >= hi:
                        v = v - step if step else hi - 1
            v = round(v, 10)
            return int(v) if float(v).is_integer() else v
        if t == "boolean":
            return False
        return None


def _num(n: Any) -> str:
    return str(int(n)) if isinstance(n, float) and n.is_integer() else str(n)
