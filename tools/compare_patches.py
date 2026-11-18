#!/usr/bin/env python3
"""Check that the JavaScript and Python JSON Patch implementations agree.

For many pairs of documents (the examples with random mutations, plus random JSON), both
implementations work out a patch from one document to the other. The patches must be identical,
and each implementation's apply function must turn the first document into the second using
the patch the *other* one produced.

    cd javascript && npm install      # once, for jsdom
    python tools/compare_patches.py [--seed N] [--cases N]
"""
import argparse
import json
import random
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_validators import mutate  # noqa: E402  (random mutation of a document)
from schmeditor.engine import deep_equal  # noqa: E402
from schmeditor.patch import apply_patch, diff_patch  # noqa: E402

# Integral floats are left out: JSON has one number type, so 1.0 would become 1 on the way to JavaScript.
SCALARS = [0, 1, 2, "a", "b", "", True, False, None, 1.5, "/", "~"]
KEYS = ["a", "b", "c", "d", "a/b", "x~y"]            # not integer-like: JavaScript orders those first


def random_value(rng, depth=0):
    r = rng.random()
    if depth > 3 or r < 0.35:
        return rng.choice(SCALARS)
    if r < 0.7:
        return [random_value(rng, depth + 1) for _ in range(rng.randrange(5))]
    return {rng.choice(KEYS): random_value(rng, depth + 1) for _ in range(rng.randrange(4))}


def random_edit(rng, v):
    if isinstance(v, list) and rng.random() < 0.8:
        a = json.loads(json.dumps(v))
        r = rng.random()
        if r < 0.25 and a:
            del a[rng.randrange(len(a))]
        elif r < 0.5:
            a.insert(rng.randrange(len(a) + 1), random_value(rng, 2))
        elif r < 0.7 and len(a) > 1:
            a.insert(rng.randrange(len(a)), a.pop(rng.randrange(len(a))))
        elif a:
            i = rng.randrange(len(a))
            a[i] = random_edit(rng, a[i])
        return a
    if isinstance(v, dict) and rng.random() < 0.8:
        o = json.loads(json.dumps(v))
        r = rng.random()
        if r < 0.3 and o:
            del o[rng.choice(list(o))]
        elif r < 0.6:
            o[rng.choice(["a", "b", "c", "e"])] = random_value(rng, 2)
        elif o:
            k = rng.choice(list(o))
            o[k] = random_edit(rng, o[k])
        return o
    return random_value(rng, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--cases", type=int, default=1500, help="random pairs (default 1500); the examples add as many again")
    args = ap.parse_args()
    rng = random.Random(args.seed)
    load = lambda name: json.loads((ROOT / "examples" / name).read_text(encoding="utf-8"))
    contact, doc = load("contact.schema.json"), load("contact.json")

    pairs = [(doc, mutate(rng, doc)) for _ in range(args.cases // 2)]
    pairs += [(contact, mutate(rng, contact)) for _ in range(args.cases // 2)]
    pairs += [(a, random_edit(rng, a)) for a in (random_value(rng) for _ in range(args.cases))]
    pairs += [(random_value(rng), random_value(rng)) for _ in range(args.cases // 3)]
    corpus = [{"a": a, "b": b, "py": diff_patch(a, b)} for a, b in pairs]

    with tempfile.TemporaryDirectory() as tmp:
        corpus_file, out_file = Path(tmp, "corpus.json"), Path(tmp, "js.json")
        corpus_file.write_text(json.dumps(corpus))
        done = subprocess.run(["node", str(ROOT / "tools" / "compare_patches.js"), str(corpus_file), str(out_file)],
                              capture_output=True, text=True)
        if done.returncode:
            sys.exit(f"The JavaScript side failed (did you run `npm install` in javascript/?):\n{done.stderr}")
        js = json.loads(out_file.read_text())

    different, js_cannot_apply, py_cannot_apply = [], [], []
    for i, ((a, b), case, theirs) in enumerate(zip(pairs, corpus, js)):
        if theirs["js"] != case["py"]:
            different.append(i)
        if not theirs["appliesPython"]:
            js_cannot_apply.append(i)
        try:
            if not deep_equal(apply_patch(a, theirs["js"]), b):
                py_cannot_apply.append(i)
        except ValueError:
            py_cannot_apply.append(i)
    nonempty = sum(1 for c in corpus if c["py"])
    print(f"{len(pairs)} pairs ({nonempty} with a non-empty patch): {len(pairs) - len(different)} identical patches, "
          f"{len(different)} different; JS applies Python's patch: {len(pairs) - len(js_cannot_apply)}/{len(pairs)}; "
          f"Python applies JS's patch: {len(pairs) - len(py_cannot_apply)}/{len(pairs)}")
    for i in different[:3]:
        print("\nDIFFERENT PATCHES for", json.dumps(pairs[i][0])[:100], "->", json.dumps(pairs[i][1])[:100])
        print("  python:", json.dumps(corpus[i]["py"])[:200])
        print("  js:    ", json.dumps(js[i]["js"])[:200])
    return 1 if (different or js_cannot_apply or py_cannot_apply) else 0


if __name__ == "__main__":
    sys.exit(main())
