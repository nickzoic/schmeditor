# schmeditor

[![CI](https://github.com/nickzoic/schmeditor/actions/workflows/ci.yml/badge.svg)](https://github.com/nickzoic/schmeditor/actions/workflows/ci.yml)

A small, schema-driven editor for JSON documents, in two flavours that work the same way:

* **[`javascript/`](javascript)**: a dependency-free browser component. Give it a `<div>`, a JSON
  Schema and a document, and it renders a form you can edit.
* **[`python/`](python)**: a terminal UI built on [Textual](https://textual.textualize.io/), usable
  from the command line or as a library function.

Both are built on one idea: **an edit is only accepted if it leaves the document at least as valid
as it was.** Every change is tried on a copy of the document and validated against the *whole*
schema. If it would introduce a new validation error, it is refused and the reason is shown.
A document that starts out valid therefore stays valid, however you edit it.

## What it does

* Edits strings, numbers, integers, booleans, `null`, enums, objects and arrays, with the schema's
  `title`, `description` and constraints shown beside each field. In an enum, anything that isn't a
  string (`null`, `true`, `false`, numbers, objects and arrays) is shown in a distinct colour and a
  fixed-width font, so it can't be mistaken for the string `"null"`, `"true"` and so on (browser
  component).
* **Refuses bad edits with a reason.** Typing `ab` into a field with `minLength: 3` shows why it
  isn't accepted; the document keeps its last valid value.
* **Handles alternatives.** `oneOf`/`anyOf` branches and multi-type fields (`["string", "null"]`)
  get a selector that swaps in a valid default for the chosen alternative.
* **Follows conditional schemas.** `if`/`then`/`else`, `dependentSchemas` and `dependencies` change
  which fields exist as values change, and a property that becomes required is added with a default.
* **Adds, removes and reorders** properties and array items, within `minItems`/`maxItems`,
  `minProperties`/`maxProperties`, `uniqueItems`, tuples (`prefixItems`, `items` arrays) and
  `additionalProperties`/`patternProperties`.
* **Works on documents that start invalid.** Their errors are shown, and edits may only reduce them.
* Exposes a **programmatic API** to read and change the document, and a **change callback** that
  receives each change as a [JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902) (RFC 6902).
* **Shows arrays of simple objects as tables**, a row per object and a column per property, when there is
  room (browser component).
* **Lets you draw any node yourself.** The browser component has a `render` hook that can replace how
  a node is drawn, based on its schema and value, and fall back to the normal rendering otherwise.
* The browser component **follows the browser's light/dark setting**.

## Repository layout

| Path | Contents |
| --- | --- |
| [`javascript/`](javascript) | `schmeditor.js` (component), `schmeditor.css` (stylesheet), `index.html` + `demo.js` (demonstration page), tests |
| [`python/`](python) | the `schmeditor` package (`pyproject.toml`, `src/`, `tests/`) |
| [`examples/`](examples) | shared example schemas and documents, used by both demos and both test suites |
| [`tools/`](tools) | `compare_validators.py` and `compare_patches.py`: check that the two implementations report identical validation errors and JSON Patches |

## JavaScript

Include the stylesheet and the script, then create an editor:

```html
<link rel="stylesheet" href="schmeditor.css">
<div id="editor"></div>
<script src="schmeditor.js"></script>
<script>
  const editor = new SchemaEditor(document.getElementById('editor'), schema, doc);
  editor.onChange((doc, info) => console.log(info.path, doc));
</script>
```

`schmeditor.js` has no dependencies and also works as a CommonJS module (`require`).

**Light and dark.** The stylesheet follows the browser's colour-scheme setting
(`prefers-color-scheme`). The editor paints its own background and text colour, using the browser's
`Canvas` and `CanvasText`, so form controls and scrollbars match too, and its error and focus
colours switch to lighter shades on dark. To force a theme whatever the browser says, put an
attribute on the element you render into: `<div id="editor" data-theme="dark"></div>` (or
`"light"`). To restyle it, or to blend it into a page that manages its own colours, set custom
properties on `.se-root`:

```css
.se-root { --se-bg: transparent; --se-fg: inherit; --se-padding: 0; }   /* take the page's colours */
.se-root { --se-err: #b00020; --se-focus: #0a7; }                         /* or change the accents */
```

The properties are `--se-bg`, `--se-fg`, `--se-padding`, `--se-line`, `--se-soft`, `--se-muted`,
`--se-err`, `--se-focus`, `--se-literal` (the colour of values in an enum that aren't strings), `--se-font`
and `--se-mono`.

**Demonstration page.** Open [`javascript/index.html`](javascript/index.html) in a browser (no
build step or server is needed). It has two examples:

1. a contact schema that uses every supported keyword, with a hint on each field naming the
   keyword it demonstrates, plus buttons that call the programmatic API;
2. the [metaschema](#a-metaschema-an-editor-for-schemas), with a live form built from the schema
   you are editing.

### API

| | |
| --- | --- |
| `new SchemaEditor(element, schema, document, options?)` | Render the editor into `element`. Omit `document` to start from a minimal valid one. |
| `editor.onChange(callback)` | Run `callback(doc, info)` after each user edit (see below). Pass `null` to clear. |
| `editor.getDocument()` / `editor.setDocument(doc)` | Read a copy of the document, or replace it (it need not be valid). |
| `editor.get(path)` | Read a copy of a value. |
| `editor.set(path, value)` / `editor.remove(path)` | Replace or add a value; delete a property or array item. |
| `editor.insert(path, index, value)` / `editor.push(path, value)` | Add to an array. |
| `editor.validate()` / `editor.isValid()` | `[{path, keyword, message}, …]` for the current document. |
| `editor.destroy()` | Empty the container and drop the callback. |

**The change callback** is called as `callback(doc, info)`. `doc` is a copy of the whole document and
`info` is `{source, patch, path, value}`:

| | |
| --- | --- |
| `source` | `'user'` for edits made in the page, or `'api'` for `set`/`remove`/… when `notifyOnProgrammatic` is on |
| `patch` | a [JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902) (RFC 6902): applied to the document as it was before the change, it gives `doc` |
| `path` | JSON Pointer to the main thing that changed (`""` for the whole document) |
| `value` | a copy of the new value at `path`, or `undefined` if it was removed |

```js
editor.onChange((doc, info) => {
  // typing "Alice" in the name field:
  //   info.patch  -> [{ op: 'replace', path: '/name', value: 'Alice' }]
  // choosing role "staff", which makes `department` required, so the editor fills it in:
  //   info.patch  -> [{ op: 'replace', path: '/role', value: 'staff' },
  //                   { op: 'add', path: '/department', value: 'Operations' }]
  mirror = SchemaEditor.applyPatch(mirror, info.patch);   // keep another copy in step
});
```

The patch describes what the user did: `replace`, `add` or `remove`, and `move` for reordering an
array item or renaming a property; choosing another `oneOf` alternative replaces the whole value.
Anything else the editor changed along with the edit, such as filling in a newly required property,
follows as further operations. The patch is checked against the document before it is sent, so it is
never wrong: in the unlikely case that it could not reproduce the document, it is a single `replace`
of the whole document.

For a removal `value` is `undefined`, even when a later array item shifts into the removed item's
index. Moving an array item changes two items, so `path` is the array and `value` its new contents;
`insert` and `push` likewise report the array (their patch has the `add`).

`SchemaEditor.applyPatch(doc, patch)` applies a JSON Patch to a copy of a document and returns it. It
implements all six RFC 6902 operations, throws an `Error` naming the failing operation, and does not
check the result against any schema.

Paths are JSON Pointers (`"/tags/0"`, `""` for the root) or arrays of keys. The programmatic edits
are checked like UI edits: a change that would make the document less valid throws an `Error` whose
`.errors` lists the problems, and the document is left untouched.

Options: `onChange`; `notifyOnProgrammatic` (default `false`: also call the callback for
`set`/`remove`/`insert`/`push`/`setDocument`, with `source: 'api'`); `validateFormats` (default
`true`: treat `format` as an assertion); `render` (a hook to draw nodes yourself, below).

### Arrays as tables

An array whose items are objects with a fixed set of simple properties is shown as a table: a row per
object and a column per property, with the property's `title` (or name) as the heading and a `*` on
the required ones, and the usual buttons to move and remove a row. Each cell is the normal editor
for that property, so checking, change notifications (with their patches) and the `render` hook work
just as they do elsewhere. An optional property that a row lacks shows a `+` in its cell, and a
filled optional cell has a small ✕ to clear it.

```json
{
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["sku", "qty"],
    "properties": {
      "sku": { "title": "SKU", "type": "string" },
      "qty": { "title": "Qty", "type": "integer", "minimum": 1 },
      "gift": { "type": "boolean" }
    }
  }
}
```

An array qualifies when `items` is an object schema (or a `$ref` to one) with `properties` and
`additionalProperties: false`, no `patternProperties`, none of `oneOf`, `anyOf`, `if`,
`dependentSchemas` or `dependencies`, and every property is a single string, number, integer, boolean
or null, or an `enum` or `const` of such values. Tuples don't qualify.

The array's **`tabular`** keyword (an editor keyword, not part of JSON Schema; other tools ignore it)
chooses the layout:

| `tabular` | Layout |
| --- | --- |
| `true` | always a table, however narrow the page. If it doesn't fit it scrolls sideways inside its own box rather than squashing the controls. |
| `false` | never a table |
| not set | a table when there is room for the columns, rows otherwise |

If you set `"tabular": true` on an array that doesn't qualify, it is drawn the normal way and a
warning says why in the console. When `tabular` isn't set, the width that counts is that of the
array's own box (so a nested array is judged by the room it has), and the layout switches as it
changes, for example when the window is resized, keeping the values and the focus. A table is
chosen when the box is at least about 150px (for the row number and buttons) plus 140px for each string
column, 120px for each enum, 90px for each number or const, 80px for each boolean and 60px for each null.

In a table the `render` hook is called for the array and for each cell, but not for the rows. The
metaschema in `examples/` accepts `tabular`, and the demonstration page has one of each: Line items
(not set), Phone numbers (`true`) and Team (`false`).

### Custom rendering

The `render` option is a function called for every node as it is drawn. Return an element to draw
that node yourself, or `undefined` to use the normal rendering:

```js
const editor = new SchemaEditor(div, schema, doc, {
  render(info) {
    // By value: any string like "#3b82f6" gets a colour picker.
    if (typeof info.value === 'string' && /^#[0-9a-f]{6}$/i.test(info.value)) {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = info.value;
      input.addEventListener('input', () => {
        const result = info.set(input.value);               // checked against the schema, like a typed edit
        if (!result.ok) console.log(result.errors);
      });
      return input;
    }
    // By schema: a number from 0 to 5 could get a star rating, and so on.
    if (info.schema.type === 'number' && info.schema.maximum === 5) return starRating(info);
  },
});
```

`info` is `{schema, value, path, set, editor}`:

| | |
| --- | --- |
| `schema` | the node's schema, with `$ref`, `allOf` and `if`/`then`/`else` already resolved. Treat it as read-only. |
| `value` | a copy of the node's current value |
| `path` | JSON Pointer to the node (`""` for the document) |
| `set(value)` | replace the node's value, like a user edit: it is checked against the whole schema, reported to the change callback (with its patch), and conditional fields update. Returns `{ok, errors}`, where `errors` are messages to show if it was refused. |
| `editor` | the `SchemaEditor` |

The element you return replaces the node's *editing controls* only. The label, description and remove
button around it, and any validation messages above it, are still drawn by the editor. For an object
or array it replaces everything inside it, so you draw the children yourself.

For a node with `oneOf`/`anyOf` or several types, `render` is called for the node itself (its
`schema` has the `oneOf`/`anyOf`, or a list of types) and, if it returns `undefined`, again for
whichever alternative is chosen, so you can draw one alternative and keep the selector. The hook is
called again whenever the node is redrawn (after a programmatic edit, or when a conditional schema
changes the fields), so keep any state in the document rather than in your element. If the hook
throws, or returns something that isn't an element, the error is logged to the console and the
normal rendering is used. The demonstration page has a "Custom renderers" switch that shows a
star rating and a colour picker.

### Tests

```
cd javascript
npm install
npm test                  # fast, in jsdom
npm run test:browser      # in a real Chrome: the stylesheet's light/dark behaviour
```

`npm run test:browser` needs Chrome (it uses `puppeteer-core`). It looks for an installed Chrome, or
set `CHROME_PATH` (and `CHROME_ARGS`, `CHROME_HEADLESS=shell` for a headless-shell binary). Without a
browser the tests are skipped, unless `REQUIRE_BROWSER` is set, as it is in CI. They check, in the real
browser, that the editor follows `prefers-color-scheme`, that `data-theme` and the custom properties
override it, and that text, error and focus colours have enough contrast in every combination.

## Python

Requires Python 3.9 or later and [Textual](https://textual.textualize.io/) 8 or later.

```
cd python
pip install .            # or, for development: pip install -e '.[test]'
```

### Command line

```
schmeditor SCHEMA.json                        # start from a minimal valid document; Ctrl+S prints it
schmeditor SCHEMA.json DOCUMENT.json          # edit a file in place (created if it doesn't exist)
schmeditor SCHEMA.json DOCUMENT.json -o OUT   # save somewhere else
schmeditor SCHEMA.json DOCUMENT.json --check  # no UI: list validation errors, exit 1 if any
python -m schmeditor …                        # the same, without installing the script
```

Ctrl+S saves and keeps editing; Ctrl+Q quits, asking first if there are unsaved changes (discarding
exits with status 1). With no document file and no `-o`, Ctrl+S finishes and prints the JSON to
standard output, which therefore has to be a terminal; otherwise give `-o`.

| Key | Action |
| --- | --- |
| arrows, `Enter` | move around the tree; `Enter` edits the selected value, or expands a container |
| `Esc` | back to the tree |
| `a` | add a property or array item (opens a filterable list of the properties the schema allows) |
| `d` / `Delete` | delete the selected property or item |
| `r` | rename the selected property |
| `K` / `J` | move the selected array item up / down |
| `e` | edit the selected value (toggles `true`/`false`) |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo |
| `F1` | help |

The tree is on the left and a panel for the selected item on the right. `✗` marks items that contain
errors, and required properties that are missing appear as placeholders you can add with `Enter`.

### Library

```python
from schmeditor import edit, SchemaEditor, ChangeRejected, EditCancelled

# Open the terminal UI and get the edited document back.
try:
    doc = edit(schema, document)        # `document` is optional
except EditCancelled:                   # the user quit without pressing Ctrl+S
    ...

# Or work with a document directly, with or without the UI.
ed = SchemaEditor(schema, document, on_change=lambda doc, info: print(info))
ed.set("/name", "Ada")                  # raises ChangeRejected (with .errors) if it would
ed.push("/tags", "math")                #   make the document less valid
ed.remove("/address")
ed.validate()                           # [{"path", "keyword", "message"}, ...]
doc = ed.run()                          # the same as edit(), on this object
```

`SchemaEditor` has the same methods as the JavaScript component (`get`, `set`, `remove`, `insert`,
`push`, `validate`, `is_valid`, `get_document`, `set_document`, `on_change`), in Python naming. The
validation engine and document model (`schmeditor.engine`, `schmeditor.model`) are plain Python with no
dependencies; Textual is only imported when the UI is opened.

**The change callback** is called as `on_change(doc, info)`, exactly as in the JavaScript component:
`doc` is a copy of the whole document and `info` is a dict with

| | |
| --- | --- |
| `"source"` | `"user"` for edits made in the terminal UI, or `"api"` for `set`/`remove`/… when `notify_on_programmatic=True` |
| `"patch"` | a [JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902) (RFC 6902): applied to the document as it was before the change, it gives `doc` |
| `"path"` | JSON Pointer to the main thing that changed (`""` for the whole document) |
| `"value"` | a copy of the new value at `path`. The key is absent if it was removed, since `None` is a real JSON value |

```python
import copy
from schmeditor import SchemaEditor, apply_patch

mirror = copy.deepcopy(document)

def changed(doc, info):
    global mirror
    mirror = apply_patch(mirror, info["patch"])          # keep another copy in step

SchemaEditor(schema, document, on_change=changed).run()
```

The patch describes what the user did (`replace`, `add`, `remove`, and `move` for reordering an array
item or renaming a property), followed by anything the editor changed along with the edit, such as a
newly required property it filled in. It is checked before it is sent, so it is never wrong: if it
could not reproduce the document, it is a single `replace` of the whole document. Undo and redo are
reported as a patch too. Moving an array item reports the array as `path`, and `insert`/`push` do the
same. `apply_patch(doc, patch)` applies a JSON Patch to a copy of a document, implements all six RFC
operations, raises `PatchError` naming the failing operation and does not look at any schema.

### Tests

```
cd python
pip install -e '.[test]'
pytest
```

## Supported JSON Schema

`type` (including lists of types), `enum`, `const`, `default`, `title`, `description`, `properties`,
`patternProperties`, `additionalProperties`, `required`, `minProperties`, `maxProperties`,
`propertyNames`, `dependentRequired`, `dependentSchemas`, `dependencies`, `items` (a schema or a
tuple), `prefixItems`, `additionalItems`, `minItems`, `maxItems`, `uniqueItems`, `contains`,
`minContains`, `maxContains`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`,
`multipleOf`, `minLength`, `maxLength`, `pattern`, `format` (`email`, `date`, `date-time`, `time`,
`uri`, `uuid`, `ipv4`), `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`, and local `$ref`
(`#`, `#/pointer` and `#anchor`).

Not supported: remote `$ref`s, `unevaluatedProperties`/`unevaluatedItems` and `$dynamicRef`. Keywords
from both draft-07 and 2020-12 are understood where they overlap (for example `items` as an array
and `prefixItems`). Patterns are tried as JavaScript regular expressions in the browser and as Python
regular expressions in the terminal, so exotic patterns may differ.

Two details about how edits are judged: errors are compared by keyword and message, ignoring where
they occur, so deleting an array item in an already-invalid document doesn't count as "new" errors
from items shifting position; and new array items and properties are created from the schema's
`default`s (or the smallest value that fits), trying alternatives when the first would be refused,
for example to keep a `uniqueItems` list unique. A schema whose constraints can't be satisfied by
any automatic default (a `pattern` on a required string, say) can still be edited by typing a value in,
but an empty new item won't be accepted until it is valid.

## A metaschema: an editor for schemas

[`examples/editor-metaschema.json`](examples/editor-metaschema.json) is a JSON Schema describing
exactly the schemas this editor understands. Using it as the schema lets you edit *schemas*: pick a
kind for each schema (string, object, array, …) and add only the keywords that apply to that kind.
It validates itself, and the contact example schema validates against it.

```
schmeditor examples/editor-metaschema.json my.schema.json
```

In the JavaScript demonstration it also drives a live form built from the schema you are editing.

## The two implementations

They share the same validation semantics and the same JSON Patch output.
[`tools/compare_validators.py`](tools/compare_validators.py) validates about 1,800 documents (random
mutations of the examples, plus edge cases for individual keywords) with both and compares every error
they report. [`tools/compare_patches.py`](tools/compare_patches.py) works out patches between about
3,500 pairs of documents with both, and checks that the patches are identical and that each
implementation can apply the other's. At the time of writing they agree exactly. Both need
`npm install` in `javascript/` first, then `python tools/compare_validators.py` and
`python tools/compare_patches.py`.
The interfaces differ where the medium does: the terminal version adds undo/redo, a command line and a filterable "add" list; the
browser version shows every optional property as an "Add" row (collapsing them into one menu when
there are many) and a live form in the metaschema demo.

## Continuous integration

[GitHub Actions](.github/workflows/ci.yml) runs on every push to `main` and every pull request:

* the JavaScript tests on Node 22, 24 and 26, and the browser tests in Chrome;
* the Python tests on Python 3.9 to 3.14 on Linux, and on 3.12 on macOS and Windows (the
  pseudo-terminal tests are skipped on Windows);
* a packaging check: build the sdist and wheel, run `twine check`, install the wheel and run the
  `schmeditor` command on the examples;
* the checks that the JavaScript and Python validators and JSON Patch implementations agree.

## License

[CC0 1.0 Universal](LICENSE): public domain dedication.
