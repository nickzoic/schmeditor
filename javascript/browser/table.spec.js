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

// Open a page with the editor in a container `width` px wide.
async function open(width, extra = {}, scheme = 'light') {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'schmeditor-')), 'page.html');
  const schema = { type: 'array', items: ROW, ...extra };
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${CSS}"></head>
    <body style="margin:0"><div id="editor" style="width:${width}px"></div><script src="file://${JS}"></script>
    <script>window.editor = new SchemaEditor(document.getElementById('editor'), ${JSON.stringify(schema)}, ${JSON.stringify(DOC)});</script></body></html>`);
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  await page.goto('file://' + file, { waitUntil: 'load' });
  return page;
}
const layout = page => page.evaluate(() => (document.querySelector('table.se-table') ? 'table' : document.querySelector('.se-item') ? 'rows' : 'none'));
const setWidth = (page, width) => page.evaluate(w => { document.getElementById('editor').style.width = w + 'px'; }, width);
const settle = ms => new Promise(r => setTimeout(r, ms));

test('with no "tabular" keyword the layout follows the real width, in both directions', async t => {
  if (needBrowser(t)) return;
  const page = await open(900);
  try {
    assert.equal(await layout(page), 'table');
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
      await settle(150);
      assert.equal(await layout(page), expected, `${width}px`);
    } finally { await page.close(); }
  }
});

test('"tabular": true and false ignore the width', async t => {
  if (needBrowser(t)) return;
  const forced = await open(320, { tabular: true });
  const never = await open(1400, { tabular: false });
  try {
    await settle(150);
    assert.equal(await layout(forced), 'table');
    assert.equal(await layout(never), 'rows');
  } finally { await forced.close(); await never.close(); }
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
