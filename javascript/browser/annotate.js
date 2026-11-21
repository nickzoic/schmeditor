'use strict';
// A node:test reporter for CI: it writes each failed test as a GitHub Actions "error" annotation, so
// the failure is visible on the run's page and through the API without opening the log.
//   node --test --test-reporter=spec --test-reporter-destination=stdout \
//               --test-reporter=./browser/annotate.js --test-reporter-destination=stdout browser/*.spec.js
const escapeData = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = s => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

module.exports = async function* annotate(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const error = event.data.details && event.data.details.error;
    const cause = error && (error.cause || error);
    const message = ((cause && cause.message) || String(error)).split('\n').filter(Boolean).slice(0, 8).join(' | ');
    yield `::error title=${escapeProperty(event.data.name)}::${escapeData(message)}\n`;
  }
};
