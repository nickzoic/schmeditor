// Helper for compare_validators.py: validates every (schema, doc) case in a corpus file with the
// JavaScript engine and writes the sorted errors to another file. Needs jsdom (npm install in
// ../javascript). The engine is used directly, without rendering any DOM.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require(path.join(__dirname, '..', 'javascript', 'node_modules', 'jsdom'));

const dom = new JSDOM('<!doctype html><body></body>');
global.window = dom.window;
global.document = dom.window.document;
global.CustomEvent = dom.window.CustomEvent;
const SchemaEditor = require('../javascript/schmeditor.js');

const [corpusFile, outFile] = process.argv.slice(2);
const key = e => JSON.stringify(e);
const results = JSON.parse(fs.readFileSync(corpusFile, 'utf8')).map(({ schema, doc }) => {
  const engine = Object.create(SchemaEditor.prototype);
  Object.assign(engine, { schema, opts: { validateFormats: true }, _reCache: new Map(), _anchorMap: null });
  return engine._validateAll(doc).map(e => [e.path, e.keyword, e.message]).sort((a, b) => (key(a) < key(b) ? -1 : 1));
});
fs.writeFileSync(outFile, JSON.stringify(results));
