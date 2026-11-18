// Helper for compare_patches.py. For each {a, b, py} case: work out the JSON Patch from a to b
// with the JavaScript implementation, and check that the JavaScript applyPatch turns a into b
// using the patch the Python implementation produced. Needs jsdom (npm install in ../javascript).
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
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const normalise = v => (Array.isArray(v) ? v.map(normalise)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalise(v[k])])) : v);
const results = JSON.parse(fs.readFileSync(corpusFile, 'utf8')).map(({ a, b, py }) => {
  let appliesPython = false;
  try { appliesPython = same(normalise(SchemaEditor.applyPatch(a, py)), normalise(b)); } catch (e) { /* stays false */ }
  return { js: SchemaEditor._diffPatch(a, b), appliesPython };
});
fs.writeFileSync(outFile, JSON.stringify(results));
