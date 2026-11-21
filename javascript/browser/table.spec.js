'use strict';
// Arrays of objects shown as tables, in a real browser: real layout, and a real ResizeObserver.
// Run with `npm run test:browser` (see theme.spec.js for how Chrome is found).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchBrowser } = require('./launch');

const JS = path.join(__dirname, '..', 'schmeditor.js');
const CSS = path.join(__dirname, '..', 'schmeditor.css');

let browser;
test.before(async () => { browser = await launchBrowser(); });
test.after(async () => { if (browser) await browser.close(); });
const needBrowser = t => { if (browser) return false; t.skip('no browser available'); return true; };

const ROW = {
  type: 'object', additionalProperties: false, required: ['sku', 'qty'],
  properties: { sku: { title: 'SKU', type: 'string' }, qty: { type: 'integer' }, price: { type: 'number' }, gift: { type: 'boolean' } },
};
const DOC = [{ sku: 'A-100', qty: 2, price: 9.5, gift: false }, { sku: 'B-200', qty: 1 }];

// Open a page with an editor for `schema` and `doc` in a container `width` px wide.
async function openWith(schema, doc, width, scheme = 'light') {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'schmeditor-')), 'page.html');
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${CSS}"></head>
    <body style="margin:0"><div id="editor" style="width:${width}px"></div><script src="file://${JS}"></script>
    <script>window.editor = new SchemaEditor(document.getElementById('editor'), ${JSON.stringify(schema)}, ${JSON.stringify(doc)});</script></body></html>`);
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await page.goto('file://' + file, { waitUntil: 'load' });
  return page;
}
// An array of the rows above, in a container `width` px wide.
const open = (width, extra = {}, scheme = 'light') => openWith({ type: 'array', items: ROW, ...extra }, DOC, width, scheme);

const STOCK_ROW = {
  type: 'object', additionalProperties: false, required: ['qty'],
  properties: { qty: { title: 'Qty', type: 'integer' }, reorder: { type: 'boolean' }, note: { type: 'string' } },
};
const STOCK = { warehouse: 'Melbourne', 'A-100': { qty: 12, reorder: false }, 'B-200': { qty: 0, note: 'discontinued' } };
const openStock = (width, extra = {}) =>
  openWith({ type: 'object', properties: { warehouse: { type: 'string' } }, additionalProperties: STOCK_ROW, ...extra }, STOCK, width);

const layout = page => page.evaluate(() => (document.querySelector('table.se-table') ? 'table' : document.querySelector('.se-item, .se-extra') ? 'rows' : 'none'));
const setWidth = (page, width) => page.evaluate(w => { document.getElementById('editor').style.width = w + 'px'; }, width);
const settle = ms => new Promise(r => setTimeout(r, ms));
// Wait until the layout is `expected`: the editor switches when the browser reports a new size, which
// happens a moment after the page changes, so a fixed sleep is a race on a slow machine. Then check it.
async function expectLayout(page, expected, message) {
  try {
    await page.waitForFunction(want => {
      const table = !!document.querySelector('table.se-table'), rows = !!document.querySelector('.se-item, .se-extra');
      return want === 'table' ? table : rows && !table;
    }, { timeout: 5000 }, expected);
  } catch (e) { /* the assertion below reports what the layout was */ }
  assert.equal(await layout(page), expected, message);
}

test('with no "tabular" keyword the layout follows the real width, in both directions', async t => {
  if (needBrowser(t)) return;
  const page = await open(900);
  try {
    await expectLayout(page, 'table', '900px');
    await page.focus('[data-fk="/0/sku"]');
    await setWidth(page, 320);
    await page.waitForFunction(() => !document.querySelector('table.se-table'));
    assert.equal(await layout(page), 'rows');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-fk')), '/0/sku', 'focus survives the switch');
    assert.equal(await page.evaluate(() => document.querySelector('[data-fk="/0/sku"]').value), 'A-100');
    await setWidth(page, 900);
    await page.waitForFunction(() => !!document.querySelector('table.se-table'));
    assert.equal(await layout(page), 'table');
    assert.equal(await page.evaluate(() => editor.getDocument().length), 2);
  } finally { await page.close(); }
});

test('an editor that starts narrow starts as rows, and one that starts wide as a table', async t => {
  if (needBrowser(t)) return;
  for (const [width, expected] of [[320, 'rows'], [900, 'table']]) {
    const page = await open(width);
    try {
      await expectLayout(page, expected, `${width}px`);
      await settle(200);                                           // and it stays that way once the size has been reported
      assert.equal(await layout(page), expected, `${width}px, later`);
    } finally { await page.close(); }
  }
});

test('"tabular": true and false ignore the width', async t => {
  if (needBrowser(t)) return;
  for (const [extra, width, expected] of [[{ tabular: true }, 320, 'table'], [{ tabular: false }, 1400, 'rows']]) {
    const page = await open(width, extra);                          // one page at a time: a hidden page is not told its size
    try {
      await expectLayout(page, expected, `tabular ${extra.tabular} at ${width}px`);
      await settle(200);
      assert.equal(await layout(page), expected, `tabular ${extra.tabular} at ${width}px, later`);
    } finally { await page.close(); }
  }
});

test('a table forced onto a narrow page scrolls inside itself and does not widen the editor or the page', async t => {
  if (needBrowser(t)) return;
  const page = await open(300, { tabular: true });
  try {
    await page.setViewport({ width: 600, height: 800 });
    const m = await page.evaluate(() => {
      const wrap = document.querySelector('.se-tablewrap'), root = document.querySelector('.se-root');
      return { scrolls: wrap.scrollWidth > wrap.clientWidth, wrapWidth: wrap.clientWidth,
               rootWidth: root.getBoundingClientRect().width, rootOverflow: root.scrollWidth - root.clientWidth,
               page: document.documentElement.scrollWidth, viewport: innerWidth };
    });
    assert.ok(m.scrolls, 'the wrapper scrolls sideways');
    assert.ok(m.wrapWidth <= 300, `the table's box is ${m.wrapWidth}px`);
    assert.equal(m.rootWidth, 300, 'the editor is the 300px it was given, padding included');
    assert.equal(m.rootOverflow, 0, 'nothing spills out of the editor');
    assert.ok(m.page <= m.viewport, `the page is ${m.page}px in a ${m.viewport}px window`);
  } finally { await page.close(); }
});

test('the columns line up: each cell sits under its heading', async t => {
  if (needBrowser(t)) return;
  const page = await open(900);
  try {
    await expectLayout(page, 'table', '900px');
    const m = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('thead th')].map(th => th.getBoundingClientRect().left);
      return [...document.querySelectorAll('tbody tr.se-row')].map(tr =>
        [...tr.children].map((td, i) => Math.abs(td.getBoundingClientRect().left - heads[i])));
    });
    for (const row of m) for (const offset of row) assert.ok(offset < 1.5, `a cell is ${offset}px off its heading`);
    const sizes = await page.evaluate(() => [...document.querySelectorAll('tbody tr.se-row')].map(tr => tr.getBoundingClientRect().height));
    assert.ok(sizes.every(h => h > 20 && h < 120), `row heights ${sizes}`);
  } finally { await page.close(); }
});

for (const scheme of ['light', 'dark']) {
  test(`table lines and headings are visible against the background: ${scheme}`, async t => {
    if (needBrowser(t)) return;
    const page = await open(900, {}, scheme);
    try {
      const m = await page.evaluate(() => {
        const css = e => getComputedStyle(e);
        const root = document.querySelector('.se-root'), th = document.querySelector('thead th'), td = document.querySelector('tbody td.se-cell');
        return { bg: css(root).backgroundColor, headColor: css(th).color, headLine: css(th).borderBottomColor, cellLine: css(td).borderBottomColor,
                 idx: css(document.querySelector('td.se-idx')).color };
      });
      const alpha = c => { const mm = c.match(/\/ ([\d.]+)\)|, ([\d.]+)\)$/); return mm ? parseFloat(mm[1] || mm[2]) : 1; };
      assert.ok(alpha(m.headLine) > 0.1 && alpha(m.cellLine) > 0.02, `lines: ${m.headLine} / ${m.cellLine}`);
      assert.equal(m.headColor, await page.evaluate(() => getComputedStyle(document.querySelector('.se-root')).color), 'headings use the text colour');
    } finally { await page.close(); }
  });
}

test('an object of objects follows the real width too, keeping focus on a name', async t => {
  if (needBrowser(t)) return;
  const page = await openStock(900);
  try {
    await expectLayout(page, 'table', '900px');
    await page.focus('[data-fk="#A-100"]');
    await setWidth(page, 300);
    await page.waitForFunction(() => !document.querySelector('table.se-table'));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.se-extra').length), 2);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-fk')), '#A-100');
    await setWidth(page, 900);
    await page.waitForFunction(() => !!document.querySelector('table.se-table'));
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-fk')), '#A-100');
    assert.equal(await page.evaluate(() => editor.get('/warehouse')), 'Melbourne');
  } finally { await page.close(); }
});

test('an object table: the declared property is above it, names line up under "Name"', async t => {
  if (needBrowser(t)) return;
  const page = await openStock(900, { tabular: true });
  try {
    await expectLayout(page, 'table', 'tabular: true');
    const m = await page.evaluate(() => {
      const table = document.querySelector('table.se-table'), declared = document.querySelector('[data-ptr="/warehouse"]');
      const heads = [...table.querySelectorAll('thead th')].map(th => th.getBoundingClientRect().left);
      return {
        above: declared.getBoundingClientRect().bottom <= table.getBoundingClientRect().top,
        firstHeading: table.querySelector('thead th').textContent,
        offsets: [...table.querySelectorAll('tbody tr.se-row')].flatMap(tr => [...tr.children].map((td, i) => Math.abs(td.getBoundingClientRect().left - heads[i]))),
        addBelow: table.getBoundingClientRect().bottom <= document.querySelector('.se-addrow').getBoundingClientRect().top,
      };
    });
    assert.ok(m.above, 'warehouse is above the table');
    assert.ok(m.addBelow, 'the add-property row is below it');
    assert.equal(m.firstHeading, 'Name');
    for (const offset of m.offsets) assert.ok(offset < 1.5, `a cell is ${offset}px off its heading`);
  } finally { await page.close(); }
});

// Calibration: for each kind of column the editor has to be right about when a table fits. The widest a
// table of these columns can be and still be chosen is the width it computes (its min-width); at that width
// the real table must fit without scrolling, and one pixel less must give rows.
const SAMPLE = { string: 'sample text', number: 1.5, boolean: false, enum: 'mobile', const: 'x', null: null };
const KINDS = {
  string: { type: 'string' }, number: { type: 'number' }, boolean: { type: 'boolean' },
  enum: { enum: ['mobile', 'home', 'work'] }, const: { const: 'x' }, null: { type: 'null' },
};
const calibrationCases = [];
for (const [kind, schema] of Object.entries(KINDS)) {
  for (const required of [true, false]) calibrationCases.push({ name: `${required ? 'required' : 'optional'} ${kind}`, props: { [kind]: schema }, required: required ? [kind] : [] });
}
calibrationCases.push({ name: 'one of every kind, required', props: KINDS, required: Object.keys(KINDS) });
calibrationCases.push({ name: 'one of every kind, optional', props: KINDS, required: [] });

for (const shape of ['array', 'object']) {
  for (const c of calibrationCases) {
    test(`the width a table needs is right: ${shape} of ${c.name}`, async t => {
      if (needBrowser(t)) return;
      const row = { type: 'object', additionalProperties: false, required: c.required, properties: c.props };
      const rowValue = Object.fromEntries(Object.keys(c.props).map(k => [k, SAMPLE[k]]));
      const schema = shape === 'array' ? { type: 'array', items: row } : { type: 'object', additionalProperties: row };
      const doc = shape === 'array' ? [rowValue] : { 'row-1': rowValue };
      const page = await openWith(schema, doc, 2000);
      try {
        await expectLayout(page, 'table', 'plenty of room: a table');
        const needed = await page.evaluate(() => parseInt(document.querySelector('table.se-table').style.minWidth));
        const padding = 24;                                           // the editor's own padding
        await setWidth(page, needed + padding);
        await settle(200);                                            // long enough for any resize report to arrive
        await expectLayout(page, 'table', `${needed}px: a table`);
        const fit = await page.evaluate(() => { const w = document.querySelector('.se-tablewrap'); return { scroll: w.scrollWidth, client: w.clientWidth }; });
        assert.ok(fit.scroll <= fit.client, `at the width it asks for (${needed}px) the table needs ${fit.scroll}px but has ${fit.client}px`);
        await setWidth(page, needed + padding - 1);
        await expectLayout(page, 'rows', `${needed - 1}px: rows`);
      } finally { await page.close(); }
    });
  }
}
