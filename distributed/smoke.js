#!/usr/bin/env node
// One small remote build per backend, plus proof that unsigned requests are refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../src/index.js';
import { remoteCompiler, lambdaSend, webSend } from './client.js';

const region = process.env.AWS_REGION || 'eu-west-1';
const o = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'outputs.json'), 'utf8')).RowpackDistributed;
const entry = path.join(import.meta.dirname, '..', 'demos', 'hello', 'index.js');
const out = path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-smoke.sqlite');

for (const [name, send] of [
  ['lambda', lambdaSend({ functionName: o.CompileFunction, region })],
  ['web-1thread', webSend({ domain: o.Domain1thread, region })],
  ['web-pool', webSend({ domain: o.Domainpool, region })],
]) {
  const compiler = remoteCompiler({ send, batch: 25, concurrency: 4 });
  const t = performance.now();
  await build({ entry, out, compiler });
  console.log(`${name}: ok in ${(performance.now() - t).toFixed(0)} ms, ${compiler.stats.requests} request(s)`);
}

for (const domain of [o.Domain1thread, o.Domainpool]) {
  const res = await fetch(`https://${domain}/health`);
  console.log(`unsigned GET ${domain.split('.')[0]}: HTTP ${res.status}`);
}
