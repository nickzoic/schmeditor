'use strict';
// tools/ci-run.sh runs a command in CI and, when it fails, leaves the end of its output in an annotation.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'ci-run.sh');
const haveBash = !spawnSync('bash', ['-c', 'true']).error;
const options = { skip: haveBash ? false : 'bash is not available' };

const run = (title, script, env = {}) =>
  spawnSync('bash', [SCRIPT, title, 'sh', '-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
const annotations = result => result.stdout.split('\n').filter(line => line.startsWith('::error'));
// What GitHub makes of an annotation line: its title and its message, with the %-escapes undone.
const decode = line => {
  const [, title, message] = line.match(/^::error title=(.*?)::(.*)$/s);
  const undo = s => s.replace(/%0A/g, '\n').replace(/%0D/g, '\r').replace(/%3A/g, ':').replace(/%2C/g, ',').replace(/%25/g, '%');
  return { title: undo(title), message: undo(message) };
};

test('a command that passes: its output goes through, its status is kept, nothing is annotated', options, () => {
  const r = run('quiet', 'echo hello; echo there >&2');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hello/);
  assert.match(r.stdout, /there/);
  assert.deepEqual(annotations(r), []);
});

test('a command that fails: its status is kept and the end of its output is an annotation', options, () => {
  const r = run('the title', 'echo first; echo to-stderr >&2; echo last; exit 3');
  assert.equal(r.status, 3);
  assert.match(r.stdout, /first/, 'the output still goes through');
  const [line, ...more] = annotations(r);
  assert.equal(more.length, 0, 'one annotation');
  const { title, message } = decode(line);
  assert.equal(title, 'the title');
  assert.match(message, /^exit status 3: /);
  assert.deepEqual(message.split('\n').slice(1), ['first', 'to-stderr', 'last']);
});

test('the annotation is one line, however many the output has, and survives awkward text', options, () => {
  const r = run('Browser: tests, 100%', 'printf "a %%25 b\\r\\n"; printf "\\033[31mred\\033[0m: 100%% sure, ok\\n"; echo "colon: here"; exit 1');
  const [line] = annotations(r);
  assert.ok(line && !line.includes('\r'), 'no raw carriage return');
  const { title, message } = decode(line);
  assert.equal(title, 'Browser: tests, 100%');
  const body = message.split('\n').slice(1);
  assert.deepEqual(body, ['a %25 b', 'red: 100% sure, ok', 'colon: here']);       // colours gone, % intact, colons and commas intact
});

test('only the last lines are kept (CI_RUN_LINES)', options, () => {
  const r = run('tail', 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "line $i"; done; exit 1', { CI_RUN_LINES: '3' });
  assert.deepEqual(decode(annotations(r)[0]).message.split('\n').slice(1), ['line 8', 'line 9', 'line 10']);
  const many = run('tail', 'seq 1 500; exit 1');
  assert.equal(decode(annotations(many)[0]).message.split('\n').slice(1).length, 80, 'the default is 80');
});

test('a long output stays inside what GitHub accepts', options, () => {
  const r = run('wide', 'for i in $(seq 1 80); do printf "%0500d\\n" $i; done; exit 1');
  const [line] = annotations(r);
  assert.ok(Buffer.byteLength(line) < 65000, `${Buffer.byteLength(line)} bytes`);
  const lastLine = decode(line).message.split('\n').at(-1);
  assert.equal(lastLine, '0'.repeat(498) + '80', 'when something has to go, it is the start, not the end');
});

test('it works for commands that print nothing, and keeps odd exit statuses', options, () => {
  const r = run('silent', 'exit 42');
  assert.equal(r.status, 42);
  assert.equal(decode(annotations(r)[0]).message, 'exit status 42: sh -c exit 42');
});
