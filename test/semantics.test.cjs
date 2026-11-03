'use strict';
/**
 * Strict ESM semantics: every fixture must print exactly what Node's own
 * ESM loader prints, through both execution engines.
 *
 * ROWPACK_CLI can point at another CLI (used to grade the original prototype).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixtures } = require('./fixtures.cjs');

const CLI = process.env.ROWPACK_CLI || path.join(__dirname, '..', 'bin', 'rowpack.js');
const root = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-sem-'));

function sh(file, args, cwd) {
  try {
    return { ok: true, out: execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}\n${err.stderr || err.message}` };
  }
}

const marked = (out) => out.split('\n').filter((l) => l.startsWith('> ')).join('\n');

for (const [name, files] of Object.entries(fixtures)) {
  const dir = path.join(root, name);
  const src = path.join(dir, 'src');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  }
  fs.writeFileSync(path.join(src, 'package.json'), '{"type":"module"}');

  test(name, async (t) => {
    const native = sh(process.execPath, ['index.js'], src);
    assert.ok(native.ok, `fixture must run natively: ${native.out}`);
    const expected = marked(native.out);
    assert.notEqual(expected, '', 'fixture prints nothing to compare');

    const out = path.join(dir, 'out');
    const build = sh(process.execPath, [CLI, 'build', path.join(src, 'index.js'), '-o', path.join(out, 'b.sqlite'),
      '--html', path.join(out, 'b.html'), '--js', path.join(out, 'b.js')], dir);

    await t.test('build', () => assert.ok(build.ok, build.out));
    await t.test('sql linker', () => {
      const r = sh(process.execPath, [CLI, 'run', path.join(out, 'b.sqlite')], dir);
      assert.equal(marked(r.out), expected, r.ok ? 'output differs' : r.out);
    });
    await t.test('materialized js', () => {
      const r = sh(process.execPath, [path.join(out, 'b.js')], dir);
      assert.equal(marked(r.out), expected, r.ok ? 'output differs' : r.out);
    });
  });
}
