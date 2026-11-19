'use strict';
// Tests that need a real browser: jsdom has no CSS engine, so it can't say what the stylesheet does.
// Run with `npm run test:browser`. They use puppeteer-core with Chrome:
//   CHROME_PATH   path to a Chrome/Chromium executable (otherwise Chrome is looked for in the usual places)
//   CHROME_ARGS   extra command-line flags, space separated
//   CHROME_HEADLESS  "shell" for a chrome-headless-shell binary (default: true)
//   REQUIRE_BROWSER  set to make a missing browser a failure instead of a skip (CI does this)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const JS = path.join(__dirname, '..', 'schmeditor.js');
const CSS = path.join(__dirname, '..', 'schmeditor.css');

let browser;
test.before(async () => {
  const headless = process.env.CHROME_HEADLESS === 'shell' ? 'shell' : true;
  const args = ['--no-sandbox', ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : [])];
  try {
    browser = await puppeteer.launch(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH, headless, args }
      : { channel: 'chrome', headless, args });
  } catch (e) {
    if (process.env.REQUIRE_BROWSER) throw e;
    console.log('# no browser available, skipping the browser tests: ' + e.message.split('\n')[0]);
  }
});
test.after(async () => { if (browser) await browser.close(); });

// ---- colour helpers (computed styles come back as rgb(), rgba() or color(srgb …))
function parseColour(text) {
  text = text.trim();
  let m = text.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255).concat(1);
  m = text.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1]; }
  m = text.match(/^color\(srgb ([^)]+)\)$/);
  if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  throw new Error('unrecognised colour: ' + text);
}
const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);   // composite fg over an opaque bg
const channel = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = c => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const SCHEMA = { title: 'Contact', type: 'object', required: ['name'], properties: {
  name: { type: 'string', minLength: 2, description: 'At least two characters.' },
  role: { enum: ['customer', 'partner'] },
} };

// Render an editor in a fresh page, with the browser set to `scheme`, and measure it.
async function measure({ scheme, attrs = '', style = '', bodyStyle = '' }) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'schmeditor-')), 'page.html');
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="file://${CSS}"><style>${style}</style></head>
    <body style="margin:0;${bodyStyle}"><div id="editor" ${attrs}></div>
    <script src="file://${JS}"></script>
    <script>new SchemaEditor(document.getElementById('editor'), ${JSON.stringify(SCHEMA)}, { name: 'A', role: 'partner' });</script></body></html>`);
  const page = await browser.newPage();
  try {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.goto('file://' + file, { waitUntil: 'load' });
    return await page.evaluate(() => {
      const root = document.querySelector('.se-root');
      const css = e => getComputedStyle(e);
      const input = root.querySelector('input.se-input');
      input.focus();
      return {
        scheme: css(root).colorScheme, bg: css(root).backgroundColor, fg: css(root).color, padding: css(root).paddingTop,
        inputFg: css(input).color, inputBorder: css(input).borderTopColor, outline: css(input).outlineColor,
        error: css(root.querySelector('.se-error')).color, muted: css(root.querySelector('.se-desc')).color,
        focusVar: css(root).getPropertyValue('--se-focus'), selectBg: css(root.querySelector('select')).backgroundColor,
      };
    });
  } finally {
    await page.close();
  }
}

// (Checked when each test runs: the browser is launched in a before() hook, after the tests are defined.)
const needBrowser = t => { if (browser) return false; t.skip('no browser available'); return true; };
const dark = m => luminance(parseColour(m.bg)) < 0.05 && luminance(parseColour(m.fg)) > 0.8;
const light = m => luminance(parseColour(m.bg)) > 0.95 && luminance(parseColour(m.fg)) < 0.05;

test('the editor follows the browser\'s light/dark setting', async t => {
  if (needBrowser(t)) return;
  const l = await measure({ scheme: 'light' });
  const d = await measure({ scheme: 'dark' });
  assert.ok(light(l), `light: bg ${l.bg}, text ${l.fg}`);
  assert.ok(dark(d), `dark: bg ${d.bg}, text ${d.fg}`);
  assert.equal(l.scheme, 'light dark');
  assert.equal(d.scheme, 'light dark');
  assert.equal(d.inputFg, d.fg);                                    // controls use the same text colour
  assert.notEqual(l.inputBorder, d.inputBorder);                    // and borders are derived from it
});

test('data-theme on the container overrides the browser setting, either way', async t => {
  if (needBrowser(t)) return;
  const forcedLight = await measure({ scheme: 'dark', attrs: 'data-theme="light"' });
  const forcedDark = await measure({ scheme: 'light', attrs: 'data-theme="dark"' });
  assert.ok(light(forcedLight), `dark browser, data-theme=light: bg ${forcedLight.bg}`);
  assert.ok(dark(forcedDark), `light browser, data-theme=dark: bg ${forcedDark.bg}`);
  assert.equal(forcedLight.scheme, 'light');
  assert.equal(forcedDark.scheme, 'dark');
});

test('custom properties let a host blend the editor into its own colours', async t => {
  if (needBrowser(t)) return;
  const m = await measure({
    scheme: 'dark',
    style: '.se-root { --se-bg: transparent; --se-fg: inherit; --se-padding: 0; }',
    bodyStyle: 'color: rgb(10, 20, 30);',
  });
  assert.equal(m.bg, 'rgba(0, 0, 0, 0)');
  assert.equal(m.fg, 'rgb(10, 20, 30)');
  assert.equal(m.padding, '0px');
});

for (const [name, opts] of [['light', { scheme: 'light' }], ['dark', { scheme: 'dark' }],
  ['forced light in a dark browser', { scheme: 'dark', attrs: 'data-theme="light"' }],
  ['forced dark in a light browser', { scheme: 'light', attrs: 'data-theme="dark"' }]]) {
  test(`text and focus colours are readable: ${name}`, async t => {
  if (needBrowser(t)) return;
    const m = await measure(opts);
    const bg = parseColour(m.bg);
    const ratio = css => contrast(over(parseColour(css), bg), bg);
    assert.ok(ratio(m.fg) >= 7, `body text ${ratio(m.fg).toFixed(1)}:1`);
    assert.ok(ratio(m.error) >= 4.5, `error text ${ratio(m.error).toFixed(1)}:1 (${m.error} on ${m.bg})`);
    assert.ok(ratio(m.muted) >= 4.5, `description text ${ratio(m.muted).toFixed(1)}:1 (${m.muted} on ${m.bg})`);
    assert.ok(ratio(m.focusVar) >= 3, `focus ring ${ratio(m.focusVar).toFixed(1)}:1 (${m.focusVar} on ${m.bg})`);
    assert.equal(parseColour(m.outline).slice(0, 3).map(x => x.toFixed(2)).join(),
      parseColour(m.focusVar).slice(0, 3).map(x => x.toFixed(2)).join());           // the ring really uses --se-focus
  });
}
