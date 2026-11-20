'use strict';
// Starts Chrome for the browser tests. Returns null if there is none (unless REQUIRE_BROWSER is set,
// in which case that is an error). See theme.spec.js for the environment variables.
const puppeteer = require('puppeteer-core');

async function launchBrowser() {
  const headless = process.env.CHROME_HEADLESS === 'shell' ? 'shell' : true;
  const args = ['--no-sandbox', ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : [])];
  try {
    return await puppeteer.launch(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH, headless, args }
      : { channel: 'chrome', headless, args });
  } catch (e) {
    if (process.env.REQUIRE_BROWSER) throw e;
    console.log('# no browser available, skipping the browser tests: ' + e.message.split('\n')[0]);
    return null;
  }
}

module.exports = { launchBrowser };
