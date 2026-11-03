/**
 * Patching a built bundle: changes take effect in both engines, and a patch
 * that would break linking is rolled back without touching the file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build, materialize, redirect, replace } from '../src/index.js';

const root = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-patch-'));
const src = path.join(root, 'src');
fs.mkdirSync(src, { recursive: true });
const write = (name, body) => fs.writeFileSync(path.join(src, name), body);
write('math.js', `export function add(a, b) { return a + b; }`);
write('fake-math.js', `export function add() { return 'fake'; }`);
write('format.js', `import { add } from './math.js';
export const fmt = (a, b) => 'format:' + add(a, b);`);
write('index.js', `import { add } from './math.js';
import { fmt } from './format.js';
import './fake-math.js';
console.log('>', add(1, 2), fmt(1, 2));`);

const fresh = async (name) => {
  const out = path.join(root, `${name}.sqlite`);
  await build({ entry: path.join(src, 'index.js'), out, treeShake: false });
  return out;
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const marked = (s) => s.split('\n').filter((l) => l.startsWith('> ')).join('\n');
const viaSql = (f) => marked(execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'rowpack.js'), 'run', f], { encoding: 'utf8' }));
const viaJs = (f) => marked(execFileSync(process.execPath, ['-e', materialize(f)], { encoding: 'utf8' }));

test('baseline', async () => {
  const b = await fresh('baseline');
  assert.equal(viaSql(b), '> 3 format:3');
  assert.equal(viaJs(b), '> 3 format:3');
});

test('redirect can target one importer', async () => {
  const b = await fresh('redirect');
  assert.equal(redirect(b, { specifier: './math.js', to: './fake-math.js', importer: './format.js' }), 1);
  assert.equal(viaSql(b), '> 3 format:fake');
  assert.equal(viaJs(b), '> 3 format:fake', 'materialized output is derived from the rows, so it follows the patch');
});

test('replace swaps a module body in place', async () => {
  const b = await fresh('replace');
  const patched = path.join(root, 'patched-math.js');
  fs.writeFileSync(patched, `export function add(a, b) { return a + b + 1000; }`);
  replace(b, { module: './math.js', source: patched });
  assert.equal(viaSql(b), '> 1003 format:1003');
  assert.equal(viaJs(b), '> 1003 format:1003');
});

test('a patch that breaks linking is rolled back', async () => {
  const b = await fresh('rollback');
  const before = sha(b);
  const broken = path.join(root, 'broken-math.js');
  fs.writeFileSync(broken, `export function sum(a, b) { return a + b; }`);
  assert.throws(() => replace(b, { module: './math.js', source: broken }), /"add" is not exported by \.\/math\.js/);
  assert.throws(() => redirect(b, { specifier: './math.js', to: './nope.js' }), /no module/);
  assert.throws(() => redirect(b, { specifier: './missing.js', to: './math.js' }), /no import/);
  assert.equal(sha(b), before);
  assert.equal(viaSql(b), '> 3 format:3');
});
