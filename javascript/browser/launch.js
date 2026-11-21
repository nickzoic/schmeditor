'use strict';
// Starts Chrome for the browser tests. Returns null if there is none (unless REQUIRE_BROWSER is set,
// in which case that is an error). See theme.spec.js for the environment variables.
//
// Starting Chrome on a busy CI machine sometimes hangs ("Timed out ... waiting for the WS endpoint URL"),
// and that is nothing to do with what is being tested, so it is tried a few times, each with a shorter
// timeout than puppeteer's default, before giving up. The flags are the usual ones for containers and CI.
const ATTEMPTS = 3;
const FLAGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check'];

async function launchBrowser({ puppeteer, attempts = ATTEMPTS, retryDelay = 1000, timeout = 20000 } = {}) {
  puppeteer = puppeteer || require('puppeteer-core');
  const headless = process.env.CHROME_HEADLESS === 'shell' ? 'shell' : true;
  const args = [...FLAGS, ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : [])];
  const options = process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH, headless, args, timeout }
    : { channel: 'chrome', headless, args, timeout };
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await puppeteer.launch(options);
    } catch (e) {
      failure = e;
      const reason = e.message.split('\n')[0];
      if (/could not find/i.test(reason)) break;                    // there is no Chrome to try again with
      console.log(`# Chrome did not start (attempt ${attempt} of ${attempts}): ${reason}`);
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  if (process.env.REQUIRE_BROWSER) throw failure;
  console.log('# no browser available, skipping the browser tests: ' + failure.message.split('\n')[0]);
  return null;
}

module.exports = { launchBrowser };
