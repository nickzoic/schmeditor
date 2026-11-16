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

test('the callback hears user edits, and API edits only when asked', () => {
  const calls = [];
  const { el, editor } = make(contactSchema, contactDoc, { onChange: (doc, info) => calls.push(info) });
  editor.set('/name', 'Zed');
  assert.deepEqual(calls, []);
  const input = node(el, '/username').querySelector('input');
  input.value = 'grace';
  fire(input, 'input');
  assert.deepEqual(calls, [{ path: '/username', source: 'user' }]);
  const noisy = make(contactSchema, contactDoc, { notifyOnProgrammatic: true, onChange: (d, i) => calls.push(i) });
  noisy.editor.set('/name', 'Zed');
  assert.deepEqual(calls.at(-1), { path: '/name', source: 'api' });
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
