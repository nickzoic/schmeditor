'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.CustomEvent = dom.window.CustomEvent;
const SchemaEditor = require('../schmeditor.js');

const example = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'examples', name), 'utf8'));
const contactSchema = example('contact.schema.json');
const contactDoc = example('contact.json');
const metaschema = example('editor-metaschema.json');

const make = (schema, doc, options) => {
  const el = document.createElement('div');
  const editor = new SchemaEditor(el, schema, doc, options);
  return { el, editor };
};
const fire = (node, type) => node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const node = (el, ptr) => el.querySelector(`[data-ptr="${ptr}"]`);
const button = (root, text) => [...root.querySelectorAll('button')].find(b => b.textContent === text);

test('the example document is valid for the example schema', () => {
  assert.deepEqual(make(contactSchema, contactDoc).editor.validate(), []);
});

test('the metaschema accepts the example schema and itself', () => {
  assert.deepEqual(make(metaschema, contactSchema).editor.validate(), []);
  assert.deepEqual(make(metaschema, metaschema).editor.validate(), []);
});

test('a missing document is created from the schema defaults', () => {
  assert.deepEqual(make(contactSchema).editor.getDocument(), { name: 'Unnamed', tags: ['x'] });
});

test('typing: valid text commits, invalid text is refused and the document keeps its value', () => {
  const { el, editor } = make(contactSchema, contactDoc);
  const input = node(el, '/name').querySelector('input');
  input.value = 'A';
  fire(input, 'input');
  assert.equal(editor.get('/name'), 'Ada');
  assert.match(node(el, '/name').querySelector('.se-draft').textContent, /at least 2/);
  input.value = 'Alice';
  fire(input, 'input');
  assert.equal(editor.get('/name'), 'Alice');
});

test('programmatic edits are checked and refused with a list of errors', () => {
  const { editor } = make(contactSchema, contactDoc);
  editor.set('/numbers/quantity', 5);
  assert.equal(editor.get('/numbers/quantity'), 5);
  assert.throws(() => editor.set('/numbers/quantity', 999), err => err.errors.length > 0 && /at most 99/.test(err.message));
  assert.throws(() => editor.remove('/name'), /required/);
  assert.throws(() => editor.push('/name', 'x'));
  assert.equal(editor.get('/numbers/quantity'), 5);
  assert.ok(editor.isValid());
});

const copy = v => JSON.parse(JSON.stringify(v));

// An editor whose change callback checks every notification: the patch must turn the document as
// it was into the document it now is. (Failures are collected, because the editor catches errors
// thrown inside callbacks.)
function tracked(schema, doc, options) {
  const state = { before: copy(doc), events: [], problems: [] };
  const made = make(schema, doc, {
    notifyOnProgrammatic: true,
    ...options,
    onChange: (after, info) => {
      state.events.push(info);
      try {
        assert.deepEqual(SchemaEditor.applyPatch(state.before, info.patch), after);
      } catch (e) {
        state.problems.push(`${JSON.stringify(info.patch)}: ${e.message}`);
      }
      state.before = after;
    },
  });
  return { ...made, state };
}

test('the callback hears user edits, and API edits only when asked', () => {
  const calls = [];
  const { el, editor } = make(contactSchema, contactDoc, { onChange: (doc, info) => calls.push(info) });
  editor.set('/name', 'Zed');
  assert.deepEqual(calls, []);
  const input = node(el, '/username').querySelector('input');
  input.value = 'grace';
  fire(input, 'input');
  assert.deepEqual(calls, [{
    source: 'user', path: '/username', value: 'grace',
    patch: [{ op: 'replace', path: '/username', value: 'grace' }],
  }]);
  const noisy = make(contactSchema, contactDoc, { notifyOnProgrammatic: true, onChange: (d, i) => calls.push(i) });
  noisy.editor.set('/name', 'Zed');
  assert.deepEqual(calls.at(-1), {
    source: 'api', path: '/name', value: 'Zed',
    patch: [{ op: 'replace', path: '/name', value: 'Zed' }],
  });
});

test('each kind of UI edit reports the JSON Patch operation that describes it', () => {
  const { el, editor, state } = tracked(contactSchema, contactDoc);
  const last = () => state.events.at(-1);

  const input = node(el, '/name').querySelector('input');
  input.value = 'Alice';
  fire(input, 'input');
  assert.deepEqual(last().patch, [{ op: 'replace', path: '/name', value: 'Alice' }]);
  assert.equal(last().value, 'Alice');

  button(node(el, '/tags'), '+ Add item').click();                       // add an array item
  assert.deepEqual(last().patch, [{ op: 'add', path: '/tags/2', value: 'x' }]);

  button(node(el, '/tags/0').closest('.se-item'), '↓').click();          // move an array item
  assert.deepEqual(last().patch, [{ op: 'move', from: '/tags/0', path: '/tags/1' }]);
  assert.equal(last().path, '/tags');
  assert.deepEqual(last().value, ['engines', 'math', 'x']);

  button(node(el, '/tags/0').closest('.se-item'), '✕').click();          // remove an array item
  assert.deepEqual(last().patch, [{ op: 'remove', path: '/tags/0' }]);
  assert.equal(last().value, undefined);                                  // not the item that shifted down
  assert.deepEqual(editor.get('/tags'), ['math', 'x']);

  button(node(el, '/address').closest('.se-field'), '✕').click();        // remove a property
  assert.deepEqual(last().patch, [{ op: 'remove', path: '/address' }]);

  const key = node(el, '/objects/labels/team').closest('.se-field').querySelector('input.se-key');
  key.value = 'crew';                                                     // rename a property
  fire(key, 'change');
  assert.deepEqual(last().patch, [{ op: 'move', from: '/objects/labels/team', path: '/objects/labels/crew' }]);

  const pet = node(el, '/composition/pet').querySelector('select.se-variant');
  pet.value = '1';                                                        // switch alternative: the whole value is replaced
  fire(pet, 'change');
  assert.deepEqual(last().patch, [{ op: 'replace', path: '/composition/pet', value: { fins: 1 } }]);

  assert.deepEqual(state.problems, []);
});

test('properties the editor fills in appear in the patch, after the main operation', () => {
  const { el, state } = tracked(contactSchema, contactDoc);
  const select = node(el, '/role').querySelector('select');
  select.value = '2';                                                     // "staff" makes department required
  fire(select, 'change');
  assert.deepEqual(state.events.at(-1).patch, [
    { op: 'replace', path: '/role', value: 'staff' },
    { op: 'add', path: '/department', value: 'Operations' },
  ]);
  assert.equal(state.events.at(-1).path, '/role');
  assert.deepEqual(state.problems, []);
});

test('the patch is a copy: changing it, or the doc or value, cannot change the editor', () => {
  let received;
  const { el, editor } = make(contactSchema, contactDoc, { onChange: (doc, info) => { received = { doc, info }; } });
  button(node(el, '/tags'), '+ Add item').click();
  received.info.patch[0].value = 'tampered';
  received.info.value = 'tampered';
  received.doc.tags.push('tampered');
  assert.deepEqual(editor.get('/tags'), ['math', 'engines', 'x']);
});

test('programmatic changes report JSON Patch operations when notifications are on', () => {
  const { editor, state } = tracked(contactSchema, contactDoc);
  editor.set('/numbers/quantity', 5);
  editor.remove('/address');
  editor.push('/tags', 'x');
  editor.insert('/tags', 0, 'first');
  editor.set('/arrays/milestones/2', 7);                                  // one past the end adds
  editor.setDocument({ name: 'Zed', tags: ['t'] });
  assert.deepEqual(state.events.map(e => e.patch), [
    [{ op: 'replace', path: '/numbers/quantity', value: 5 }],
    [{ op: 'remove', path: '/address' }],
    [{ op: 'add', path: '/tags/2', value: 'x' }],
    [{ op: 'add', path: '/tags/0', value: 'first' }],
    [{ op: 'add', path: '/arrays/milestones/2', value: 7 }],
    [{ op: 'replace', path: '', value: { name: 'Zed', tags: ['t'] } }],
  ]);
  assert.deepEqual(state.events.map(e => [e.path, e.value]), [
    ['/numbers/quantity', 5],
    ['/address', undefined],
    ['/tags', ['math', 'engines', 'x']],
    ['/tags', ['first', 'math', 'engines', 'x']],
    ['/arrays/milestones/2', 7],
    ['', { name: 'Zed', tags: ['t'] }],
  ]);
  assert.deepEqual(state.problems, []);
});

test('every notification\'s patch reproduces the document, across many kinds of edit', () => {
  const { el, editor, state } = tracked(contactSchema, contactDoc);
  const type = (ptr, text) => { const i = node(el, ptr).querySelector('input'); i.value = text; fire(i, 'input'); };
  type('/username', 'grace');
  type('/numbers/quantity', '7');
  button(node(el, '/arrays/milestones'), '+ Add item').click();
  button(node(el, '/arrays/milestones/0').closest('.se-item'), '↓').click();
  button(node(el, '/arrays/legacy'), '+ Add item').click();
  const role = node(el, '/role').querySelector('select');
  role.value = '2'; fire(role, 'change');
  const ship = node(el, '/shipping/method').querySelector('select');
  ship.value = '1'; fire(ship, 'change');                                 // if/then/else adds a street
  const reach = node(el, '/composition/reach').querySelector('select.se-variant');
  reach.value = '2'; fire(reach, 'change');                               // anyOf: email -> mailing address
  const add = node(el, '/billing').querySelector(':scope > .se-nbody > .se-object > .se-field.se-absent button');
  if (add) add.click();                                                   // dependent properties are added too
  editor.set('/nickname', 'Ace');
  editor.insert('/composition/relatives', 0, { name: 'Zed' });
  editor.remove('/billing/card');
  assert.ok(state.events.length >= 10, `only ${state.events.length} notifications`);
  assert.deepEqual(state.problems, []);
});

test('editing a schema with the metaschema also reports correct patches', () => {
  const { el, editor, state } = tracked(metaschema, { type: 'object', properties: { id: { type: 'string' } } });
  const kind = node(el, '/properties/id').querySelector('select.se-variant');
  kind.value = [...kind.options].find(o => o.textContent === 'Several types').value;
  fire(kind, 'change');
  button(node(el, '/properties/id/type'), '+ Add item').click();
  const rootNode = [...el.querySelectorAll('[data-ptr=""]')].pop();     // the innermost node for the root
  const menu = rootNode.querySelector(':scope > .se-nbody > .se-object > .se-addprop-row select');
  menu.value = [...menu.options].find(o => o.textContent === 'required').value;
  fire(menu, 'change');
  editor.push('/required', 'id');
  assert.ok(state.events.length >= 4);
  assert.deepEqual(state.problems, []);
});

test('a patch is never wrong: bad main operations fall back to a plain diff, then to a full replace', () => {
  const { editor } = make({}, {});
  const apply = SchemaEditor.applyPatch;
  const bad = [{ op: 'remove', path: '/nowhere' }];                       // can't be applied to the old document
  const patch = editor._makePatch({ a: 1 }, { a: 2 }, bad);
  assert.deepEqual(patch, [{ op: 'replace', path: '/a', value: 2 }]);
  const wrong = [{ op: 'replace', path: '/a', value: 99 }];               // applies, but gives the wrong document
  assert.deepEqual(apply({ a: 1 }, editor._makePatch({ a: 1 }, { a: 2 }, wrong)), { a: 2 });
  assert.deepEqual(apply([1, 2, 3], editor._makePatch([1, 2, 3], [3, 1, 2], [{ op: 'move', from: '/0', path: '/1' }])), [3, 1, 2]);
});

test('stylesheet: colours live in custom properties, every var() is defined, dark mode is declared', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'schmeditor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const defined = new Set([...css.matchAll(/(--se-[\w-]+)\s*:/g)].map(m => m[1]));
  for (const m of css.matchAll(/var\((--se-[\w-]+)/g)) assert.ok(defined.has(m[1]), `${m[1]} is used but never defined`);
  const stray = css.split('\n').filter(line => /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(line) && !/^\s*--se-/.test(line));
  assert.deepEqual(stray, [], 'hard-coded colours outside custom properties');
  assert.match(css, /color-scheme:\s*light dark/);
  assert.match(css, /@media \(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /\[data-theme="light"\]/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, 'unbalanced braces');
});

test('applyPatch implements the examples in RFC 6902 appendix A', () => {
  const apply = SchemaEditor.applyPatch;
  const same = (doc, patch, expected) => assert.deepEqual(apply(doc, patch), expected);
  same({ foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux' }], { foo: 'bar', baz: 'qux' });                // A.1
  same({ foo: ['bar', 'baz'] }, [{ op: 'add', path: '/foo/1', value: 'qux' }], { foo: ['bar', 'qux', 'baz'] });   // A.2
  same({ baz: 'qux', foo: 'bar' }, [{ op: 'remove', path: '/baz' }], { foo: 'bar' });                           // A.3
  same({ foo: ['bar', 'qux', 'baz'] }, [{ op: 'remove', path: '/foo/1' }], { foo: ['bar', 'baz'] });            // A.4
  same({ baz: 'qux', foo: 'bar' }, [{ op: 'replace', path: '/baz', value: 'boo' }], { baz: 'boo', foo: 'bar' }); // A.5
  same({ foo: { bar: 'baz', waldo: 'fred' }, qux: { corge: 'grault' } },
    [{ op: 'move', from: '/foo/waldo', path: '/qux/thud' }],
    { foo: { bar: 'baz' }, qux: { corge: 'grault', thud: 'fred' } });                                            // A.6
  same({ foo: ['all', 'grass', 'cows', 'eat'] }, [{ op: 'move', from: '/foo/1', path: '/foo/3' }],
    { foo: ['all', 'cows', 'eat', 'grass'] });                                                                   // A.7
  same({ baz: 'qux', foo: ['a', 2, 'c'] }, [{ op: 'test', path: '/baz', value: 'qux' }, { op: 'test', path: '/foo/1', value: 2 }],
    { baz: 'qux', foo: ['a', 2, 'c'] });                                                                         // A.8
  assert.throws(() => apply({ baz: 'qux' }, [{ op: 'test', path: '/baz', value: 'bar' }]), /failed/);           // A.9
  same({ foo: 'bar' }, [{ op: 'add', path: '/child', value: { grandchild: {} } }], { foo: 'bar', child: { grandchild: {} } }); // A.10
  same({ foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux', xyz: 123 }], { foo: 'bar', baz: 'qux' });      // A.11
  assert.throws(() => apply({ foo: 'bar' }, [{ op: 'add', path: '/baz/bat', value: 'qux' }]), /failed/);        // A.12
  same({ '/': 9, '~1': 10 }, [{ op: 'test', path: '/~01', value: 10 }], { '/': 9, '~1': 10 });                  // A.14
  assert.throws(() => apply({ '/': 9, '~1': 10 }, [{ op: 'test', path: '/~01', value: '10' }]), /failed/);      // A.15
  same({ foo: ['bar'] }, [{ op: 'add', path: '/foo/-', value: ['abc', 'def'] }], { foo: ['bar', ['abc', 'def']] }); // A.16
  same({ a: [1] }, [{ op: 'copy', from: '/a', path: '/b' }], { a: [1], b: [1] });
  same(1, [{ op: 'replace', path: '', value: 2 }], 2);
});

test('applyPatch replaces in place, so members and items keep their positions', () => {
  const out = SchemaEditor.applyPatch({ a: 1, b: 2, c: 3, d: [1, 2, 3] },
    [{ op: 'replace', path: '/a', value: 9 }, { op: 'replace', path: '/d/1', value: 7 }]);
  assert.deepEqual(Object.keys(out), ['a', 'b', 'c', 'd']);
  assert.deepEqual(out.d, [1, 7, 3]);
});

test('applyPatch leaves its input alone and rejects bad operations', () => {
  const doc = { a: [1, 2, 3] };
  const out = SchemaEditor.applyPatch(doc, [{ op: 'remove', path: '/a/0' }]);
  assert.deepEqual(doc, { a: [1, 2, 3] });
  assert.deepEqual(out, { a: [2, 3] });
  for (const bad of [
    { op: 'remove', path: '/a/3' }, { op: 'remove', path: '/nope' }, { op: 'replace', path: '/nope', value: 1 },
    { op: 'add', path: '/a/05', value: 1 }, { op: 'add', path: '/a/9', value: 1 }, { op: 'move', from: '/a', path: '/a/0' },
    { op: 'frobnicate', path: '/a' }, { op: 'add', path: 'no-slash', value: 1 }, { op: 'add', path: '/__proto__', value: 1 },
  ]) assert.throws(() => SchemaEditor.applyPatch(doc, [bad]), /JSON Patch operation 0/, JSON.stringify(bad));
  assert.throws(() => SchemaEditor.applyPatch(doc, { op: 'remove', path: '/a' }), /array/);
});

test('diffs always reproduce the target document (randomised)', () => {
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = list => list[Math.floor(rand() * list.length)];
  const scalar = () => pick([0, 1, 2, 'a', 'b', '', true, false, null, 1.5, '/', '~']);
  const value = depth => {
    const r = rand();
    if (depth > 3 || r < 0.35) return scalar();
    if (r < 0.7) return Array.from({ length: Math.floor(rand() * 5) }, () => value(depth + 1));
    const o = {};
    for (let i = Math.floor(rand() * 4); i > 0; i--) o[pick(['a', 'b', 'c', 'd', 'a/b', 'x~y'])] = value(depth + 1);
    return o;
  };
  const mutate = v => {
    if (Array.isArray(v) && rand() < 0.8) {
      const a = v.map(copy);
      const r = rand();
      if (r < 0.25 && a.length) a.splice(Math.floor(rand() * a.length), 1);
      else if (r < 0.5) a.splice(Math.floor(rand() * (a.length + 1)), 0, value(2));
      else if (r < 0.7 && a.length > 1) a.splice(Math.floor(rand() * a.length), 0, a.splice(Math.floor(rand() * a.length), 1)[0]);
      else if (a.length) a[Math.floor(rand() * a.length)] = mutate(a[Math.floor(rand() * a.length)]);
      return a;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && rand() < 0.8) {
      const o = copy(v);
      const keys = Object.keys(o);
      const r = rand();
      if (r < 0.3 && keys.length) delete o[pick(keys)];
      else if (r < 0.6) o[pick(['a', 'b', 'c', 'e'])] = value(2);
      else if (keys.length) { const k = pick(keys); o[k] = mutate(o[k]); }
      return o;
    }
    return value(1);
  };
  for (let i = 0; i < 4000; i++) {
    const a = value(0);
    const b = rand() < 0.7 ? mutate(a) : value(0);
    const patch = SchemaEditor._diffPatch(a, b);
    assert.deepEqual(SchemaEditor.applyPatch(a, patch), b, JSON.stringify({ a, b, patch }));
  }
});

// ---- the render hook

test('render hook: called for every node, with its resolved schema, value and path', () => {
  const seen = [];
  make({ type: 'object', properties: { a: { $ref: '#/$defs/s' }, b: { type: 'array', items: { type: 'integer' } } },
         $defs: { s: { type: 'string', title: 'A string' } } },
  { a: 'x', b: [1, 2] },
  { render: info => { seen.push([info.path, info.schema.type, info.value]); } });
  assert.deepEqual(seen, [['', 'object', { a: 'x', b: [1, 2] }], ['/a', 'string', 'x'], ['/b', 'array', [1, 2]],
    ['/b/0', 'integer', 1], ['/b/1', 'integer', 2]]);
  const resolved = [];
  make({ $ref: '#/$defs/s', $defs: { s: { type: 'string', title: 'A string' } } }, 'x', { render: i => { resolved.push(i.schema); } });
  assert.equal(resolved.length, 1);
  assert.equal('$ref' in resolved[0], false);                                             // the $ref has been resolved…
  assert.equal(resolved[0].type, 'string');                                               // …into what it pointed at
  assert.equal(resolved[0].title, 'A string');
});

test('render hook: returning undefined or null keeps the normal rendering', () => {
  for (const nothing of [undefined, null]) {
    const { el } = make({ type: 'string' }, 'x', { render: () => nothing });
    assert.ok(el.querySelector('input.se-input'));
  }
});

test('render hook: a returned element replaces the node\'s editing controls', () => {
  const stars = info => {
    if (info.schema.type !== 'number' || info.schema.maximum !== 5) return undefined;
    const row = document.createElement('span');
    row.className = 'stars';
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button');
      b.textContent = n <= info.value ? '★' : '☆';
      b.addEventListener('click', () => info.set(n));
      row.append(b);
    }
    return row;
  };
  const schema = { type: 'object', properties: { rating: { type: 'number', minimum: 0, maximum: 5 }, name: { type: 'string' } } };
  const events = [];
  const { el, editor } = make(schema, { rating: 2, name: 'x' }, { render: stars, onChange: (d, i) => events.push(i) });
  assert.equal(node(el, '/rating').querySelector('input'), null);                         // the default input is gone…
  assert.ok(node(el, '/name').querySelector('input'));                                     // …but only for that node
  assert.ok(node(el, '/rating').closest('.se-field').querySelector('.se-label'));          // the label is still drawn
  assert.equal(node(el, '/rating').querySelectorAll('.stars button').length, 5);
  node(el, '/rating').querySelectorAll('.stars button')[3].click();
  assert.equal(editor.get('/rating'), 4);
  assert.deepEqual(events.at(-1).patch, [{ op: 'replace', path: '/rating', value: 4 }]);
  assert.equal(events.at(-1).source, 'user');
});

test('render hook: set() checks the schema and reports why a value was refused', () => {
  let info;
  const { editor } = make({ type: 'integer', minimum: 0, maximum: 5 }, 3, { render: i => { info = i; } });
  assert.deepEqual(info.set(4), { ok: true, errors: [] });
  assert.equal(editor.get(''), 4);
  const refused = info.set(99);
  assert.equal(refused.ok, false);
  assert.match(refused.errors[0], /at most 5/);
  assert.equal(editor.get(''), 4);
});

test('render hook: a node can be drawn by value as well as by schema', () => {
  const colours = info => {
    if (typeof info.value !== 'string' || !/^#[0-9a-f]{6}$/i.test(info.value)) return undefined;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = info.value;
    input.addEventListener('input', () => info.set(input.value));
    return input;
  };
  const { el, editor } = make({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
    { a: '#3b82f6', b: 'not a colour' }, { render: colours });
  assert.equal(node(el, '/a').querySelector('input').type, 'color');
  assert.equal(node(el, '/b').querySelector('input').type, 'text');
  const picker = node(el, '/a').querySelector('input');
  picker.value = '#ff0000';
  fire(picker, 'input');
  assert.equal(editor.get('/a'), '#ff0000');
});

test('render hook: it can draw a whole object or array, and is called again after programmatic edits', () => {
  const calls = [];
  const summary = info => {
    if (info.schema.type !== 'array') return undefined;
    calls.push(info.value);
    const p = document.createElement('p');
    p.className = 'summary';
    p.textContent = info.value.length + ' items';
    return p;
  };
  const { el, editor } = make({ type: 'object', properties: { list: { type: 'array', items: { type: 'string' } } } },
    { list: ['a', 'b'] }, { render: summary });
  assert.equal(node(el, '/list').querySelector('.summary').textContent, '2 items');
  assert.equal(node(el, '/list').querySelectorAll('.se-item').length, 0);                  // no default rows
  editor.push('/list', 'c');
  assert.equal(node(el, '/list').querySelector('.summary').textContent, '3 items');
  assert.deepEqual(calls, [['a', 'b'], ['a', 'b', 'c']]);
});

test('render hook: for alternatives, it is called for the node and then for the chosen one', () => {
  const schema = { oneOf: [{ title: 'Text', type: 'string' }, { title: 'Count', type: 'integer' }] };
  const seen = [];
  const { el } = make(schema, 7, { render: info => {
    seen.push(info.schema.oneOf ? 'union' : info.schema.type);
    if (info.schema.type === 'integer') { const b = document.createElement('b'); b.className = 'custom'; return b; }
    return undefined;
  } });
  assert.deepEqual(seen, ['union', 'integer']);
  assert.ok(el.querySelector('select.se-variant'), 'the selector for the alternatives is still there');
  assert.ok(el.querySelector('b.custom'));
});

test('render hook: set() from a custom control makes the editor update dependent fields', () => {
  let setRole;
  const { el, editor } = make(contactSchema, contactDoc, { render: info => {
    if (info.path !== '/role') return undefined;
    setRole = info.set;
    const b = document.createElement('button');
    b.className = 'role-button';
    return b;
  } });
  assert.ok(node(el, '/role').querySelector('.role-button'));
  assert.deepEqual(setRole('staff'), { ok: true, errors: [] });                           // role "staff" requires a department
  assert.equal(editor.get('/department'), 'Operations');
  assert.ok(node(el, '/department'));
  assert.ok(node(el, '/role').querySelector('.role-button'), 'the custom control is drawn again after the rebuild');
});

test('render hook: a hook that throws, or returns a non-element, falls back to the normal rendering', () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const thrown = make({ type: 'string' }, 'x', { render: () => { throw new Error('boom'); } });
    assert.ok(thrown.el.querySelector('input.se-input'));
    const wrong = make({ type: 'string' }, 'x', { render: () => 'a string, not an element' });
    assert.ok(wrong.el.querySelector('input.se-input'));
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2);
  assert.match(logged[0], /threw/);
  assert.match(logged[1], /must return an element/);
});

test('enum: every value that is not a string is marked, and strings are never changed', () => {
  const enumValues = [null, true, false, 1, 2.5, { a: 1, b: [2, 3] }, [1, 2], 'true', 'null', '1', '{"a":1}', 'x', ''];
  const { el, editor } = make({ enum: enumValues }, null);
  const options = [...el.querySelectorAll('option')];
  assert.deepEqual(options.map(o => [o.textContent, o.classList.contains('se-literal')]), [
    ['null', true], ['true', true], ['false', true], ['1', true], ['2.5', true],
    ['{"a":1,"b":[2,3]}', true], ['[1,2]', true],                 // objects and arrays too
    ['true', false], ['null', false], ['1', false], ['{"a":1}', false], ['x', false], ['', false],   // strings: as they are, no quotes
  ]);
  const select = el.querySelector('select');
  const marked = () => select.classList.contains('se-literal');
  assert.ok(marked(), 'the closed select is styled while a non-string value is selected');
  const choose = i => { select.value = String(i); fire(select, 'change'); };
  choose(11);                                                      // "x"
  assert.strictEqual(editor.get(''), 'x');
  assert.ok(!marked());
  choose(2);                                                       // false
  assert.strictEqual(editor.get(''), false);
  assert.ok(marked());
  choose(7);                                                       // the string "true": not the boolean, and not marked
  assert.strictEqual(editor.get(''), 'true');
  assert.ok(!marked());
  choose(5);                                                       // the object
  assert.deepEqual(editor.get(''), { a: 1, b: [2, 3] });
  assert.ok(marked());
  choose(6);                                                       // the array
  assert.deepEqual(editor.get(''), [1, 2]);
  assert.ok(marked());
  choose(3);                                                       // the number 1, not the string "1"
  assert.strictEqual(editor.get(''), 1);
  assert.ok(marked());
});

test('enum: a list of only strings is left completely plain', () => {
  const { el } = make({ enum: ['true', 'x'] }, 'true');
  assert.deepEqual([...el.querySelectorAll('option')].map(o => [o.textContent, o.classList.contains('se-literal')]),
    [['true', false], ['x', false]]);
  assert.ok(!el.querySelector('select').classList.contains('se-literal'));
});

test('if/then: choosing role "staff" adds the newly required department', () => {
  const { el, editor } = make(contactSchema, contactDoc);
  const select = node(el, '/role').querySelector('select');
  select.value = '2';
  fire(select, 'change');
  assert.equal(editor.get('/role'), 'staff');
  assert.equal(editor.get('/department'), 'Operations');
  assert.ok(node(el, '/department'));
});

test('oneOf alternatives can be switched in the UI', () => {
  const { el, editor } = make(contactSchema, contactDoc);
  const select = node(el, '/composition/pet').querySelector('select.se-variant');
  select.value = '1';
  fire(select, 'change');
  assert.deepEqual(editor.get('/composition/pet'), { fins: 1 });
});

test('uniqueItems arrays can still grow: the next free enum value is chosen, not a duplicate', () => {
  const { el, editor } = make(metaschema, { type: ['string', 'number'] });
  button(node(el, '/type'), '+ Add item').click();
  assert.deepEqual(editor.get('/type'), ['string', 'number', 'integer']);
});

test('arrays that can only have one length show no add/remove buttons, and no stray text', () => {
  const { el } = make(contactSchema, contactDoc);
  const location = node(el, '/arrays/location');
  assert.equal(location.querySelectorAll('button').length, 0);
  assert.ok(![...location.querySelectorAll('.se-item')].some(row => row.textContent.includes('null')));
});

test('tuple slots are pinned; additional items can move and be removed', () => {
  const { el } = make(contactSchema, contactDoc);
  const rows = [...node(el, '/arrays/legacy').querySelectorAll(':scope > .se-nbody > .se-array > .se-item')];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelectorAll('button').length, 0);
  assert.equal(rows[1].querySelectorAll('button').length, 0);
  assert.ok(button(rows[2], '✕'));
});

test('many optional properties collapse into one "Add a property" menu', () => {
  const { el, editor } = make(metaschema, { type: 'object' });
  const menu = el.querySelector('select.se-addprop');
  assert.ok(menu && menu.options.length > 10);
  const option = [...menu.options].find(o => o.textContent === 'required');
  menu.value = option.value;
  fire(menu, 'change');
  assert.deepEqual(editor.get('/required'), []);
});

test('JSON equality: true is not 1; remote $refs are reported', () => {
  const { editor } = make({ enum: [1] }, 1);
  assert.throws(() => editor.set('', true));
  assert.throws(() => make({ $ref: 'https://example.com/x.json' }, 1), /Unsupported \$ref/);
});
