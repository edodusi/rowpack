/**
 * The packaged compile functions, run locally: the classic handler is called
 * directly, the Web Function server is started on loopback. A remote compile
 * must give the same bundle as a local one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { build } from '../src/index.js';
import { remoteCompiler } from '../distributed/client.js';

const dist = path.join(import.meta.dirname, '..', 'distributed', 'dist');
const out = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-dist-'));
const entry = path.join(import.meta.dirname, '..', 'bench', 'apps', 'lodash-few.js');
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'distributed', 'package-functions.js')]);

test('classic handler and Web Function server compile to the same bundle as a local build', async () => {
  await build({ entry, out: path.join(out, 'local.sqlite') });

  const { handler } = await import(path.join(dist, 'event', 'index.mjs'));
  const viaHandler = remoteCompiler({ send: (modules) => handler({ modules }), batch: 25, concurrency: 8 });
  await build({ entry, out: path.join(out, 'event.sqlite'), compiler: viaHandler });
  assert.equal(hash(path.join(out, 'event.sqlite')), hash(path.join(out, 'local.sqlite')));

  const port = 30000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(dist, 'web', 'index.js')], {
    env: { ...process.env, THREADS: 'auto', AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((ok) => server.stdout.once('data', ok));
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.ok(health.threads >= 1);
    const viaHttp = remoteCompiler({
      send: async (modules) => (await fetch(`http://127.0.0.1:${port}/compile`, { method: 'POST', body: JSON.stringify({ modules }) })).json(),
      batch: 25,
      concurrency: 8,
    });
    await build({ entry, out: path.join(out, 'web.sqlite'), compiler: viaHttp });
    assert.equal(hash(path.join(out, 'web.sqlite')), hash(path.join(out, 'local.sqlite')));
    assert.ok(viaHttp.stats.requests > 0);
  } finally {
    server.kill();
  }
});
