'use strict';
/**
 * ESM semantics fixtures. Each fixture is run three ways:
 *   1. natively by Node's ESM loader (ground truth),
 *   2. by the SQL linker reading the .sqlite bundle,
 *   3. by the materialized JavaScript bundle.
 * Lines starting with "> " are compared; anything else is ignored.
 */
const fixtures = {
  'live-binding': {
    'counter.js': `export let count = 0;
export function inc() { count++; }
export var label = 'a';
export function relabel() { label = 'b'; }`,
    'index.js': `import { count, inc, label, relabel } from './counter.js';
console.log('> before', count, label);
inc(); inc(); relabel();
console.log('> after', count, label);`,
  },

  'circular-hoisted': {
    'a.js': `import { fromB } from './b.js';
export function fromA() { return 'A'; }
console.log('> a evaluates, b says', fromB());`,
    'b.js': `import { fromA } from './a.js';
export function fromB() { return 'B+' + fromA(); }
console.log('> b evaluates, a says', fromA());`,
    'index.js': `import './a.js';
console.log('> done');`,
  },

  'tdz-cycle': {
    'a.js': `import { readA } from './b.js';
export const A = 'a-value';
console.log('> a done', readA());`,
    'b.js': `import { A } from './a.js';
export function readA() { return A; }
let early;
try { early = A; } catch (e) { early = e.constructor.name; }
console.log('> b sees', early);`,
    'index.js': `import './a.js';`,
  },

  reexports: {
    'lib.js': `export const one = 1;
export const two = 2;
export default 'lib-default';`,
    'mid.js': `export * from './lib.js';
export { one as uno, default as libDefault } from './lib.js';
export * as all from './lib.js';`,
    'index.js': `import * as mid from './mid.js';
import { uno, two, all, libDefault } from './mid.js';
console.log('> keys', Object.keys(mid).sort().join(','));
console.log('> values', uno, two, libDefault, all.one, all.default);
console.log('> has default', 'default' in mid);`,
  },

  // a module that only re-exports must survive tree-shaking (lodash-es/value.js)
  'reexport-only-hop': {
    'impl.js': `export default function wrapperValue() { return 'v'; }`,
    'hop.js': `export { default } from './impl.js';`,
    'barrel.js': `export { default as value } from './hop.js';
export { default as valueOf } from './impl.js';
export * from './star-hop.js';`,
    'star-hop.js': `export { default as viaStar } from './impl.js';`,
    'index.js': `import * as ns from './barrel.js';
console.log('>', Object.keys(ns).join(','), ns.value(), ns.viaStar === ns.valueOf);`,
  },

  'export-star-conflict': {
    'x.js': `export const shared = 'x'; export const onlyX = 1;`,
    'y.js': `export const shared = 'y'; export const onlyY = 2;`,
    'mid.js': `export * from './x.js';
export * from './y.js';
export const own = 'own';`,
    'index.js': `import * as m from './mid.js';
console.log('> keys', Object.keys(m).sort().join(','));`,
  },

  defaults: {
    'fn.js': `export default function () { return 'anon-fn'; }`,
    'cls.js': `export default class { name() { return 'anon-class'; } }`,
    'alias.js': `const value = 'aliased-default';
export { value as default };`,
    'expr.js': `let n = 1;
export default n;
n = 2;`,
    'named.js': `export default function named() { return 'named'; }
named.extra = true;`,
    'index.js': `import fn from './fn.js';
import Cls from './cls.js';
import alias from './alias.js';
import expr from './expr.js';
import named, * as nm from './named.js';
console.log('>', fn(), new Cls().name(), alias, expr, fn.name, Cls.name);
console.log('>', named(), named.extra, nm.default === named);`,
  },

  'eval-order': {
    'dep.js': `console.log('> dep evaluated');
export const x = 1;`,
    'dep2.js': `console.log('> dep2 evaluated');`,
    'index.js': `console.log('> entry body starts');
import { x } from './dep.js';
console.log('> x is', x);
import './dep2.js';`,
  },

  shadowing: {
    'lib.js': `export const name = 'imported';
export const obj = { k: 1 };`,
    'index.js': `import { name, obj } from './lib.js';
function inner(name) { return name; }
const short = { name, obj };
const block = (() => { const name = 'local'; return name; })();
class K { name() { return 'method'; } }
const label = { name: 'key' };
console.log('>', name, inner('param'), short.name, block, new K().name(), obj.k, label.name, ({ name }).name);
console.log('>', typeof name, \`\${name}!\`);`,
  },

  'dynamic-import': {
    'lazy.js': `export const msg = 'lazy loaded';
console.log('> lazy evaluated');`,
    'index.js': `console.log('> start');
import('./lazy.js').then((m) => console.log('>', m.msg, Object.keys(m).join(',')));
console.log('> sync end');`,
  },

  dedupe: {
    'state.js': `export const state = { hits: 0 };
console.log('> state module evaluated');`,
    'other.js': `import { state } from './state.js';
state.hits++;`,
    'sub/peer.js': `import { state } from '../state.js';
state.hits++;`,
    'index.js': `import { state } from './state.js';
import './other.js';
import './sub/peer.js';
import './sub/../state.js';
console.log('> hits', state.hits);`,
  },

  namespace: {
    'lib.js': `export const a = 1;
export function b() {}`,
    'index.js': `import * as ns from './lib.js';
console.log('> tag', Object.prototype.toString.call(ns));
let threw = false;
try { ns.a = 2; } catch (e) { threw = true; }
console.log('> immutable', threw, ns.a);
console.log('> extensible', Object.isExtensible(ns));`,
  },

  'destructured-export': {
    'lib.js': `const src = { p: 1, q: [2, 3], rest: { t: 4, u: 5 } };
export const { p, q: [r, s], rest: { ...others } } = src;`,
    'index.js': `import { p, r, s, others } from './lib.js';
console.log('>', p, r, s, JSON.stringify(others));`,
  },

  'string-names': {
    'lib.js': `const v = 'arbitrary';
export { v as "kebab-name" };`,
    'index.js': `import { "kebab-name" as k } from './lib.js';
console.log('>', k);`,
  },

  'json-and-text': {
    'data.json': `{ "app": "fixture", "nested": { "n": 3 } }`,
    'index.js': `import data from './data.json' with { type: 'json' };
console.log('>', data.app, data.nested.n);`,
  },
};

module.exports = { fixtures };
