/**
 * The benchmark apps (lodash-es, 640 modules) must print what Node prints,
 * through every engine, with tree-shaking on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build, materialize } from '../src/index.js';

const appsDir = path.join(import.meta.dirname, '..', 'bench', 'apps');
const cli = path.join(import.meta.dirname, '..', 'bin', 'rowpack.js');
const out = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-apps-'));
const node = (args) => execFileSync(process.execPath, args, { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('> ')).join('\n');

test('builds are reproducible, with or without compile workers', async () => {
  const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const entry = path.join(appsDir, 'lodash-few.js');
  await build({ entry, out: path.join(out, 'r1.sqlite') });
  await build({ entry, out: path.join(out, 'r2.sqlite') });
  await build({ entry, out: path.join(out, 'r8.sqlite'), jobs: 8 });
  assert.equal(hash(path.join(out, 'r1.sqlite')), hash(path.join(out, 'r2.sqlite')));
  assert.equal(hash(path.join(out, 'r1.sqlite')), hash(path.join(out, 'r8.sqlite')));
});

for (const app of fs.readdirSync(appsDir).filter((f) => f.endsWith('.js'))) {
  test(app, async () => {
    const expected = node([path.join(appsDir, app)]);
    const db = path.join(out, `${app}.sqlite`);
    await build({ entry: path.join(appsDir, app), out: db });
    assert.equal(node([cli, 'run', db]), expected, 'sql engine');
    for (const engine of ['static', 'dynamic']) {
      const js = path.join(out, `${app}.${engine}.js`);
      fs.writeFileSync(js, materialize(db, { engine, onFallback: (why) => assert.fail(`unexpected fallback: ${why}`) }));
      assert.equal(node([js]), expected, `${engine} engine`);
    }
  });
}
