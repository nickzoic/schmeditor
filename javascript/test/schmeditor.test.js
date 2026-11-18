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
