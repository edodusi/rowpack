#!/usr/bin/env node
// Sequential round trips to each backend with a tiny payload: where does a request's time go?
import fs from 'node:fs';
import path from 'node:path';
import { lambdaSend, webSend } from './client.js';

const region = process.env.AWS_REGION || 'eu-west-1';
const o = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'outputs.json'), 'utf8')).RowpackDistributed;
const modules = [{ key: 0, id: './x.js', source: 'export const x = 1;' }];
const N = Number(process.env.N || 15);

for (const [name, send] of [
  ['lambda', lambdaSend({ functionName: o.CompileFunction, region })],
  ['web-1thread', webSend({ domain: o.Domain1thread, region })],
]) {
  const t = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    await send(modules);
    t.push(performance.now() - s);
  }
  const rest = t.slice(1).sort((a, b) => a - b);
  console.log(`${name}: first ${t[0].toFixed(0)} ms, then median ${rest[rest.length >> 1].toFixed(0)} ms, min ${rest[0].toFixed(0)} ms`);
}
