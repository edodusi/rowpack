/**
 * Tree-shaking: what is removed, what must stay, and that removing it never
 * changes what the program prints.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { build, materialize } from '../src/index.js';

const root = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-shake-'));

const files = {
  'math.js': `export function add(a, b) { return a + b; }
export function unusedMul(a, b) { return a * b; }
export const PI = 3.14159;
export const UNUSED_TABLE = { a: 1, b: [2, 3] };
function helper() { return 'helper'; }
export function usesHelper() { return helper(); }`,
  'effects.js': `globalThis.__effects = (globalThis.__effects || 0) + 1;
export const neverRead = 1;`,
  'pure-only.js': `export const nothing = () => 0;`,
  'ns.js': `export const keepA = 'a';
export const dropB = 'b';`,
  'ns-all.js': `export const all1 = 1;
export const all2 = 2;`,
  'chain-a.js': `export { deep as shallow } from './chain-b.js';`,
  'chain-b.js': `export const deep = 'deep';
export const deepUnused = 'nope';`,
  'risky.js': `export const fromGlobal = someGlobalThatMayThrow;
export class WithStatic { static { globalThis.__static = true; } }
export var dup = 1;
var dup = 2;`,
  'index.js': `import { add, PI, usesHelper } from './math.js';
import './effects.js';
import './pure-only.js';
import * as ns from './ns.js';
import * as nsAll from './ns-all.js';
import { shallow } from './chain-a.js';
globalThis.someGlobalThatMayThrow = 'set';
const show = (o) => Object.keys(o).sort().join(',');
console.log('>', add(1, 2), PI, usesHelper(), ns.keepA, show(nsAll), shallow, globalThis.__effects);`,
};

const src = path.join(root, 'src');
fs.mkdirSync(src, { recursive: true });
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(src, name), body);
fs.writeFileSync(path.join(src, 'package.json'), '{"type":"module"}');

const marked = (out) => out.split('\n').filter((l) => l.startsWith('> ')).join('\n');
const runJs = (js) => marked(execFileSync(process.execPath, ['-e', js], { encoding: 'utf8' }));

test('tree-shaking removes dead code and keeps behaviour', () => {
  // risky.js is not imported by index.js, so build it as a second entry below
  const shaken = path.join(root, 'shaken.sqlite');
  const full = path.join(root, 'full.sqlite');
  const r = build({ entry: path.join(src, 'index.js'), out: shaken });
  build({ entry: path.join(src, 'index.js'), out: full, treeShake: false });

  const expected = marked(execFileSync(process.execPath, ['index.js'], { cwd: src, encoding: 'utf8' }));
  assert.equal(runJs(materialize(shaken)), expected);
  assert.equal(runJs(materialize(full)), expected);

  const db = new DatabaseSync(shaken, { readOnly: true });
  const bindings = new Set(db.prepare("SELECT m.path || ':' || b.name AS k FROM bindings b JOIN modules m ON m.id = b.module_id").all().map((x) => x.k));
  const modules = new Set(db.prepare('SELECT path FROM modules').all().map((x) => x.path));
  db.close();

  for (const kept of ['./math.js:add', './math.js:PI', './math.js:usesHelper', './math.js:helper', './ns.js:keepA', './ns-all.js:all1', './ns-all.js:all2', './chain-b.js:deep']) {
    assert.ok(bindings.has(kept), `${kept} must stay`);
  }
  for (const dropped of ['./math.js:unusedMul', './math.js:UNUSED_TABLE', './ns.js:dropB', './chain-b.js:deepUnused', './effects.js:neverRead']) {
    assert.ok(!bindings.has(dropped), `${dropped} must be removed`);
  }
  assert.ok(modules.has('./effects.js'), 'a module with side effects stays');
  assert.ok(!modules.has('./pure-only.js'), 'a pure module nobody reads is removed');
  assert.ok(r.stats.after.statements < r.stats.before.statements);
});

test('side effects are never removed', () => {
  const out = path.join(root, 'risky.sqlite');
  build({ entry: path.join(src, 'risky.js'), out });
  const db = new DatabaseSync(out, { readOnly: true });
  const code = db.prepare("SELECT group_concat(code, '\n') c FROM statements").get().c;
  db.close();
  assert.match(code, /someGlobalThatMayThrow/, 'reading an unknown global can throw, so it stays');
  assert.match(code, /static \{/, 'a static block runs code, so it stays');
  assert.match(code, /var dup = 2/, 'a redeclaration changes the value, so it stays');
});

test('shaking an already shaken bundle changes nothing', () => {
  const out = path.join(root, 'twice.sqlite');
  const r = build({ entry: path.join(src, 'index.js'), out });
  const { stderr: report } = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'rowpack.js'), 'shake', out], { encoding: 'utf8' });
  const db = new DatabaseSync(out, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) n FROM statements').get().n, r.stats.after.statements);
  db.close();
  const n = r.stats.after.statements;
  assert.match(report, new RegExp(`statements ${n} -> ${n}`));
});
