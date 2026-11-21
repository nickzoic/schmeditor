'use strict';
// The code that starts Chrome for the browser tests: it has to cope with Chrome failing to start, which it
// sometimes does on a busy CI machine. (These tests use a stand-in for puppeteer, so they need no browser.)
const test = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser } = require('../browser/launch');

const fakePuppeteer = (failures, message) => {
  const calls = [];
  return {
    calls,
    launch: async options => {
      calls.push(options);
      if (calls.length <= failures) throw new Error(message);
      return { fake: 'browser' };
    },
  };
};
const quiet = fn => async () => {
  const log = console.log;
  console.log = () => {};
  const saved = process.env.REQUIRE_BROWSER;
  try { await fn(); } finally { console.log = log; if (saved === undefined) delete process.env.REQUIRE_BROWSER; else process.env.REQUIRE_BROWSER = saved; }
};
const hang = 'Timed out after 30000 ms while waiting for the WS endpoint URL to appear in stdout!';

test('a Chrome that fails to start is tried again', quiet(async () => {
  const puppeteer = fakePuppeteer(2, hang);
  const browser = await launchBrowser({ puppeteer, retryDelay: 0 });
  assert.deepEqual(browser, { fake: 'browser' });
  assert.equal(puppeteer.calls.length, 3);
}));

test('it gives up after three attempts: an error where a browser is required, otherwise a skip', quiet(async () => {
  process.env.REQUIRE_BROWSER = '1';
  const puppeteer = fakePuppeteer(99, hang);
  await assert.rejects(launchBrowser({ puppeteer, retryDelay: 0 }), /WS endpoint/);
  assert.equal(puppeteer.calls.length, 3);
  delete process.env.REQUIRE_BROWSER;
  const other = fakePuppeteer(99, hang);
  assert.equal(await launchBrowser({ puppeteer: other, retryDelay: 0 }), null);
  assert.equal(other.calls.length, 3);
}));

test('when there is no Chrome at all it does not keep trying', quiet(async () => {
  const puppeteer = fakePuppeteer(99, 'Could not find Chrome (ver. 1.2.3). This can occur if either...');
  assert.equal(await launchBrowser({ puppeteer, retryDelay: 0 }), null);
  assert.equal(puppeteer.calls.length, 1);
}));

test('each attempt has a shorter timeout than puppeteer\'s 30 seconds, and the usual CI flags', quiet(async () => {
  const puppeteer = fakePuppeteer(0);
  await launchBrowser({ puppeteer });
  const [options] = puppeteer.calls;
  assert.ok(options.timeout < 30000);
  for (const flag of ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']) assert.ok(options.args.includes(flag), flag);
}));
