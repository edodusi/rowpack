#!/usr/bin/env node
/**
 * distcc for JavaScript, measured. Builds each app locally and with every
 * remote backend at several fan-outs, and checks every remote build is
 * byte-identical to the local one.
 *
 *   AWS_PROFILE=... node distributed/bench.js [--quick]
 *
 * Needs distributed/outputs.json from `npm --prefix distributed/infra run deploy`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { build } from '../src/index.js';
import { remoteCompiler, lambdaSend, webSend } from './client.js';

const here = import.meta.dirname;
const quick = process.argv.includes('--quick');
const region = process.env.AWS_REGION || 'eu-west-1';
const outputs = JSON.parse(fs.readFileSync(path.join(here, 'outputs.json'), 'utf8')).RowpackDistributed;
const work = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-distcc-'));

const apps = ['lodash-all', 'date-fns-all', 'three-all'].map((a) => [a, path.join(here, '..', 'bench', 'apps', `${a}.js`)]);
const RUNS = quick ? 2 : 3; // the first run is reported separately: it pays for cold starts
const grid = [
  [1, 25],
  ...[8, 32, 128, 512].flatMap((c) => [[c, 1], [c, 25]]),
];
const backends = {
  'lambda': () => lambdaSend({ functionName: outputs.CompileFunction, region }),
  'web-1thread': () => webSend({ domain: outputs['Domain1thread'], region }),
  'web-pool': () => webSend({ domain: outputs.Domainpool, region }),
  // object files instead of JSON rows, at the fan-outs that matter
  'lambda+objects': () => lambdaSend({ functionName: outputs.CompileFunction, region, format: 'object' }),
  'web-pool+objects': () => webSend({ domain: outputs.Domainpool, region, format: 'object' }),
};
const gridFor = (backend) => (backend.endsWith('+objects') ? [[32, 25], [128, 1], [128, 25], [512, 1]] : grid);

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const step = (m) => process.stderr.write(`${m}\n`);

/** How many rounds of "compile, discover imports, compile again" the graph needs. */
function graphDepth(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const { depth } = db.prepare(`WITH RECURSIVE walk(id, d) AS (
      SELECT id, 1 FROM modules WHERE is_entry = 1
      UNION SELECT dep.resolved_id, w.d + 1 FROM dependencies dep JOIN walk w ON dep.importer_id = w.id WHERE w.d < 1000
    ), first AS (SELECT id, min(d) d FROM walk GROUP BY id)
    SELECT max(d) depth FROM first`).get();
  db.close();
  return depth;
}

// Rows are checkpointed, so a rerun after a network hiccup resumes instead of starting over.
const checkpoint = path.join(here, 'results', 'partial.json');
fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
const done = fs.existsSync(checkpoint) ? JSON.parse(fs.readFileSync(checkpoint, 'utf8')) : null;
const results = done ?? { date: new Date().toISOString(), region, machine: os.cpus()[0].model, apps: {} };
const save = () => fs.writeFileSync(checkpoint, JSON.stringify(results, null, 2));

for (const [name, entry] of apps) {
  step(`== ${name}`);
  const local = path.join(work, `${name}.local.sqlite`);
  const r = (results.apps[name] ??= { runs: [] });
  const has = (backend, c, b) => r.runs.some((x) => x.backend === backend && x.concurrency === c && x.batch === b);
  const times = [];
  for (let i = 0; i < RUNS + 1; i++) {
    const t = performance.now();
    await build({ entry, out: local, treeShake: false });
    if (i > 0) times.push(performance.now() - t);
  }
  const db = new DatabaseSync(local, { readOnly: true });
  r.modules = db.prepare('SELECT count(*) n FROM modules').get().n;
  r.sourceBytes = db.prepare("SELECT sum(length(CAST(code AS BLOB))) n FROM statements").get().n;
  db.close();
  r.depth = graphDepth(local);
  if (!has('local', 1, 1)) r.runs.push({ backend: 'local', concurrency: 1, batch: 1, warm_ms: median(times) });

  const t8 = [];
  for (let i = 0; !has('local-8-workers', 8, 1) && i < RUNS + 1; i++) {
    const t = performance.now();
    await build({ entry, out: path.join(work, `${name}.jobs.sqlite`), treeShake: false, jobs: 8 });
    if (i > 0) t8.push(performance.now() - t);
  }
  if (t8.length) r.runs.push({ backend: 'local-8-workers', concurrency: 8, batch: 1, warm_ms: median(t8) });
  save();
  const expected = hash(local);

  for (const [backend, makeSend] of Object.entries(backends)) {
    for (const [concurrency, batch] of gridFor(backend)) {
      const label = `${backend} c=${concurrency} b=${batch}`;
      if (has(backend, concurrency, batch)) continue;
      const runs = [];
      let first = null;
      let stats = null;
      for (let i = 0; i < RUNS + 1; i++) {
        const compiler = remoteCompiler({ send: makeSend(), batch, concurrency });
        const out = path.join(work, `${name}.${backend}.sqlite`);
        const t = performance.now();
        await build({ entry, out, treeShake: false, compiler });
        const ms = performance.now() - t;
        if (hash(out) !== expected) throw new Error(`${name} ${label}: remote build differs from the local one`);
        if (i === 0) first = ms;
        else runs.push(ms);
        stats = compiler.stats;
      }
      const row = {
        backend, concurrency, batch,
        first_ms: first,
        warm_ms: median(runs),
        requests: stats.requests,
        environments_seen: stats.environments.size,
        retries: stats.retries,
        remote_compute_ms: stats.computeMs,
        peak_in_flight: stats.peakInFlight,
      };
      r.runs.push(row);
      save();
      step(`  ${label}: first ${first.toFixed(0)} ms, warm ${row.warm_ms.toFixed(0)} ms, ${row.environments_seen} env, ${row.retries} retries`);
    }
  }
}

const dir = path.join(here, 'results');
fs.mkdirSync(dir, { recursive: true });
const stem = results.date.slice(0, 10);
fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(results, null, 2));
fs.rmSync(checkpoint);

const lines = [`# distributed rowpack, ${stem}`, '', `Client: ${results.machine}. Functions in ${region}. Every remote build was checked byte-identical to the local one.`, ''];
for (const [name, r] of Object.entries(results.apps)) {
  lines.push(`## ${name}`, '', `${r.modules} modules, import graph ${r.depth} levels deep.`, '');
  lines.push('| Backend | in flight | modules per request | first run ms | warm ms | requests | environments | 429 retries |', '|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const x of r.runs) {
    lines.push(`| ${x.backend} | ${x.concurrency} | ${x.batch} | ${x.first_ms == null ? '' : x.first_ms.toFixed(0)} | ${x.warm_ms.toFixed(0)} | ${x.requests ?? ''} | ${x.environments_seen ?? ''} | ${x.retries ?? ''} |`);
  }
  lines.push('');
}
fs.writeFileSync(path.join(dir, `${stem}.md`), lines.join('\n'));
console.log(lines.join('\n'));
