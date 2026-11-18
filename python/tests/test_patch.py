"""JSON Patch (RFC 6902): applying patches and working them out."""
import copy
import random

import pytest

from schmeditor import PatchError, apply_patch
from schmeditor.engine import deep_equal
from schmeditor.patch import diff_patch


def op(kind, path, **rest):
    return {"op": kind, "path": path, **rest}


@pytest.mark.parametrize("doc, patch, expected", [
    # RFC 6902 appendix A
    ({"foo": "bar"}, [op("add", "/baz", value="qux")], {"foo": "bar", "baz": "qux"}),                       # A.1
    ({"foo": ["bar", "baz"]}, [op("add", "/foo/1", value="qux")], {"foo": ["bar", "qux", "baz"]}),          # A.2
    ({"baz": "qux", "foo": "bar"}, [op("remove", "/baz")], {"foo": "bar"}),                                  # A.3
    ({"foo": ["bar", "qux", "baz"]}, [op("remove", "/foo/1")], {"foo": ["bar", "baz"]}),                     # A.4
    ({"baz": "qux", "foo": "bar"}, [op("replace", "/baz", value="boo")], {"baz": "boo", "foo": "bar"}),      # A.5
    ({"foo": {"bar": "baz", "waldo": "fred"}, "qux": {"corge": "grault"}},
     [op("move", "/qux/thud", **{"from": "/foo/waldo"})],
     {"foo": {"bar": "baz"}, "qux": {"corge": "grault", "thud": "fred"}}),                                   # A.6
    ({"foo": ["all", "grass", "cows", "eat"]}, [op("move", "/foo/3", **{"from": "/foo/1"})],
     {"foo": ["all", "cows", "eat", "grass"]}),                                                              # A.7
    ({"baz": "qux", "foo": ["a", 2, "c"]}, [op("test", "/baz", value="qux"), op("test", "/foo/1", value=2)],
     {"baz": "qux", "foo": ["a", 2, "c"]}),                                                                  # A.8
    ({"foo": "bar"}, [op("add", "/child", value={"grandchild": {}})],
     {"foo": "bar", "child": {"grandchild": {}}}),                                                           # A.10
    ({"foo": "bar"}, [op("add", "/baz", value="qux", xyz=123)], {"foo": "bar", "baz": "qux"}),               # A.11
    ({"/": 9, "~1": 10}, [op("test", "/~01", value=10)], {"/": 9, "~1": 10}),                                # A.14
    ({"foo": ["bar"]}, [op("add", "/foo/-", value=["abc", "def"])], {"foo": ["bar", ["abc", "def"]]}),       # A.16
    ({"a": [1]}, [op("copy", "/b", **{"from": "/a"})], {"a": [1], "b": [1]}),
    (1, [op("replace", "", value=2)], 2),
    ({"a": None}, [op("replace", "/a", value=None)], {"a": None}),
])
def test_rfc_examples(doc, patch, expected):
    assert apply_patch(doc, patch) == expected


@pytest.mark.parametrize("doc, patch", [
    ({"baz": "qux"}, [op("test", "/baz", value="bar")]),                                                    # A.9
    ({"foo": "bar"}, [op("add", "/baz/bat", value="qux")]),                                                  # A.12
    ({"/": 9, "~1": 10}, [op("test", "/~01", value="10")]),                                                  # A.15
    ({"a": 1}, [op("test", "/a", value=True)]),                       # true is not 1
    ({"a": [1, 2, 3]}, [op("remove", "/a/3")]),
    ({"a": [1, 2, 3]}, [op("remove", "/nope")]),
    ({"a": [1, 2, 3]}, [op("replace", "/nope", value=1)]),
    ({"a": [1, 2, 3]}, [op("add", "/a/05", value=1)]),                # leading zero
    ({"a": [1, 2, 3]}, [op("add", "/a/9", value=1)]),
    ({"a": [1, 2, 3]}, [op("move", "/a/0", **{"from": "/a"})]),       # into itself
    ({"a": 1}, [op("frobnicate", "/a")]),
    ({"a": 1}, [op("add", "no-slash", value=1)]),
    ({"a": 1}, [{"op": "add", "value": 1}]),                          # no path
    ({"a": 1}, ["not an operation"]),
])
def test_bad_patches_are_rejected_naming_the_operation(doc, patch):
    with pytest.raises(PatchError, match="JSON Patch operation 0"):
        apply_patch(doc, patch)


def test_patch_must_be_a_list():
    with pytest.raises(PatchError, match="list"):
        apply_patch({}, {"op": "remove", "path": "/a"})


def test_apply_patch_leaves_its_input_alone():
    doc = {"a": [1, 2, 3]}
    patch = [op("remove", "/a/0"), op("add", "/b", value=[1])]
    out = apply_patch(doc, patch)
    out["b"].append(2)
    assert doc == {"a": [1, 2, 3]} and patch[1]["value"] == [1]


def test_replace_happens_in_place_so_positions_are_kept():
    out = apply_patch({"a": 1, "b": 2, "c": 3, "d": [1, 2, 3]},
                      [op("replace", "/a", value=9), op("replace", "/d/1", value=7)])
    assert list(out) == ["a", "b", "c", "d"] and out["d"] == [1, 7, 3]


def test_json_equality_is_used_throughout():
    assert diff_patch({"a": 1}, {"a": True}) == [op("replace", "/a", value=True)]
    assert diff_patch({"a": 1}, {"a": 1.0}) == []
    assert diff_patch([True], [1]) == [op("replace", "/0", value=1)]


@pytest.mark.parametrize("a, b, expected", [
    ({"a": 1}, {"a": 2}, [op("replace", "/a", value=2)]),
    ({"a": 1}, {"a": 1, "b": 2}, [op("add", "/b", value=2)]),
    ({"a": 1, "b": 2}, {"a": 1}, [op("remove", "/b")]),
    ([1, 2, 3], [1, 2, 3, 4], [op("add", "/3", value=4)]),
    ([1, 2, 3], [0, 1, 2, 3], [op("add", "/0", value=0)]),
    ([1, 2, 3], [2, 3], [op("remove", "/0")]),
    ([1, 2, 3], [1, 9, 3], [op("replace", "/1", value=9)]),
    ({"a": {"b": [1]}}, {"a": {"b": [1, 2]}}, [op("add", "/a/b/1", value=2)]),
    ({"a/b": 1, "c~d": 2}, {"a/b": 5, "c~d": 2}, [op("replace", "/a~1b", value=5)]),
    ("x", "y", [op("replace", "", value="y")]),
])
def test_diffs_are_small_and_sensible(a, b, expected):
    assert diff_patch(a, b) == expected


def test_diffs_always_reproduce_the_target_document():
    rng = random.Random(12345)

    def scalar():
        return rng.choice([0, 1, 2, "a", "b", "", True, False, None, 1.5, "/", "~"])

    def value(depth):
        r = rng.random()
        if depth > 3 or r < 0.35:
            return scalar()
        if r < 0.7:
            return [value(depth + 1) for _ in range(rng.randrange(5))]
        return {rng.choice(["a", "b", "c", "d", "a/b", "x~y"]): value(depth + 1) for _ in range(rng.randrange(4))}

    def mutate(v):
        if isinstance(v, list) and rng.random() < 0.8:
            a = copy.deepcopy(v)
            r = rng.random()
            if r < 0.25 and a:
                del a[rng.randrange(len(a))]
            elif r < 0.5:
                a.insert(rng.randrange(len(a) + 1), value(2))
            elif r < 0.7 and len(a) > 1:
                a.insert(rng.randrange(len(a)), a.pop(rng.randrange(len(a))))
            elif a:
                i = rng.randrange(len(a))
                a[i] = mutate(a[i])
            return a
        if isinstance(v, dict) and rng.random() < 0.8:
            o = copy.deepcopy(v)
            r = rng.random()
            if r < 0.3 and o:
                del o[rng.choice(list(o))]
            elif r < 0.6:
                o[rng.choice(["a", "b", "c", "e"])] = value(2)
            elif o:
                k = rng.choice(list(o))
                o[k] = mutate(o[k])
            return o
        return value(1)

    for _ in range(4000):
        a = value(0)
        b = mutate(a) if rng.random() < 0.7 else value(0)
        patch = diff_patch(a, b)
        assert deep_equal(apply_patch(a, patch), b), (a, b, patch)
