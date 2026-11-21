/*!
 * schmeditor — a small, dependency-free, schema-driven JSON editor.
 *
 * Include the stylesheet (schmeditor.css) and this script, then:
 *
 *   const editor = new SchemaEditor(divElement, jsonSchema, document, options?);
 *
 *   editor.onChange((doc, info) => { ... });   // user edits (info = {source, patch, path, value})
 *   editor.getDocument();                       // deep copy of the current document
 *   editor.setDocument(doc);                    // replace everything
 *   editor.get('/a/b/0');                       // read (JSON Pointer or array path)
 *   editor.set('/a/b/0', value);                // replace / add a value
 *   editor.remove('/a/b/0');                    // delete a property / array item
 *   editor.insert('/list', index, value);       // insert into an array
 *   editor.push('/list', value);                // append to an array
 *   editor.validate();                          // -> [{path, keyword, message}]
 *   editor.isValid();
 *   editor.destroy();
 *   SchemaEditor.applyPatch(doc, patch);        // apply a JSON Patch to a copy of doc
 *
 * Guarantee: every edit (UI or programmatic) is validated against the full
 * schema before it is applied. An edit that would introduce a new validation
 * error is refused (the UI shows why; the API throws an Error whose `.errors`
 * lists the problems). A document that starts out valid therefore stays valid.
 * A document that starts out invalid is displayed with its errors, and edits
 * may only reduce them, never add new kinds.
 *
 * The change callback is called as callback(doc, info). `doc` is a copy of the whole
 * document and `info` is {source, patch, path, value}:
 *   source  "user" for edits in the page, "api" for set/remove/... (see notifyOnProgrammatic);
 *   patch   a JSON Patch (RFC 6902). Applied to the document as it was before the change, it
 *           gives `doc`. It uses replace, add and remove (and move, for reordering an array
 *           item or renaming a property), followed by anything the editor changed along with
 *           the edit, such as a property that became required and was filled in;
 *   path    JSON Pointer to the main thing that changed ("" for the whole document);
 *   value   a copy of the new value at `path`, or undefined if it was removed. After a move,
 *           and after insert/push, `path` is the array and `value` its new contents.
 * SchemaEditor.applyPatch(doc, patch) applies a JSON Patch to a copy of a document.
 *
 * Tables: an array whose items are objects with a fixed set of simple properties (`properties`,
 * `additionalProperties: false`, each property a string, number, integer, boolean, null, enum or
 * const) can be shown as a table, a row per object and a column per property. So can an object
 * whose additionalProperties are such objects: a row per additional property, with its name as
 * the first column, and its declared properties shown above the table as usual. The `tabular`
 * keyword of the array or object decides: true always shows a table, false never does, and if it
 * isn't set the editor shows a table when there is room for the columns, and switches as the
 * page resizes.
 *
 * Custom rendering: the `render` option is called for every node as it is drawn, with
 * info = {schema, value, path, set, editor}:
 *   schema  the node's schema, with $ref, allOf and if/then/else resolved (treat as read-only);
 *   value   a copy of the node's current value;
 *   path    JSON Pointer to the node ("" for the document);
 *   set(v)  replace the node's value like a user edit, so it is checked against the schema and
 *           reported to the change callback. Returns {ok, errors} (errors are messages);
 *   editor  the SchemaEditor.
 * Return an element to draw the node with it, or undefined to use the normal rendering. The
 * element replaces the node's editing controls only: the label, description and remove button
 * around it, and any validation messages above it, are still drawn by the editor. For a node
 * with oneOf/anyOf or several types, `render` is called for the node itself and, if it returns
 * undefined, again for whichever alternative is chosen.
 *
 * Options:
 *   onChange               function(doc, info)  same as editor.onChange(fn)
 *   render                 function(info)       draw a node yourself, or return undefined
 *   notifyOnProgrammatic   false  also call the callback for set/remove/push/...
 *   validateFormats        true   treat "format" (email, date, uri, ...) as an assertion
 *
 * Supported keywords: type (incl. type arrays), enum, const, default, title,
 * description, properties, patternProperties, additionalProperties, required,
 * minProperties, maxProperties, propertyNames, dependentRequired,
 * dependentSchemas, dependencies, items (schema or tuple), prefixItems,
 * additionalItems, minItems, maxItems, uniqueItems, contains/minContains/
 * maxContains, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 * multipleOf, minLength, maxLength, pattern, format, allOf, anyOf, oneOf, not,
 * if/then/else and local $ref ("#", "#/pointer", "#anchor").
 * Remote $refs are not supported.
 */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.SchemaEditor = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const uniq = a => [...new Set(a)];

  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => hasOwn(b, k) && deepEqual(a[k], b[k]));
  }

  function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v; // string | boolean | object
  }
  function isType(v, t) {
    const vt = typeOf(v);
    return t === 'number' ? vt === 'number' || vt === 'integer' : vt === t;
  }

  const escTok = s => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
  const unescTok = s => s.replace(/~1/g, '/').replace(/~0/g, '~');
  const toPtr = path => path.map(p => '/' + escTok(p)).join('');
  function parsePath(p) {
    if (Array.isArray(p)) return p.slice();
    if (p === '' || p == null) return [];
    if (typeof p !== 'string' || p[0] !== '/')
      throw new Error('Path must be a JSON Pointer string like "/a/0/b" or an array of keys');
    return p.slice(1).split('/').map(unescTok);
  }

  function getAt(doc, path) {
    let cur = doc;
    for (const k of path) {
      if (cur === null || typeof cur !== 'object' || !hasOwn(cur, k)) return undefined;
      cur = cur[k];
    }
    return cur;
  }
  // Mutating helpers; they work on a scratch copy and return the (possibly new) root.
  function setAt(doc, path, value) {
    if (!path.length) return value;
    const parent = getAt(doc, path.slice(0, -1));
    const k = path[path.length - 1];
    if (Array.isArray(parent)) {
      if (k === '-') parent.push(value);
      else {
        const i = Number(k);
        if (!Number.isInteger(i) || i < 0 || i > parent.length) throw new Error('Invalid array index "' + k + '"');
        parent[i] = value;
      }
    } else if (isObj(parent)) {
      if (k === '__proto__') throw new Error('Invalid property name');
      parent[k] = value;
    } else throw new Error('Path does not exist: ' + toPtr(path));
    return doc;
  }
  function removeAt(doc, path) {
    if (!path.length) throw new Error('The root of the document cannot be removed');
    const parent = getAt(doc, path.slice(0, -1));
    const k = path[path.length - 1];
    if (Array.isArray(parent)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= parent.length) throw new Error('Invalid array index "' + k + '"');
      parent.splice(i, 1);
    } else if (isObj(parent) && hasOwn(parent, k)) delete parent[k];
    else throw new Error('Path does not exist: ' + toPtr(path));
    return doc;
  }
  function replaceKeys(obj, entries) {
    for (const k of Object.keys(obj)) delete obj[k];
    for (const [k, v] of entries) obj[k] = v;
  }

  // The least width (in px) a table column of each kind is given, for a required and for an optional
  // property (an optional one also holds a button to clear it). They are close to what the controls
  // need (measured in a browser), and they decide whether there is room for a table; the columns
  // are held to them.
  const COLUMN_MIN = { string: [90, 120], number: [90, 120], boolean: [90, 110], enum: [90, 120], const: [75, 90], null: [60, 95] };
  const columnMin = c => COLUMN_MIN[c.kind][c.required ? 0 : 1];
  // What is left for the row number and buttons (arrays), or the name and button (objects).
  const ARRAY_TABLE_BASE = 140, OBJECT_TABLE_BASE = 160;

  /* ---------------------------- JSON Patch (RFC 6902) ---------------------------- */

  // A list of operations that turns `a` into `b`. Used for whatever an edit changed beyond
  // the one thing the user did (for example properties the editor filled in); the main
  // operation of each edit is chosen by the editor itself.
  function diffPatch(a, b) {
    const ops = [];
    diffValue(a, b, '', ops);
    return ops;
  }
  function diffValue(a, b, path, ops) {
    if (deepEqual(a, b)) return;
    if (isObj(a) && isObj(b)) {
      for (const k of Object.keys(a)) if (hasOwn(b, k)) diffValue(a[k], b[k], path + '/' + escTok(k), ops);
      for (const k of Object.keys(a)) if (!hasOwn(b, k)) ops.push({ op: 'remove', path: path + '/' + escTok(k) });
      for (const k of Object.keys(b)) if (!hasOwn(a, k)) ops.push({ op: 'add', path: path + '/' + escTok(k), value: clone(b[k]) });
    } else if (Array.isArray(a) && Array.isArray(b)) {
      // Skip what the arrays share at both ends, then compare what is left in pairs.
      let head = 0;
      while (head < a.length && head < b.length && deepEqual(a[head], b[head])) head++;
      let ta = a.length, tb = b.length;
      while (ta > head && tb > head && deepEqual(a[ta - 1], b[tb - 1])) { ta--; tb--; }
      const shared = Math.min(ta, tb) - head;
      for (let i = 0; i < shared; i++) diffValue(a[head + i], b[head + i], path + '/' + (head + i), ops);
      for (let i = shared; i < ta - head; i++) ops.push({ op: 'remove', path: path + '/' + (head + shared) });
      for (let i = shared; i < tb - head; i++) ops.push({ op: 'add', path: path + '/' + (head + i), value: clone(b[head + i]) });
    } else {
      ops.push({ op: 'replace', path, value: clone(b) });
    }
  }

  // Apply a JSON Patch to a copy of `doc` and return the copy; `doc` itself is not touched.
  // Implements add, remove, replace, move, copy and test. Throws an Error naming the failing
  // operation. It only edits the JSON: it does not check the result against any schema.
  function applyPatch(doc, patch) {
    if (!Array.isArray(patch)) throw new Error('A JSON Patch must be an array of operations');
    const arrayIndex = (k, max) => {
      if (!/^(0|[1-9]\d*)$/.test(k) || Number(k) > max) throw new Error('invalid array index "' + k + '"');
      return Number(k);
    };
    const locate = (root, path) => {                 // the value at a path, which must exist
      let cur = root;
      for (const k of path) {
        if (Array.isArray(cur)) cur = cur[arrayIndex(k, cur.length - 1)];
        else if (isObj(cur) && hasOwn(cur, k)) cur = cur[k];
        else throw new Error('no value at "' + toPtr(path) + '"');
      }
      return cur;
    };
    const add = (root, path, value) => {
      if (!path.length) return value;
      const parent = locate(root, path.slice(0, -1)), k = path[path.length - 1];
      if (Array.isArray(parent)) parent.splice(k === '-' ? parent.length : arrayIndex(k, parent.length), 0, value);
      else if (isObj(parent) && k !== '__proto__') parent[k] = value;
      else throw new Error('cannot add at "' + toPtr(path) + '"');
      return root;
    };
    const remove = (root, path) => {
      if (!path.length) throw new Error('cannot remove the whole document');
      const parent = locate(root, path.slice(0, -1)), k = path[path.length - 1];
      locate(root, path);
      if (Array.isArray(parent)) parent.splice(arrayIndex(k, parent.length - 1), 1);
      else delete parent[k];
      return root;
    };
    let root = clone(doc);
    patch.forEach((o, i) => {
      try {
        if (!isObj(o) || typeof o.path !== 'string') throw new Error('not an operation');
        const path = parsePath(o.path);
        const from = () => parsePath(o.from);
        switch (o.op) {
          case 'add': root = add(root, path, clone(o.value)); break;
          case 'remove': root = remove(root, path); break;
          case 'replace': {                      // in place, so an object member keeps its position
            locate(root, path);
            if (!path.length) { root = clone(o.value); break; }
            const parent = locate(root, path.slice(0, -1)), k = path[path.length - 1];
            if (Array.isArray(parent)) parent[arrayIndex(k, parent.length - 1)] = clone(o.value);
            else parent[k] = clone(o.value);
            break;
          }
          case 'move': {
            const f = from();
            if (path.length > f.length && f.every((k, n) => k === path[n])) throw new Error('cannot move into itself');
            const v = locate(root, f);
            root = add(remove(root, f), path, v);
            break;
          }
          case 'copy': root = add(root, path, clone(locate(root, from()))); break;
          case 'test': if (!deepEqual(locate(root, path), o.value)) throw new Error('the value is not as expected'); break;
          default: throw new Error('unknown operation "' + o.op + '"');
        }
      } catch (e) {
        throw new Error('JSON Patch operation ' + i + (isObj(o) ? ' (' + o.op + ' ' + o.path + ')' : '') + ' failed: ' + e.message);
      }
    });
    return root;
  }

  /* ------------------------------------------------------------------ *
   * Schema helpers
   * ------------------------------------------------------------------ */

  const ALL_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null'];

  const FORMATS = {
    email: s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
    date: s => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s,
    'date-time': s =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/.test(s) && !isNaN(Date.parse(s)),
    time: s => /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|z|[+-]\d{2}:\d{2})$/.test(s),
    uri: s => /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/.test(s),
    uuid: s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
    ipv4: s => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s),
  };
  const FORMAT_DEFAULTS = {
    email: 'user@example.com',
    uri: 'https://example.com',
    date: () => new Date().toISOString().slice(0, 10),
    'date-time': () => new Date().toISOString(),
    time: '00:00:00Z',
    uuid: '00000000-0000-4000-8000-000000000000',
    ipv4: '0.0.0.0',
  };

  // Combine two *normalised* schemas into one that accepts what both accept.
  function mergeSchemas(a, b) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (!(k in out)) { out[k] = v; continue; }
      const av = out[k];
      switch (k) {
        case 'properties':
        case 'patternProperties': {
          const m = { ...av };
          for (const [pk, pv] of Object.entries(v)) m[pk] = pk in m ? { allOf: [m[pk], pv] } : pv;
          out[k] = m;
          break;
        }
        case 'required':
          out[k] = uniq([].concat(av, v));
          break;
        case 'enum':
          out[k] = av.filter(x => v.some(y => deepEqual(x, y)));
          break;
        case 'type': {
          const res = [];
          for (const ta of [].concat(av)) for (const tb of [].concat(v)) {
            if (ta === tb) res.push(ta);
            else if ((ta === 'integer' && tb === 'number') || (ta === 'number' && tb === 'integer')) res.push('integer');
          }
          const r = uniq(res);
          out[k] = r.length === 0 ? v : r.length === 1 ? r[0] : r;
          break;
        }
        case 'minimum': case 'minLength': case 'minItems': case 'minProperties':
        case 'exclusiveMinimum': case 'minContains':
          out[k] = typeof av === 'number' && typeof v === 'number' ? Math.max(av, v) : v;
          break;
        case 'maximum': case 'maxLength': case 'maxItems': case 'maxProperties':
        case 'exclusiveMaximum': case 'maxContains':
          out[k] = typeof av === 'number' && typeof v === 'number' ? Math.min(av, v) : v;
          break;
        case 'additionalProperties':
          out[k] = av === false || v === false ? false : v;
          break;
        case 'oneOf':
        case 'anyOf':
          out.allOf = (out.allOf || []).concat([{ [k]: v }]);
          break;
        default:
          out[k] = v;
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers + styles
   * ------------------------------------------------------------------ */

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'value' || k === 'disabled' || k === 'checked' || k === 'type' || k === 'readOnly') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
    return e;
  }


  /* ------------------------------------------------------------------ *
   * The editor
   * ------------------------------------------------------------------ */

  class SchemaEditor {
    constructor(container, schema, initialDoc, options) {
      if (!container || container.nodeType !== 1) throw new TypeError('SchemaEditor: first argument must be a DOM element');
      if (!isObj(schema) && typeof schema !== 'boolean') throw new TypeError('SchemaEditor: schema must be a JSON Schema object');
      this.container = container;
      this.schema = schema;
      this.opts = Object.assign({ validateFormats: true, notifyOnProgrammatic: false }, options || {});
      this._cb = typeof this.opts.onChange === 'function' ? this.opts.onChange : null;
      this._reCache = new Map();
      this._anchorMap = null;
      this._doc = initialDoc === undefined ? this._defaultFor(schema) : clone(initialDoc);
      this._setErrors(this._validateAll(this._doc));
      this._build();
    }

    /* ---------------------------- public API --------------------------- */

    /** Set (or clear, with null) the callback run after every user edit. */
    onChange(cb) {
      this._cb = typeof cb === 'function' ? cb : null;
      return this;
    }
    getDocument() { return clone(this._doc); }
    setDocument(doc) {
      const before = this._doc;
      this._doc = clone(doc);
      this._setErrors(this._validateAll(this._doc));
      this._build();
      if (this.opts.notifyOnProgrammatic) this._notify([], 'api', { primary: [{ op: 'replace', path: '', value: clone(doc) }] }, before);
      return this;
    }
    get(path) { return clone(getAt(this._doc, parsePath(path))); }
    set(path, value) {
      const p = parsePath(path);
      return this._api(d => setAt(d, p, clone(value)), p);
    }
    remove(path) {
      const p = parsePath(path);
      return this._api(d => removeAt(d, p), p, { removed: true });
    }
    insert(path, index, value) {
      const p = parsePath(path);
      return this._api(d => {
        const a = getAt(d, p);
        if (!Array.isArray(a)) throw new Error('Not an array: ' + toPtr(p));
        if (!Number.isInteger(index) || index < 0 || index > a.length) throw new Error('Invalid array index ' + index);
        a.splice(index, 0, clone(value));
      }, p, { primary: [{ op: 'add', path: toPtr(p.concat(index)), value: clone(value) }] });
    }
    push(path, value) {
      const p = parsePath(path);
      return this._api(d => {
        const a = getAt(d, p);
        if (!Array.isArray(a)) throw new Error('Not an array: ' + toPtr(p));
        a.push(clone(value));
      }, p, { primary: [{ op: 'add', path: toPtr(p.concat((getAt(this._doc, p) || []).length)), value: clone(value) }] });
    }
    validate() { return this._errs.map(e => ({ ...e })); }
    isValid() { return this._errs.length === 0; }
    destroy() {
      this.container.textContent = '';
      this.container.classList.remove('se-root');
      this._cb = null;
    }

    /* ------------------------- change management ----------------------- */

    _setErrors(errs) {
      this._errs = errs;
      this._counts = new Map();
      for (const e of errs) {
        const k = e.keyword + '|' + e.message;
        this._counts.set(k, (this._counts.get(k) || 0) + 1);
      }
    }

    // Apply `mutator` to a scratch copy; accept only if it adds no new validation errors.
    // With `repair`, newly *missing required properties* (e.g. triggered by an if/then
    // branch) are first filled in with default values.
    _tryMutate(mutator, repair) {
      let next = clone(this._doc);
      try {
        const out = mutator(next);
        if (out !== undefined) next = out;
      } catch (e) {
        return { ok: false, errors: [{ path: '', keyword: '', message: e.message }] };
      }
      let errs, bad;
      const check = () => {
        errs = this._validateAll(next);
        const counts = new Map();
        for (const e of errs) {
          const k = e.keyword + '|' + e.message;
          counts.set(k, (counts.get(k) || 0) + 1);
        }
        const seen = new Set();
        bad = [];
        for (const e of errs) {
          const k = e.keyword + '|' + e.message;
          if (counts.get(k) > (this._counts.get(k) || 0) && !seen.has(k)) { seen.add(k); bad.push(e); }
        }
      };
      check();
      for (let pass = 0; repair && bad.length && pass < 6; pass++) {
        let fixed = false;
        for (const e of bad) {
          if (e.key === undefined) continue;
          const p = parsePath(e.path);
          const o = getAt(next, p);
          if (!isObj(o) || hasOwn(o, e.key) || e.key === '__proto__') continue;
          const eff = this._effectiveAt(next, p);
          const sub = eff && this._propSchema(eff, e.key);
          if (sub === null || sub === undefined) continue;
          o[e.key] = this._defaultFor(sub);
          fixed = true;
        }
        if (!fixed) break;
        check();
      }
      return bad.length ? { ok: false, errors: bad } : { ok: true, next, errs };
    }

    // The normalised schema (after choosing oneOf/anyOf alternatives) that applies at `path`.
    _effectiveAt(doc, path) {
      let sch = this.schema, val = doc, s;
      for (let i = 0; ; i++) {
        s = this._norm(sch, val);
        const v = this._variants(s, val);
        if (v) s = this._norm(v.list[v.idx].schema, val);
        if (i === path.length) return s;
        const k = path[i];
        if (isObj(val)) sch = this._propSchema(s, k);
        else if (Array.isArray(val)) sch = this._itemSchema(s, Number(k));
        else return null;
        if (sch === null || sch === undefined) return null;
        val = val[k];
      }
    }

    _fmt(errors, ptr) {
      return errors.map(e => (e.path && e.path !== ptr ? e.path + ': ' : '') + e.message);
    }

    _api(mutator, path, opts) {
      const r = this._tryMutate(mutator);
      if (!r.ok) {
        const err = new Error('Change rejected: ' + this._fmt(r.errors, '').join('; '));
        err.errors = r.errors.map(e => ({ ...e }));
        throw err;
      }
      const before = this._doc;
      this._doc = r.next;
      this._setErrors(r.errs);
      this._build();
      if (this.opts.notifyOnProgrammatic) this._notify(path, 'api', opts || {}, before);
      return this;
    }

    // UI-originated change. `srcEl` is where the 'se-commit' event starts bubbling from.
    // `opts.noRepair` skips filling in newly required properties; `opts.removed` says that
    // whatever was at `path` is gone (so the callback gets no value for it); `opts.primary`
    // gives the edit's main JSON Patch operations when they aren't a simple set/add/remove.
    _commit(mutator, srcEl, path, opts) {
      const o = opts || {};
      const r = this._tryMutate(mutator, !o.noRepair);
      if (!r.ok) return r;
      const before = this._doc;
      const changed = !deepEqual(before, r.next);
      this._doc = r.next;
      this._setErrors(r.errs);
      if (srcEl) srcEl.dispatchEvent(new CustomEvent('se-commit', { bubbles: true }));
      this._refreshErrors();
      if (changed) this._notify(path, 'user', o, before);
      return r;
    }

    // The main operations of an edit, as JSON Patch. `o.primary` gives them outright (for moves,
    // renames and inserts); otherwise the edit set, added or removed whatever is at `path`.
    _primary(before, after, path, o) {
      if (o.primary) return o.primary;
      const ptr = toPtr(path);
      if (o.removed) return [{ op: 'remove', path: ptr }];
      const was = getAt(before, path), now = getAt(after, path);
      if (was === undefined) return now === undefined ? [] : [{ op: 'add', path: ptr, value: clone(now) }];
      return deepEqual(was, now) ? [] : [{ op: 'replace', path: ptr, value: clone(now) }];
    }

    // A JSON Patch that turns `before` into `after`: the edit's main operations, then anything
    // else the editor changed along with it. Always checked, so it is never wrong: if the
    // pieces didn't add up, the patch replaces the whole document.
    _makePatch(before, after, primary) {
      const works = ops => { try { return deepEqual(applyPatch(before, ops), after); } catch (e) { return false; } };
      try {
        const ops = primary.map(clone).concat(diffPatch(applyPatch(before, primary), after));
        if (works(ops)) return ops;
      } catch (e) { /* fall through */ }
      const plain = diffPatch(before, after);
      return works(plain) ? plain : [{ op: 'replace', path: '', value: clone(after) }];
    }

    // Tell the callback about a change. `doc` is a copy of the whole document; `info` is
    // {source, patch, path, value}, where `value` is the new value at `path` (undefined if removed).
    _notify(path, source, o, before) {
      if (!this._cb) return;
      const patch = this._makePatch(before, this._doc, this._primary(before, this._doc, path, o));
      const info = { source, patch, path: toPtr(path), value: o.removed ? undefined : clone(getAt(this._doc, path)) };
      try { this._cb(clone(this._doc), info); } catch (e) { console.error(e); }
    }

    /* ----------------------------- validation -------------------------- */

    _validateAll(doc) {
      const errs = [];
      this._v(this.schema, doc, '', errs, 0);
      return errs;
    }
    // Silent validity check; stops at the first error, which keeps oneOf/anyOf cheap.
    valid(schema, value, depth) {
      const errs = [];
      this._ff = (this._ff || 0) + 1;
      try { this._v(schema, value, '', errs, (depth || 0) + 1); } finally { this._ff--; }
      return errs.length === 0;
    }
    _re(pattern) {
      let re = this._reCache.get(pattern);
      if (!re) {
        try { re = new RegExp(pattern, 'u'); } catch (_) { re = new RegExp(pattern); }
        this._reCache.set(pattern, re);
      }
      return re;
    }
    _anchors() {
      if (!this._anchorMap) {
        const m = new Map();
        const walk = n => {
          if (Array.isArray(n)) n.forEach(walk);
          else if (isObj(n)) {
            if (typeof n.$anchor === 'string') m.set(n.$anchor, n);
            if (typeof n.$id === 'string' && n.$id[0] === '#') m.set(n.$id.slice(1), n);
            Object.values(n).forEach(walk);
          }
        };
        walk(this.schema);
        this._anchorMap = m;
      }
      return this._anchorMap;
    }
    _lookup(ref) {
      if (typeof ref !== 'string' || ref[0] !== '#')
        throw new Error('Unsupported $ref (only local "#..." references work): ' + ref);
      if (ref === '#') return this.schema;
      const frag = decodeURIComponent(ref.slice(1));
      if (frag[0] !== '/') {
        const a = this._anchors().get(frag);
        if (!a) throw new Error('Unresolvable $ref: ' + ref);
        return a;
      }
      let cur = this.schema;
      for (const tok of frag.slice(1).split('/').map(unescTok)) {
        if (cur === null || typeof cur !== 'object' || !(tok in cur)) throw new Error('Unresolvable $ref: ' + ref);
        cur = cur[tok];
      }
      return cur;
    }

    _v(schema, value, ptr, errs, depth) {
      if (schema === true || schema === undefined) return;
      const add = (keyword, message, path) => errs.push({ path: path === undefined ? ptr : path, keyword, message });
      if (schema === false) return add('false', 'No value is allowed here');
      if (!isObj(schema) || depth > 60) return;
      const silent = this._ff > 0;                  // only validity matters, so stop at the first error
      const stop = () => silent && errs.length > 0;
      const d1 = depth + 1;
      const props = isObj(schema.properties) ? schema.properties : {};
      const pats = isObj(schema.patternProperties) ? schema.patternProperties : {};
      const patKeys = Object.keys(pats);

      // 1. Cheap checks first, so wrong alternatives are rejected before any recursion.
      if ('const' in schema && !deepEqual(schema.const, value)) add('const', 'Must equal ' + JSON.stringify(schema.const));
      if (Array.isArray(schema.enum) && !schema.enum.some(e => deepEqual(e, value))) add('enum', 'Must be one of the allowed values');
      if (schema.type !== undefined) {
        const ts = [].concat(schema.type);
        if (!ts.some(t => isType(value, t))) add('type', 'Must be of type ' + ts.join(' or '));
      }
      if (stop()) return;

      if (typeof value === 'number') {
        const { minimum: min, maximum: max, exclusiveMinimum: exMin, exclusiveMaximum: exMax } = schema;
        if (typeof min === 'number' && (exMin === true ? value <= min : value < min))
          add('minimum', (exMin === true ? 'Must be greater than ' : 'Must be at least ') + min);
        if (typeof max === 'number' && (exMax === true ? value >= max : value > max))
          add('maximum', (exMax === true ? 'Must be less than ' : 'Must be at most ') + max);
        if (typeof exMin === 'number' && value <= exMin) add('exclusiveMinimum', 'Must be greater than ' + exMin);
        if (typeof exMax === 'number' && value >= exMax) add('exclusiveMaximum', 'Must be less than ' + exMax);
        if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
          const q = value / schema.multipleOf;
          if (Math.abs(q - Math.round(q)) > 1e-9) add('multipleOf', 'Must be a multiple of ' + schema.multipleOf);
        }
      }

      if (typeof value === 'string') {
        const len = [...value].length;
        if (schema.minLength !== undefined && len < schema.minLength) add('minLength', 'Must be at least ' + schema.minLength + ' characters');
        if (schema.maxLength !== undefined && len > schema.maxLength) add('maxLength', 'Must be at most ' + schema.maxLength + ' characters');
        if (typeof schema.pattern === 'string' && !this._re(schema.pattern).test(value)) add('pattern', 'Must match the pattern ' + schema.pattern);
        if (this.opts.validateFormats && FORMATS[schema.format] && !FORMATS[schema.format](value))
          add('format', 'Must be a valid ' + schema.format);
      }

      if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) add('minItems', 'Must have at least ' + schema.minItems + ' items');
        if (schema.maxItems !== undefined && value.length > schema.maxItems) add('maxItems', 'Must have at most ' + schema.maxItems + ' items');
        if (schema.uniqueItems === true && !stop()) {
          const dup = value.some((a, i) => value.some((b, j) => j > i && deepEqual(a, b)));
          if (dup) add('uniqueItems', 'Items must be unique');
        }
      }

      if (isObj(value)) {
        const keys = Object.keys(value);
        if (schema.minProperties !== undefined && keys.length < schema.minProperties) add('minProperties', 'Must have at least ' + schema.minProperties + ' properties');
        if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) add('maxProperties', 'Must have at most ' + schema.maxProperties + ' properties');
        if (Array.isArray(schema.required))
          for (const k of schema.required) if (!hasOwn(value, k)) errs.push({ path: ptr, keyword: 'required', message: 'Missing required property "' + k + '"', key: k });
        for (const k of keys) {
          if (schema.additionalProperties === false && !hasOwn(props, k) && !patKeys.some(p => this._re(p).test(k)))
            add('additionalProperties', 'Property "' + k + '" is not allowed');
          if (schema.propertyNames !== undefined && !this.valid(schema.propertyNames, k, d1))
            add('propertyNames', 'Property name "' + k + '" is not allowed');
        }
      }
      if (stop()) return;

      // 2. Combinators.
      if (schema.$ref !== undefined) this._v(this._lookup(schema.$ref), value, ptr, errs, d1);
      if (Array.isArray(schema.allOf)) schema.allOf.forEach(s => this._v(s, value, ptr, errs, d1));
      if (stop()) return;
      if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => this.valid(s, value, d1)))
        add('anyOf', 'Must match at least one of the allowed alternatives');
      if (Array.isArray(schema.oneOf)) {
        const n = schema.oneOf.filter(s => this.valid(s, value, d1)).length;
        if (n === 0) add('oneOf', 'Must match exactly one of the allowed alternatives');
        else if (n > 1) add('oneOf', 'Matches more than one of the mutually exclusive alternatives');
      }
      if (schema.not !== undefined && this.valid(schema.not, value, d1)) add('not', 'Matches a schema it must not match');
      if (schema.if !== undefined) {
        const br = this.valid(schema.if, value, d1) ? schema.then : schema.else;
        if (br !== undefined) this._v(br, value, ptr, errs, d1);
      }
      if (stop()) return;

      // 3. Recursion into children.
      if (Array.isArray(value)) {
        const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : [];
        const rest = Array.isArray(schema.prefixItems) ? schema.items : Array.isArray(schema.items) ? schema.additionalItems : schema.items;
        value.forEach((it, i) => {
          const sub = i < prefix.length ? prefix[i] : rest;
          if (sub !== undefined) this._v(sub, it, ptr + '/' + i, errs, d1);
        });
        if (schema.contains !== undefined) {
          const n = value.filter(it => this.valid(schema.contains, it, d1)).length;
          const min = schema.minContains === undefined ? 1 : schema.minContains;
          if (n < min) add('contains', 'Must contain at least ' + min + ' matching item' + (min === 1 ? '' : 's'));
          if (schema.maxContains !== undefined && n > schema.maxContains) add('maxContains', 'Must contain at most ' + schema.maxContains + ' matching items');
        }
      }

      if (isObj(value)) {
        for (const k of Object.keys(props))               // schema order: discriminating keys come first
          if (hasOwn(value, k)) this._v(props[k], value[k], ptr + '/' + escTok(k), errs, d1);
        const ap = schema.additionalProperties;
        for (const k of Object.keys(value)) {
          const kp = ptr + '/' + escTok(k);
          let matched = hasOwn(props, k);
          for (const p of patKeys) if (this._re(p).test(k)) { matched = true; this._v(pats[p], value[k], kp, errs, d1); }
          if (!matched && ap !== undefined && ap !== false) this._v(ap, value[k], kp, errs, d1);
        }
        if (isObj(schema.dependentRequired))
          for (const k in schema.dependentRequired) if (hasOwn(value, k))
            for (const r of schema.dependentRequired[k]) if (!hasOwn(value, r)) errs.push({ path: ptr, keyword: 'dependentRequired', message: '"' + r + '" is required when "' + k + '" is present', key: r });
        if (isObj(schema.dependentSchemas))
          for (const k in schema.dependentSchemas) if (hasOwn(value, k)) this._v(schema.dependentSchemas[k], value, ptr, errs, d1);
        if (isObj(schema.dependencies))
          for (const k in schema.dependencies) if (hasOwn(value, k)) {
            const dep = schema.dependencies[k];
            if (Array.isArray(dep)) { for (const r of dep) if (!hasOwn(value, r)) errs.push({ path: ptr, keyword: 'dependencies', message: '"' + r + '" is required when "' + k + '" is present', key: r }); }
            else this._v(dep, value, ptr, errs, d1);
          }
      }
    }

    /* ------------------------ schema interpretation -------------------- */

    // Flatten $ref / allOf (and, given a value, if-then-else & dependent schemas).
    _norm(schema, value, depth) {
      depth = depth || 0;
      if (schema === true || schema === undefined) return {};
      if (schema === false) return { not: {} };
      if (!isObj(schema) || depth > 40) return {};
      let s = { ...schema };
      if (s.$ref !== undefined) {
        const t = this._norm(this._lookup(s.$ref), value, depth + 1);
        delete s.$ref;
        s = mergeSchemas(t, s);
      }
      for (let i = 0; s.allOf && i < 10; i++) {
        const parts = s.allOf;
        delete s.allOf;
        for (const p of parts) s = mergeSchemas(s, this._norm(p, value, depth + 1));
      }
      if (value !== undefined) {
        if (s.if !== undefined) {
          const br = this.valid(s.if, value, depth) ? s.then : s.else;
          delete s.if; delete s.then; delete s.else;
          if (br !== undefined) s = mergeSchemas(s, this._norm(br, value, depth + 1));
        }
        if (isObj(value)) {
          for (const key of ['dependentSchemas', 'dependencies']) {
            if (!isObj(s[key])) continue;
            const deps = s[key];
            delete s[key];
            for (const k of Object.keys(deps))
              if (hasOwn(value, k) && !Array.isArray(deps[k])) s = mergeSchemas(s, this._norm(deps[k], value, depth + 1));
          }
        }
      }
      return s;
    }

    // The JSON types a normalised schema allows (best effort when `type` is omitted).
    _types(s) {
      if (s.type !== undefined) return uniq([].concat(s.type));
      if ('const' in s) return [typeOf(s.const)];
      if (Array.isArray(s.enum) && s.enum.length) return uniq(s.enum.map(typeOf));
      if (s.properties || s.patternProperties || s.additionalProperties !== undefined || s.required ||
          s.minProperties !== undefined || s.maxProperties !== undefined || s.propertyNames) return ['object'];
      if (s.items !== undefined || s.prefixItems || s.minItems !== undefined || s.maxItems !== undefined ||
          s.uniqueItems || s.contains) return ['array'];
      if (s.minLength !== undefined || s.maxLength !== undefined || s.pattern || s.format) return ['string'];
      if (s.minimum !== undefined || s.maximum !== undefined || s.exclusiveMinimum !== undefined ||
          s.exclusiveMaximum !== undefined || s.multipleOf !== undefined) return ['number'];
      return ALL_TYPES;
    }

    // Schema for property `key` of a normalised object schema; null if not allowed.
    _propSchema(s, key) {
      const parts = [];
      if (isObj(s.properties) && hasOwn(s.properties, key)) parts.push(s.properties[key]);
      if (isObj(s.patternProperties))
        for (const p in s.patternProperties) if (this._re(p).test(key)) parts.push(s.patternProperties[p]);
      if (!parts.length) {
        const ap = s.additionalProperties;
        if (ap === false) return null;
        return ap === undefined || ap === true ? {} : ap;
      }
      if (parts.length === 1) return parts[0] === false ? null : parts[0];
      return { allOf: parts };
    }

    _itemSchema(s, i) {
      const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : [];
      if (i < prefix.length) return prefix[i];
      const rest = Array.isArray(s.prefixItems) ? s.items : Array.isArray(s.items) ? s.additionalItems : s.items;
      return rest === undefined ? {} : rest;
    }

    // Alternatives the user can switch between (oneOf/anyOf, or a multi-type `type`).
    _variants(s, value) {
      const key = Array.isArray(s.oneOf) ? 'oneOf' : Array.isArray(s.anyOf) ? 'anyOf' : null;
      let list = null;
      if (key) {
        const base = { ...s };
        delete base[key];
        list = s[key].map((b, i) => ({ label: this._branchLabel(b, i), schema: mergeSchemas(base, this._norm(b)) }));
        const counts = {};
        list.forEach(v => { counts[v.label] = (counts[v.label] || 0) + 1; });
        list.forEach((v, i) => { if (counts[v.label] > 1) v.label += ' #' + (i + 1); });
      } else if (!('const' in s) && !Array.isArray(s.enum)) {
        const ts = this._types(s);
        if (ts.length > 1) list = ts.map(t => ({ label: t, schema: { ...s, type: t } }));
      }
      if (!list || !list.length) return null;
      let idx = list.findIndex(v => this.valid(v.schema, value));
      if (idx < 0) idx = list.findIndex(v => this._types(this._norm(v.schema, value)).some(t => isType(value, t)));
      if (idx < 0) idx = 0;
      return { list, idx };
    }

    _branchLabel(b, i) {
      if (isObj(b)) {
        if (b.title) return b.title;
        if (typeof b.$ref === 'string') {
          try { const t = this._lookup(b.$ref); if (t && t.title) return t.title; } catch (_) { /* ignore */ }
          return decodeURIComponent(b.$ref.split('/').pop());
        }
        if ('const' in b) return JSON.stringify(b.const);
        if (b.type) return [].concat(b.type).join(' | ');
      }
      return 'Option ' + (i + 1);
    }

    // Values worth trying when adding to an array, best first: the default, then every enum
    // value or alternative, so e.g. a uniqueItems list can still grow.
    _candidates(schema, depth) {
      depth = depth || 0;
      const s = this._norm(schema);
      const out = [];
      if ('default' in s) out.push(clone(s.default));
      if ('const' in s) out.push(clone(s.const));
      else if (Array.isArray(s.enum) && s.enum.length) s.enum.forEach(v => out.push(clone(v)));
      else {
        const key = Array.isArray(s.oneOf) ? 'oneOf' : Array.isArray(s.anyOf) ? 'anyOf' : null;
        if (key && !('default' in s)) {
          const base = { ...s };
          delete base[key];
          s[key].forEach(b => out.push(this._defaultFor(mergeSchemas(base, this._norm(b)), depth + 1)));
        } else if (!('default' in s)) out.push(this._defaultFor(schema, depth + 1));
      }
      return out.length ? out : [this._defaultFor(schema, depth + 1)];
    }

    // The smallest sensible value for a schema (used for new items, properties, type switches).
    _defaultFor(schema, depth) {
      depth = depth || 0;
      if (depth > 8) return null;
      const s = this._norm(schema);
      if ('default' in s) return clone(s.default);
      if ('const' in s) return clone(s.const);
      if (Array.isArray(s.enum) && s.enum.length) return clone(s.enum[0]);
      const key = Array.isArray(s.oneOf) ? 'oneOf' : Array.isArray(s.anyOf) ? 'anyOf' : null;
      if (key) {
        const base = { ...s };
        delete base[key];
        let first;
        for (const b of s[key]) {
          const m = mergeSchemas(base, this._norm(b));
          const v = this._defaultFor(m, depth + 1);
          if (first === undefined) first = v;
          if (this.valid(m, v)) return v;
        }
        return first === undefined ? null : first;
      }
      const t = this._types(s)[0];
      switch (t) {
        case 'object': {
          const o = {};
          if (depth > 6) return o;
          const fill = sx => {
            for (const k of Array.isArray(sx.required) ? sx.required : []) {
              if (hasOwn(o, k) || k === '__proto__') continue;
              const sub = this._propSchema(sx, k);
              if (sub !== null) o[k] = this._defaultFor(sub, depth + 1);
            }
          };
          fill(s);
          fill(this._norm(schema, o)); // picks up if/then/else and dependent requirements
          const need = s.minProperties || 0;
          for (const k of Object.keys(isObj(s.properties) ? s.properties : {})) {
            if (Object.keys(o).length >= need) break;
            if (!hasOwn(o, k)) o[k] = this._defaultFor(s.properties[k], depth + 1);
          }
          return o;
        }
        case 'array': {
          const a = [];
          if (depth > 6) return a;
          for (let i = 0; i < (s.minItems || 0); i++) {
            const item = this._itemSchema(s, i);
            let v;
            if (s.uniqueItems === true) { // choose values that don't repeat
              const cands = this._candidates(item, depth + 1);
              v = cands.find(c => !a.some(x => deepEqual(x, c)));
              if (v === undefined) v = cands[0];
            } else v = this._defaultFor(item, depth + 1);
            a.push(v);
          }
          return a;
        }
        case 'string': {
          const fd = FORMAT_DEFAULTS[s.format];
          let str = fd === undefined ? '' : typeof fd === 'function' ? fd() : fd;
          while ([...str].length < (s.minLength || 0)) str += 'x';
          if (s.maxLength !== undefined) str = [...str].slice(0, s.maxLength).join('');
          return str;
        }
        case 'number':
        case 'integer': {
          const step = s.multipleOf > 0 ? s.multipleOf : t === 'integer' ? 1 : null;
          let lo, hi, loS = false, hiS = false, v = 0;
          if (typeof s.minimum === 'number') { lo = s.minimum; loS = s.exclusiveMinimum === true; }
          if (typeof s.exclusiveMinimum === 'number' && (lo === undefined || s.exclusiveMinimum >= lo)) { lo = s.exclusiveMinimum; loS = true; }
          if (typeof s.maximum === 'number') { hi = s.maximum; hiS = s.exclusiveMaximum === true; }
          if (typeof s.exclusiveMaximum === 'number' && (hi === undefined || s.exclusiveMaximum <= hi)) { hi = s.exclusiveMaximum; hiS = true; }
          if (lo !== undefined && hi !== undefined && !step) v = (lo + hi) / 2;
          else {
            if (lo !== undefined && (v < lo || (loS && v <= lo))) {
              v = step ? Math.ceil(lo / step) * step : lo;
              if (loS && v <= lo) v = step ? v + step : lo + 1;
            }
            if (hi !== undefined && (v > hi || (hiS && v >= hi))) {
              v = step ? Math.floor(hi / step) * step : hi;
              if (hiS && v >= hi) v = step ? v - step : hi - 1;
            }
          }
          return +v.toFixed(10);
        }
        case 'boolean': return false;
        default: return null;
      }
    }

    /* ------------------------------ rendering -------------------------- */

    _build() {
      const c = this.container;
      c.textContent = '';
      c.classList.add('se-root');
      const s = this._norm(this.schema, this._doc);
      if (s.title) c.append(h('div', { class: 'se-title' }, s.title));
      if (s.description) c.append(h('div', { class: 'se-desc' }, s.description));
      c.append(this._renderNode(this.schema, []));
      this._refreshErrors();
    }

    _refreshErrors() {
      const nodes = new Map();
      // A node's errors go in its first child, unless it names another place (a table row does,
      // and a hidden row of its own that is shown only while it has something to say).
      const box = n => n._errBox || n.firstElementChild;
      this.container.querySelectorAll('.se-node').forEach(n => {
        nodes.set(n.getAttribute('data-ptr'), n); // later (deeper) nodes win for duplicate pointers
        box(n).textContent = '';
        if (n._errRow) n._errRow.hidden = true;
      });
      for (const e of this._errs) {
        let p = e.path, n = nodes.get(p);
        while (!n && p !== '') { p = p.slice(0, p.lastIndexOf('/')); n = nodes.get(p); }
        if (!n) continue;
        box(n).append(h('div', { class: 'se-error' }, e.message));
        if (n._errRow) n._errRow.hidden = false;
      }
    }

    _keepFocus(fn) {
      const a = document.activeElement;
      let key = null, s = null, e = null;
      if (a && a.hasAttribute && this.container.contains(a) && a.hasAttribute('data-fk')) {
        key = a.getAttribute('data-fk');
        try { s = a.selectionStart; e = a.selectionEnd; } catch (_) { /* not text-like */ }
      }
      fn();
      if (key !== null) {
        const n = [...this.container.querySelectorAll('[data-fk]')].find(x => x.getAttribute('data-fk') === key);
        if (n) {
          n.focus();
          if (s !== null && s !== undefined) try { n.setSelectionRange(s, e); } catch (_) { /* ignore */ }
        }
      }
    }

    _notice(anchor, msgs) {
      const parent = anchor.parentNode;
      if (!parent) return;
      [...parent.children].forEach(n => { if (n.classList.contains('se-notice')) n.remove(); });
      const n = h('div', { class: 'se-notice', role: 'alert' }, msgs.join(' · '));
      anchor.after(n);
      setTimeout(() => n.remove(), 5000);
    }

    _renderNode(schema, path) {
      const el = h('div', { class: 'se-node', 'data-ptr': toPtr(path) });
      const body = h('div', { class: 'se-nbody' });
      el.append(h('div', { class: 'se-errors' }), body);
      const ctx = { schema, path, body };
      ctx.rebuild = () => this._keepFocus(() => { body.textContent = ''; this._fillBody(ctx); });
      this._fillBody(ctx);
      return el;
    }

    // The `render` option: let the host draw a node itself. Returns an element, or null to use
    // the normal rendering (also if the hook throws or returns something that isn't an element).
    _customRender(s, value, path, body) {
      if (typeof this.opts.render !== 'function') return null;
      const ptr = toPtr(path);
      let el = null;
      const info = {
        schema: s,
        value: clone(value),
        path: ptr,
        editor: this,
        // Replace this node's value like a user edit: checked against the schema, reported to the callback.
        set: v => {
          const r = this._commit(d => setAt(d, path, clone(v)), el || body, path);
          return { ok: r.ok, errors: r.ok ? [] : this._fmt(r.errors, ptr) };
        },
      };
      let out;
      try {
        out = this.opts.render(info);
      } catch (e) {
        console.error('schmeditor: the render hook threw for ' + (ptr || 'the document') + ':', e);
        return null;
      }
      if (out === undefined || out === null) return null;
      if (typeof out !== 'object' || out.nodeType !== 1) {
        console.error('schmeditor: the render hook must return an element or undefined (for ' + (ptr || 'the document') + ')');
        return null;
      }
      el = out;
      return out;
    }

    _fillBody(ctx) {
      const { schema, path, body } = ctx;
      const value = getAt(this._doc, path);
      const s = this._norm(schema, value);
      ctx.s = s;
      const custom = this._customRender(s, value, path, body);
      if (custom) return void body.append(custom);
      const variants = this._variants(s, value);
      if (variants) return this._renderVariant(ctx, variants);
      if ('const' in s) return void body.append(h('code', { class: 'se-const' }, JSON.stringify(s.const)));
      if (Array.isArray(s.enum)) return this._renderEnum(ctx);
      const t = this._types(s)[0];
      if (!isType(value, t)) return this._renderMismatch(ctx, t, value);
      switch (t) {
        case 'object': return this._renderObject(ctx);
        case 'array': return this._renderArray(ctx);
        case 'string': return this._renderString(ctx);
        case 'number': return this._renderNumber(ctx, false);
        case 'integer': return this._renderNumber(ctx, true);
        case 'boolean': return this._renderBoolean(ctx);
        default: return void body.append(h('span', { class: 'se-const' }, 'null'));
      }
    }

    _renderMismatch(ctx, t, value) {
      const { path, body, rebuild, s } = ctx;
      const btn = h('button', { type: 'button', class: 'se-btn' }, 'Replace with a valid ' + t);
      btn.onclick = () => {
        const nv = this._defaultFor(s);
        const r = this._commit(d => setAt(d, path, nv), btn, path);
        if (r.ok) rebuild(); else this._notice(btn, this._fmt(r.errors, toPtr(path)));
      };
      body.append(h('code', { class: 'se-const' }, JSON.stringify(value)), ' ', btn);
    }

    _renderVariant(ctx, { list, idx }) {
      const { path, body } = ctx;
      let cur = idx;
      const sel = h('select', { class: 'se-select se-variant', 'aria-label': 'Alternative' });
      list.forEach((v, i) => sel.append(h('option', { value: String(i) }, v.label)));
      sel.value = String(cur);
      const bar = h('div', { class: 'se-variant-bar' }, sel);
      const inner = h('div', { class: 'se-variant-body' });
      const fill = () => { inner.textContent = ''; inner.append(this._renderNode(list[cur].schema, path)); };
      sel.addEventListener('change', () => {
        const i = +sel.value;
        const nv = this._defaultFor(list[i].schema);
        const r = this._commit(d => setAt(d, path, nv), sel, path);
        if (r.ok) { cur = i; fill(); this._refreshErrors(); }
        else { sel.value = String(cur); this._notice(bar, this._fmt(r.errors, toPtr(path))); }
      });
      fill();
      body.append(bar, inner);
    }

    _renderEnum(ctx) {
      const { s, path, body } = ctx;
      const value = getAt(this._doc, path);
      // Anything that isn't a string (null, true, false, a number, an object or an array) is shown as
      // JSON text with a class that the stylesheet draws in a distinct colour and a fixed-width font.
      // Strings are shown as they are.
      const isLiteral = v => typeof v !== 'string';
      const label = v => (typeof v === 'string' ? v : JSON.stringify(v));
      const sel = h('select', { class: 'se-select', 'data-fk': toPtr(path) });
      let cur = s.enum.findIndex(e => deepEqual(e, value));
      const markSelected = () => sel.classList.toggle('se-literal', cur >= 0 && isLiteral(s.enum[cur]));
      if (cur < 0) sel.append(h('option', { value: '-1', disabled: true }, '(current value is not allowed)'));
      s.enum.forEach((v, i) => sel.append(h('option', { value: String(i), class: isLiteral(v) ? 'se-literal' : null }, label(v))));
      sel.value = String(cur);
      markSelected();
      sel.addEventListener('change', () => {
        const i = +sel.value;
        const r = this._commit(d => setAt(d, path, clone(s.enum[i])), sel, path);
        if (r.ok) cur = i;
        else { sel.value = String(cur); this._notice(sel, this._fmt(r.errors, toPtr(path))); }
        markSelected();
      });
      body.append(sel);
    }

    _renderBoolean(ctx) {
      const { path, body } = ctx;
      const value = getAt(this._doc, path);
      const cb = h('input', { type: 'checkbox', 'data-fk': toPtr(path) });
      cb.checked = value;
      const txt = h('span', null, String(value));
      cb.addEventListener('change', () => {
        const r = this._commit(d => setAt(d, path, cb.checked), cb, path);
        if (r.ok) txt.textContent = String(cb.checked);
        else { cb.checked = !cb.checked; this._notice(cb.parentNode, this._fmt(r.errors, toPtr(path))); }
      });
      body.append(h('label', { class: 'se-check' }, cb, txt));
    }

    _renderString(ctx) {
      const { s, path, body } = ctx;
      const ptr = toPtr(path);
      const multi = s.format === 'textarea' || (s.maxLength !== undefined && s.maxLength > 200);
      const input = h(multi ? 'textarea' : 'input', { class: 'se-input', 'data-fk': ptr });
      if (!multi) input.type = { email: 'email', uri: 'url', date: 'date', password: 'password' }[s.format] || 'text';
      input.value = getAt(this._doc, path);
      if (s.format === 'date-time') input.placeholder = '2024-01-31T12:00:00Z';
      const draft = h('div', { class: 'se-draft' });
      input.addEventListener('input', () => {
        const r = this._commit(d => setAt(d, path, input.value), input, path);
        draft.textContent = r.ok ? '' : this._fmt(r.errors, ptr)[0];
        input.classList.toggle('se-bad', !r.ok);
      });
      input.addEventListener('blur', () => { // an unaccepted draft never lingers
        const cur = getAt(this._doc, path);
        if (typeof cur === 'string' && input.value !== cur) input.value = cur;
        draft.textContent = '';
        input.classList.remove('se-bad');
      });
      body.append(input, draft);
    }

    _renderNumber(ctx, integer) {
      const { s, path, body } = ctx;
      const ptr = toPtr(path);
      const input = h('input', { class: 'se-input', type: 'number', 'data-fk': ptr });
      input.step = s.multipleOf > 0 ? String(s.multipleOf) : integer ? '1' : 'any';
      if (typeof s.minimum === 'number') input.min = String(s.minimum);
      if (typeof s.maximum === 'number') input.max = String(s.maximum);
      input.value = String(getAt(this._doc, path));
      const draft = h('div', { class: 'se-draft' });
      input.addEventListener('input', () => {
        const raw = input.value;
        let r;
        if (raw === '' || (input.validity && input.validity.badInput)) r = { ok: false, errors: [{ path: ptr, message: 'Enter a valid number' }] };
        else r = this._commit(d => setAt(d, path, Number(raw)), input, path);
        draft.textContent = r.ok ? '' : this._fmt(r.errors, ptr)[0];
        input.classList.toggle('se-bad', !r.ok);
      });
      input.addEventListener('blur', () => {
        const cur = getAt(this._doc, path);
        if (typeof cur === 'number' && Number(input.value) !== cur) input.value = String(cur);
        if (typeof cur === 'number' && input.value === '') input.value = String(cur);
        draft.textContent = '';
        input.classList.remove('se-bad');
      });
      body.append(input, draft);
    }

    _renderObject(ctx) {
      const { schema, s, path, body, rebuild } = ctx;
      const box = h('div', { class: 'se-object' });
      body.append(box);

      // if/then/else and dependent schemas can change which fields exist as values change.
      const effKey = JSON.stringify(s);
      box.addEventListener('se-commit', () => {
        const cur = getAt(this._doc, path);
        if (isObj(cur) && JSON.stringify(this._norm(schema, cur)) !== effKey) rebuild();
      });

      const value = getAt(this._doc, path);
      const props = isObj(s.properties) ? s.properties : {};
      const req = new Set(Array.isArray(s.required) ? s.required : []);
      const keys = Object.keys(value);
      const minP = s.minProperties || 0;
      const atMax = s.maxProperties !== undefined && keys.length >= s.maxProperties;

      const button = (text, title, disabled, fn) => {
        const b = h('button', { type: 'button', class: 'se-btn', title, disabled }, text);
        b.addEventListener('click', () => fn(b));
        return b;
      };

      // With many optional properties, absent ones go in one menu instead of a row each.
      const absentOptional = Object.keys(props).filter(k =>
        !hasOwn(value, k) && !req.has(k) && this._propSchema(s, k) !== null).length;
      const compactAbsent = absentOptional > 8;
      const absent = [];

      // Declared properties, in schema order.
      for (const key of Object.keys(props)) {
        const sub = this._propSchema(s, key);
        if (sub === null) continue;
        const ns = this._norm(sub);
        const head = h('div', { class: 'se-head' },
          h('span', { class: 'se-label' }, ns.title || key, req.has(key) ? h('span', { class: 'se-req', title: 'Required' }, ' *') : null));
        const row = h('div', { class: 'se-field' }, head);
        if (ns.description) row.append(h('div', { class: 'se-desc' }, ns.description));
        const childPath = path.concat(key);
        if (hasOwn(value, key)) {
          if (!req.has(key))
            head.append(button('✕', 'Remove this property', keys.length <= minP, b => {
              const r = this._commit(d => { delete getAt(d, path)[key]; }, row, childPath, { noRepair: true, removed: true });
              if (r.ok) rebuild(); else this._notice(row, this._fmt(r.errors, toPtr(path)));
            }));
          row.append(this._renderNode(sub, childPath));
        } else if (compactAbsent && !req.has(key)) {
          absent.push({ key, label: ns.title || key, sub });
          continue;
        } else {
          row.classList.add('se-absent');
          head.append(button('+ Add', 'Add this property', atMax, b => {
            const nv = this._defaultFor(sub);
            const r = this._commit(d => { getAt(d, path)[key] = nv; }, row, childPath);
            if (r.ok) rebuild(); else this._notice(row, this._fmt(r.errors, toPtr(path)));
          }));
        }
        box.append(row);
      }

      if (absent.length) {
        const sel = h('select', { class: 'se-select se-addprop', 'aria-label': 'Add a property', disabled: atMax });
        sel.append(h('option', { value: '' }, 'Add a property…'));
        absent.forEach((a, i) => sel.append(h('option', { value: String(i) }, a.label)));
        sel.addEventListener('change', () => {
          if (sel.value === '') return;
          const a = absent[+sel.value];
          const nv = this._defaultFor(a.sub);
          const r = this._commit(d => { getAt(d, path)[a.key] = nv; }, sel, path.concat(a.key));
          if (r.ok) rebuild();
          else { sel.value = ''; this._notice(sel, this._fmt(r.errors, toPtr(path))); }
        });
        box.append(h('div', { class: 'se-addprop-row' }, sel));
      }

      // Properties that are not declared (additionalProperties). Editing a key renames the property.
      const renameHandler = (key, keyInput, anchor, tell) => () => {
        const nk = keyInput.value;
        if (nk === key) return;
        const r = this._commit(d => {
          const o = getAt(d, path);
          if (nk === '' || nk === '__proto__') throw new Error('Invalid property name');
          if (hasOwn(o, nk)) throw new Error('Property "' + nk + '" already exists');
          replaceKeys(o, Object.entries(o).map(([k, v]) => [k === key ? nk : k, v]));
        }, anchor, path.concat(nk), { primary: [{ op: 'move', from: toPtr(path.concat(key)), path: toPtr(path.concat(nk)) }] });
        if (r.ok) rebuild();
        else { keyInput.value = key; tell(this._fmt(r.errors, toPtr(path))); }
      };
      const removeProperty = (key, anchor, tell) => {
        const r = this._commit(d => { delete getAt(d, path)[key]; }, anchor, path.concat(key), { noRepair: true, removed: true });
        if (r.ok) rebuild(); else tell(this._fmt(r.errors, toPtr(path)));
      };
      const keyField = (key, locked, tail) => h('input', {
        class: 'se-key', type: 'text', value: key, readOnly: locked || tail,
        title: 'Property name', 'aria-label': 'Property name', 'data-fk': toPtr(path) + '#' + escTok(key),
      });

      // ...as a list of fields, each with its own name and editor
      const listExtras = () => keys.filter(k => !hasOwn(props, k)).map(key => {
        const sub = this._propSchema(s, key);
        const locked = req.has(key);
        const keyInput = keyField(key, locked, sub === null);
        const head = h('div', { class: 'se-head' }, keyInput);
        const row = h('div', { class: 'se-field se-extra' }, head);
        const tell = msgs => this._notice(row, msgs);
        if (!locked) head.append(button('✕', 'Remove this property', keys.length <= minP, () => removeProperty(key, row, tell)));
        keyInput.addEventListener('change', renameHandler(key, keyInput, row, tell));
        row.append(sub === null ? h('code', { class: 'se-const' }, JSON.stringify(value[key])) : this._renderNode(sub, path.concat(key)));
        return row;
      });

      // ...or, when each is an object with a fixed set of simple properties, as a table: the name
      // first, then a column per property. (The declared properties above stay as they are.)
      const objectTable = columns => {
        const name = (isObj(s.propertyNames) && s.propertyNames.title) || 'Name';
        const { table, tbody } = this._tableShell(columns, name, 'se-th-name', OBJECT_TABLE_BASE);
        for (const key of keys.filter(k => !hasOwn(props, k))) {
          const rowPath = path.concat(key);
          const locked = req.has(key);
          const { tr, errRow, tell } = this._tableRow(rowPath, columns);
          const keyInput = keyField(key, locked, false);
          keyInput.addEventListener('change', renameHandler(key, keyInput, tr, tell));
          tr.append(h('td', { class: 'se-name' }, keyInput));
          for (const td of this._tableCells(columns, rowPath, value[key], tr, tell, rebuild, this._propSchema(s, key), 'row ' + key)) tr.append(td);
          const ctl = h('div', { class: 'se-item-ctl' });
          if (!locked) ctl.append(button('✕', 'Remove this property', keys.length <= minP, () => removeProperty(key, tr, tell)));
          tr.append(h('td', { class: 'se-cell-ctl' }, ctl));
          tbody.append(tr, errRow);
        }
        return [h('div', { class: 'se-tablewrap' }, table)];
      };

      const patterns = isObj(s.patternProperties) && Object.keys(s.patternProperties).length > 0;
      const columns = isObj(s.additionalProperties) && !patterns ? this._tableColumns(s.additionalProperties) : null;
      const hasExtras = keys.some(k => !hasOwn(props, k));
      let addRow = null;
      const drawExtras = asTable => {
        box.querySelectorAll(':scope > .se-extra, :scope > .se-tablewrap').forEach(n => n.remove());
        for (const el of asTable && hasExtras ? objectTable(columns) : listExtras()) box.insertBefore(el, addRow);
      };
      drawExtras(this._chooseLayout(ctx, s, path, body, columns, OBJECT_TABLE_BASE, drawExtras,
        'its additional properties are not objects with a fixed set of simple properties'));

      // "Add property" row, when the schema allows free-form keys.
      const freeForm = s.additionalProperties !== false || patterns;
      if (freeForm) {
        const ki = h('input', { class: 'se-key', type: 'text', placeholder: 'New property name', 'aria-label': 'New property name' });
        const add = button('+ Add property', 'Add a property with this name', atMax, b => {
          const k = ki.value;
          const cur = getAt(this._doc, path);
          if (k === '' || k === '__proto__') return this._notice(addRow, ['Enter a property name']);
          if (hasOwn(cur, k)) return this._notice(addRow, ['Property "' + k + '" already exists']);
          const sub = this._propSchema(s, k);
          if (sub === null) return this._notice(addRow, ['Property "' + k + '" is not allowed here']);
          const nv = this._defaultFor(sub);
          const r = this._commit(d => { getAt(d, path)[k] = nv; }, b, path.concat(k));
          if (r.ok) rebuild(); else this._notice(addRow, this._fmt(r.errors, toPtr(path)));
        });
        ki.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add.click(); } });
        addRow = h('div', { class: 'se-addrow' }, ki, add);
        box.append(addRow);
      }
    }

    // ---- tables: an array's items, or an object's additional properties, as rows with a column per property

    // The columns for showing rows as a table, or null if `itemSchema` isn't an object schema with a
    // fixed set of simple properties.
    _tableColumns(itemSchema) {
      if (!isObj(itemSchema)) return null;              // not a schema for every row (or a tuple)
      const item = this._norm(itemSchema);
      const unstable = ['oneOf', 'anyOf', 'if', 'dependentSchemas', 'dependencies'];   // can change a row's shape
      if (unstable.some(k => k in item)) return null;
      if (!isObj(item.properties) || item.additionalProperties !== false) return null;
      if (isObj(item.patternProperties) && Object.keys(item.patternProperties).length) return null;
      const types = this._types(item);
      if (types.length !== 1 || types[0] !== 'object') return null;
      const required = new Set(Array.isArray(item.required) ? item.required : []);
      const isScalar = v => v === null || typeof v !== 'object';
      const columns = [];
      for (const key of Object.keys(item.properties)) {
        const ps = this._norm(item.properties[key]);
        if (unstable.some(k => k in ps)) return null;
        let kind = null;
        if ('const' in ps) kind = isScalar(ps.const) ? 'const' : null;
        else if (Array.isArray(ps.enum)) kind = ps.enum.every(isScalar) ? 'enum' : null;
        else {
          const ts = this._types(ps);
          if (ts.length === 1 && ['string', 'number', 'integer', 'boolean', 'null'].includes(ts[0]))
            kind = ts[0] === 'integer' ? 'number' : ts[0];
        }
        if (!kind) return null;
        columns.push({ key, kind, schema: item.properties[key], title: ps.title || key, description: ps.description || '',
                       required: required.has(key) });
      }
      return columns.length ? columns : null;
    }

    // How wide (in px) a table of these columns needs to be to be comfortable: `base` for the
    // leading column and the row buttons, plus a minimum for each column.
    _tableWidth(columns, base) {
      return base + columns.reduce((sum, c) => sum + columnMin(c), 0);
    }

    // The table and its heading row. `first` heads the leading column: "#" for an array's rows
    // (their numbers), "Name" for an object's (their property names).
    _tableShell(columns, first, firstClass, base) {
      // Never narrower than the columns need: a table forced on a narrow page scrolls sideways
      // rather than squashing its controls.
      const table = h('table', { class: 'se-table', style: 'min-width:' + this._tableWidth(columns, base) + 'px' });
      table.append(h('thead', null, h('tr', null,
        h('th', { scope: 'col', class: firstClass }, first),
        columns.map(c => h('th', { scope: 'col', title: c.description || null, style: 'min-width:' + columnMin(c) + 'px' }, c.title,
          c.required ? h('span', { class: 'se-req', title: 'Required' }, ' *') : null)),
        h('th', { scope: 'col', class: 'se-th-ctl' }, h('span', { class: 'se-sr' }, 'Row actions')))));
      const tbody = h('tbody');
      table.append(tbody);
      return { table, tbody };
    }

    // A row, and a hidden row beneath it for errors about the row itself. `tell(messages)` shows
    // why an edit to the row was refused.
    _tableRow(rowPath, columns) {
      const errBox = h('div', { class: 'se-errors' });
      const errRow = h('tr', { class: 'se-row-errors', hidden: true }, h('td', { colspan: String(columns.length + 2) }, errBox));
      const tr = h('tr', { class: 'se-row se-node', 'data-ptr': toPtr(rowPath) });
      tr._errBox = errBox;                    // errors about the row itself are shown in the row below it
      tr._errRow = errRow;
      const tell = msgs => {
        errRow.hidden = false;
        this._notice(errBox, msgs);
        setTimeout(() => { if (!errBox.textContent.trim()) errRow.hidden = true; }, 5100);
      };
      return { tr, errRow, tell };
    }

    // The cells of a row: the normal editor for each property, with + to add an optional property
    // a row lacks and ✕ to clear one it has. `rowSchema` and `label` are for the row as a whole.
    _tableCells(columns, rowPath, value, tr, tell, rebuild, rowSchema, label) {
      const small = (text, title, fn) => {
        const b = h('button', { type: 'button', class: 'se-btn', title, 'aria-label': title }, text);
        b.addEventListener('click', fn);
        return b;
      };
      if (!isObj(value)) {                    // something that isn't an object: the normal way to put it right
        return [h('td', { colspan: String(columns.length) }, this._renderNode(rowSchema, rowPath))];
      }
      return columns.map(c => {
        const cellPath = rowPath.concat(c.key);
        const td = h('td', { class: 'se-cell' });
        if (hasOwn(value, c.key)) {
          const cell = this._renderNode(c.schema, cellPath);
          cell.querySelectorAll('input, select, textarea').forEach(el => el.setAttribute('aria-label', `${c.title}, ${label}`));
          const inner = h('div', { class: 'se-cell-inner' }, cell);
          if (!c.required) inner.append(small('✕', 'Remove ' + c.title, () => {
            const r = this._commit(d => { delete getAt(d, rowPath)[c.key]; }, tr, cellPath, { noRepair: true, removed: true });
            if (r.ok) rebuild(); else tell(this._fmt(r.errors, toPtr(rowPath)));
          }));
          td.append(inner);
        } else {
          td.append(small('+', 'Add ' + c.title, () => {
            const nv = this._defaultFor(c.schema);
            const r = this._commit(d => { getAt(d, rowPath)[c.key] = nv; }, tr, cellPath);
            if (r.ok) rebuild(); else tell(this._fmt(r.errors, toPtr(rowPath)));
          }));
        }
        return td;
      });
    }

    // Table or rows? The `tabular` keyword: true for always, false for never, otherwise a table when
    // the columns fit in the width available, and it is watched, so it switches as the width changes.
    // Returns whether to start with a table; `redraw(asTable)` draws the rows either way. Things that
    // can't be a table (`columns` is null) never are.
    _chooseLayout(ctx, s, path, body, columns, base, redraw, reason) {
      const tabular = typeof s.tabular === 'boolean' ? s.tabular : undefined;
      if (tabular === true && !columns)
        console.warn('schmeditor: "tabular": true is ignored for ' + (toPtr(path) || 'the document') + ', because ' + reason);
      if (!columns || tabular === false) return false;
      if (tabular === true) return true;
      const needed = this._tableWidth(columns, base);
      // Keep what the last layout decided across rebuilds, so adding a row doesn't flicker; the
      // first time, guess from the width of the whole editor (less some for nesting).
      let asTable = ctx.asTable !== undefined ? ctx.asTable
        : this.container.getBoundingClientRect().width - path.length * 12 >= needed;
      if (ctx.watcher) ctx.watcher.disconnect();
      if (typeof ResizeObserver === 'function') {
        const watcher = ctx.watcher = new ResizeObserver(entries => {
          if (!body.isConnected) { watcher.disconnect(); return; }     // this has been redrawn or removed
          const width = entries[entries.length - 1].contentRect.width;
          if (width === 0) return;                                      // hidden: nothing to measure
          const wanted = width >= needed;
          if (wanted !== asTable) { asTable = ctx.asTable = wanted; this._keepFocus(() => redraw(asTable)); }
        });
        watcher.observe(body);
      }
      ctx.asTable = asTable;
      return asTable;
    }

    _renderArray(ctx) {
      const { s, path, body, rebuild } = ctx;
      const arr = getAt(this._doc, path);
      const minI = s.minItems || 0;
      // Fixed length: the schema allows exactly one array length (e.g. a closed prefixItems
      // tuple with minItems equal to its size), so add/remove controls would never be usable.
      const prefixLen = Array.isArray(s.prefixItems) ? s.prefixItems.length : Array.isArray(s.items) ? s.items.length : 0;
      const closed = this._itemSchema(s, prefixLen) === false;
      const maxLen = Math.min(s.maxItems === undefined ? Infinity : s.maxItems, closed ? prefixLen : Infinity);
      const fixed = maxLen <= minI;
      const positional = fixed && prefixLen > 0; // reordering a fixed tuple is meaningless
      const list = h('div', { class: 'se-array' });
      body.append(list);

      const button = (text, title, disabled, fn) => {
        const b = h('button', { type: 'button', class: 'se-btn', title, 'aria-label': title, disabled }, text);
        b.addEventListener('click', () => fn(b));
        return b;
      };

      // The row buttons: move up, move down, remove. `tell(messages)` shows why an edit was refused.
      const itemControls = (i, row, tell) => {
        const move = dir => {
          const r = this._commit(d => {
            const a = getAt(d, path);
            const [x] = a.splice(i, 1);
            a.splice(i + dir, 0, x);
          }, row, path, { primary: [{ op: 'move', from: toPtr(path.concat(i)), path: toPtr(path.concat(i + dir)) }] });
          if (r.ok) rebuild(); else tell(this._fmt(r.errors, toPtr(path)));
        };
        // Tuple slots (prefixItems / array-form items) have a schema tied to their position, so
        // they never move, and they can only be removed from the end of the array (and never
        // below minItems). Buttons that could never be enabled are not drawn at all.
        const pinned = i < prefixLen;
        const ctl = h('div', { class: 'se-item-ctl' });
        if (!pinned && !positional)
          ctl.append(
            button('↑', 'Move up', i <= prefixLen, () => move(-1)),
            button('↓', 'Move down', i === arr.length - 1, () => move(1)));
        if (!fixed && (!pinned || i >= minI))
          ctl.append(button('✕', 'Remove item', arr.length <= minI || (pinned && i !== arr.length - 1), () => {
            const r = this._commit(d => { getAt(d, path).splice(i, 1); }, row, path.concat(i), { removed: true });
            if (r.ok) rebuild(); else tell(this._fmt(r.errors, toPtr(path)));
          }));
        return ctl;
      };

      // The items as a list of rows, each holding the item's own editor.
      const listRows = () => arr.map((_, i) => {
        const row = h('div', { class: 'se-item' });
        const main = h('div', { class: 'se-item-main' }, this._renderNode(this._itemSchema(s, i), path.concat(i)));
        const ctl = itemControls(i, row, msgs => this._notice(row, msgs));
        row.append(h('span', { class: 'se-idx' }, String(i + 1)), main);
        if (ctl.children.length || !fixed) row.append(ctl); // an empty column keeps rows aligned
        return row;
      });

      // The items as a table: a row per object, a column per property. Each cell is the normal
      // editor for that property, so checking, patches and the render hook all work as usual.
      const tableRows = columns => {
        const { table, tbody } = this._tableShell(columns, '#', 'se-th-idx', ARRAY_TABLE_BASE);
        arr.forEach((value, i) => {
          const rowPath = path.concat(i);
          const { tr, errRow, tell } = this._tableRow(rowPath, columns);
          tr.append(h('td', { class: 'se-idx' }, String(i + 1)));
          for (const td of this._tableCells(columns, rowPath, value, tr, tell, rebuild, this._itemSchema(s, i), 'row ' + (i + 1))) tr.append(td);
          tr.append(h('td', { class: 'se-cell-ctl' }, itemControls(i, tr, tell)));
          tbody.append(tr, errRow);
        });
        return [h('div', { class: 'se-tablewrap' }, table)];
      };

      const columns = prefixLen === 0 ? this._tableColumns(s.items) : null;
      let addRow = null;
      const draw = asTable => {
        list.querySelectorAll(':scope > .se-item, :scope > .se-tablewrap').forEach(n => n.remove());
        for (const el of asTable && arr.length ? tableRows(columns) : listRows()) list.insertBefore(el, addRow);
      };
      draw(this._chooseLayout(ctx, s, path, body, columns, ARRAY_TABLE_BASE, draw, 'its items are not objects with a fixed set of simple properties'));

      if (fixed) return;
      const nextSchema = this._itemSchema(s, arr.length);
      const full = (s.maxItems !== undefined && arr.length >= s.maxItems) || nextSchema === false;
      addRow = h('div', { class: 'se-addrow' });
      addRow.append(button('+ Add item', 'Add an item', full, b => {
        let r, firstFailure;
        for (const nv of this._candidates(nextSchema)) {
          r = this._commit(d => { getAt(d, path).push(clone(nv)); }, b, path.concat(arr.length));
          if (r.ok) break;
          firstFailure = firstFailure || r;
        }
        if (r.ok) rebuild(); else this._notice(addRow, this._fmt(firstFailure.errors, toPtr(path)));
      }));
      list.append(addRow);
    }
  }

  /** Apply a JSON Patch (RFC 6902) to a copy of a document, e.g. one received by the change callback. */
  SchemaEditor.applyPatch = applyPatch;
  SchemaEditor._diffPatch = diffPatch;       // internal; exposed for the tests

  return SchemaEditor;
});
