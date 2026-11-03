#!/usr/bin/env node
/**
 * rowpack vs esbuild (and optionally the original prototype), on the same
 * machine, same inputs, same loaders. Writes bench/results/<date>-<host>.{json,md}.
 *
 *   node bench/run.js [--quick] [--prototype ~/code/bundler-sqlite]
 *
 * Every number is a median. Build times are in-process and warm unless the
 * row says "cold CLI".
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { build, materialize, runSql, sqlPage, fastPage, strip } from '../src/index.js';
import { esbuildBundle, esbuildPage } from './pages.js';
import { launch, load, chromePath } from './browser.js';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const prototype = args.includes('--prototype') ? args[args.indexOf('--prototype') + 1] : null;
const N = { build: quick ? 3 : 9, cold: quick ? 2 : 5, browser: quick ? 5 : 15, throttled: quick ? 3 : 10, node: quick ? 5 : 30 };

const root = path.join(import.meta.dirname, '..');
const work = fs.mkdtempSync(path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'rowpack-bench-'));
const require = createRequire(import.meta.url);
const esbuildBin = path.join(path.dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild');

const apps = [
  ['todomvc', path.join(root, 'demos/todomvc/app/src/index.js')],
  ['lodash-few', path.join(root, 'bench/apps/lodash-few.js')],
  ['lodash-all', path.join(root, 'bench/apps/lodash-all.js')],
].filter(([, f]) => fs.existsSync(f));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const time = (fn) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};
const timeAsync = async (fn) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};
const sizes = (buf) => ({
  raw: buf.length,
  gzip: zlib.gzipSync(buf, { level: 9 }).length,
  brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
});
const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};
const step = (msg) => process.stderr.write(`${msg}\n`);

const results = {
  date: new Date().toISOString(),
  machine: { cpu: os.cpus()[0].model, cores: os.cpus().length, os: `${os.type()} ${os.release()}`, node: process.version },
  versions: { esbuild: esbuild.version, chrome: null },
  apps: {},
};

for (const [name, entry] of apps) {
  step(`== ${name}`);
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  const p = (f) => path.join(dir, f);
  const r = (results.apps[name] = { build: {}, size: {}, browser: {}, node: {} });

  // ---- build time ----------------------------------------------------------
  step('  build');
  const rp = [];
  const rpStatic = [];
  const eb = [];
  for (let i = 0; i < N.build + 2; i++) {
    const t1 = await timeAsync(() => build({ entry, out: p('app.sqlite') }));
    const t2 = time(() => materialize(p('app.sqlite')));
    const t3 = await timeAsync(() => esbuildBundle(entry));
    if (i >= 2) {
      rp.push(t1);
      rpStatic.push(t1 + t2);
      eb.push(t3);
    }
  }
  const stats = (await build({ entry, out: p('app.sqlite') })).stats;
  const jobsRuns = [];
  for (let i = 0; i < N.build + 2; i++) {
    const t = await timeAsync(() => build({ entry, out: p('jobs.sqlite'), jobs: Math.min(8, os.availableParallelism()) }));
    if (i >= 2) jobsRuns.push(t);
  }
  r.build = {
    rowpack_sqlite_ms: median(rp),
    rowpack_sqlite_plus_js_ms: median(rpStatic),
    esbuild_ms: median(eb),
    rowpack_jobs8_sqlite_ms: median(jobsRuns),
    rowpack_phases_ms: stats.ms,
    modules: stats.after.modules,
    modules_before_shaking: stats.before.modules,
    statements: stats.after.statements,
    statements_before_shaking: stats.before.statements,
  };

  const cold = (cmd, argv) => median(Array.from({ length: N.cold }, () => time(() => execFileSync(cmd, argv, { stdio: 'ignore' }))));
  r.build.cold_cli_rowpack_ms = cold(process.execPath, [path.join(root, 'bin/rowpack.js'), 'build', entry, '-o', p('cold.sqlite'), '--js', p('cold.js')]);
  r.build.cold_cli_esbuild_ms = cold(esbuildBin, [entry, '--bundle', `--outdir=${p('cold-esb')}`, '--loader:.svg=text', '--loader:.wav=dataurl', '--log-level=error']);

  if (prototype) {
    const res = spawnSync(process.execPath, [path.join(prototype, 'bin/sqlbundle.js'), 'build', entry, '-o', p('proto.sqlite'), '--html', p('proto.html'), '--js', p('proto.js')], { encoding: 'utf8' });
    const ms = /built SQLBundle in ([\d.]+)ms/.exec(res.stdout || '');
    r.build.prototype_ms = ms ? Number(ms[1]) : null;
    r.build.prototype_error = ms ? null : (res.stderr || res.stdout).trim().split('\n').slice(-1)[0];
    if (ms) {
      r.size.prototype_sqlite = fs.statSync(p('proto.sqlite')).size;
      r.size.prototype_js = sizes(fs.readFileSync(p('proto.js')));
    }
  }

  // ---- sizes ---------------------------------------------------------------
  step('  size');
  const staticJs = materialize(p('app.sqlite'));
  const dynamicJs = materialize(p('app.sqlite'), { engine: 'dynamic' });
  const ebOut = await esbuildBundle(entry);
  const ebMin = await esbuildBundle(entry, { minify: true });
  const minify = async (code) => (await esbuild.transform(code, { minify: true })).code;
  r.size = {
    ...r.size,
    sqlite: fs.statSync(p('app.sqlite')).size,
    sqlite_stripped: (fs.copyFileSync(p('app.sqlite'), p('stripped.sqlite')), strip(p('stripped.sqlite')), fs.statSync(p('stripped.sqlite')).size),
    rowpack_static: sizes(Buffer.from(staticJs)),
    rowpack_static_minified: sizes(Buffer.from(await minify(staticJs))),
    rowpack_dynamic: sizes(Buffer.from(dynamicJs)),
    rowpack_dynamic_minified: sizes(Buffer.from(await minify(dynamicJs))),
    esbuild: sizes(Buffer.from(ebOut.js + ebOut.css)),
    esbuild_minified: sizes(Buffer.from(ebMin.js + ebMin.css)),
  };

  // ---- Node: link and run --------------------------------------------------
  if (name !== 'todomvc') {
    step('  node');
    const sqlRuns = [];
    let queries = 0;
    const fns = { static: staticJs, dynamic: dynamicJs, esbuild: ebOut.js };
    const runs = { static: [], dynamic: [], esbuild: [] };
    for (let i = 0; i < N.node + 3; i++) {
      const t = time(() => quiet(() => {
        const x = runSql(p('stripped.sqlite'));
        queries = x.queries;
        x.close();
      }));
      if (i >= 3) sqlRuns.push(t);
      for (const [k, code] of Object.entries(fns)) {
        const t2 = time(() => quiet(() => new Function(code)()));
        if (i >= 3) runs[k].push(t2);
      }
    }
    r.node = {
      sql_engine_ms: median(sqlRuns),
      sql_queries: queries,
      static_ms: median(runs.static),
      dynamic_ms: median(runs.dynamic),
      esbuild_ms: median(runs.esbuild),
    };
  }

  // ---- browser startup -----------------------------------------------------
  if (chromePath()) {
    step('  browser');
    const pages = {
      esbuild: esbuildPage(ebOut),
      static: fastPage(staticJs),
      dynamic: fastPage(dynamicJs),
      sql: sqlPage(p('stripped.sqlite')),
    };
    const browser = await launch();
    results.versions.chrome = browser.version();
    for (const [engine, html] of Object.entries(pages)) {
      const file = p(`${engine}.html`);
      fs.writeFileSync(file, html);
      r.size[`page_${engine}`] = sizes(Buffer.from(html));
      for (const [label, slowdown, n] of [['', 1, N.browser], ['_cpu4x', 4, N.throttled]]) {
        const total = [];
        const sqlReady = [];
        const linkRun = [];
        const load_ = [];
        const ready = [];
        const qms = [];
        const cms = [];
        for (let i = 0; i < n + 1; i++) {
          const res = await load(browser, file, { cpuSlowdown: slowdown });
          if (res.errors.length || res.error) throw new Error(`${name}/${engine}: ${res.errors.concat(res.error || []).join('; ')}`);
          if (i > 0) {
            total.push(res.rowpack.totalMs);
            load_.push(res.nav.loadEventEnd);
            ready.push(res.rowpack.readyAt);
            if (engine === 'sql') {
              sqlReady.push(res.rowpack.sqliteReadyMs);
              linkRun.push(res.rowpack.linkAndRunMs);
              qms.push(res.rowpack.queryMs);
              cms.push(res.rowpack.compileMs);
            }
          }
          await res.context.close();
        }
        r.browser[`${engine}${label}`] = {
          ready_at_ms: median(ready),
          script_ms: median(total),
          load_event_ms: median(load_),
          ...(engine === 'sql' ? { sqlite_ready_ms: median(sqlReady), link_and_run_ms: median(linkRun), query_ms: median(qms), compile_ms: median(cms) } : {}),
        };
      }
    }
    await browser.close();
  }
}

// ---- report ----------------------------------------------------------------
const outDir = path.join(root, 'bench', 'results');
fs.mkdirSync(outDir, { recursive: true });
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : `${os.platform()}-${os.arch()}`;
results.machine.label = label;
const stem = `${results.date.slice(0, 10)}-${label}`;
fs.writeFileSync(path.join(outDir, `${stem}.json`), JSON.stringify(results, null, 2));

const kb = (n) => (n / 1024).toFixed(1);
const ms = (n) => (n == null ? 'n/a' : n.toFixed(1));
const lines = [
  `# Benchmark ${results.date.slice(0, 10)}`,
  '',
  `${results.machine.cpu} (${results.machine.cores} cores), ${results.machine.os}, Node ${results.machine.node}, esbuild ${results.versions.esbuild}, Chrome ${results.versions.chrome ?? 'n/a'}. Medians.`,
  '',
];
for (const [name, r] of Object.entries(results.apps)) {
  lines.push(`## ${name}`, '', `Modules after tree-shaking: ${r.build.modules} of ${r.build.modules_before_shaking}; statements: ${r.build.statements} of ${r.build.statements_before_shaking}.`, '');
  lines.push('| Build | ms |', '|---|---:|');
  lines.push(`| rowpack, .sqlite only (warm) | ${ms(r.build.rowpack_sqlite_ms)} |`);
  lines.push(`| rowpack, .sqlite only, 8 compile workers (warm) | ${ms(r.build.rowpack_jobs8_sqlite_ms)} |`);
  lines.push(`| rowpack, .sqlite + static JS (warm) | ${ms(r.build.rowpack_sqlite_plus_js_ms)} |`);
  lines.push(`| esbuild (warm, in-process) | ${ms(r.build.esbuild_ms)} |`);
  lines.push(`| rowpack, cold CLI | ${ms(r.build.cold_cli_rowpack_ms)} |`);
  lines.push(`| esbuild, cold CLI | ${ms(r.build.cold_cli_esbuild_ms)} |`);
  if (prototype) lines.push(`| prototype (its own timer) | ${r.build.prototype_ms != null ? ms(r.build.prototype_ms) : `failed: ${r.build.prototype_error}`} |`);
  lines.push('', '| Output | raw KB | gzip KB | brotli KB |', '|---|---:|---:|---:|');
  for (const k of ['esbuild', 'rowpack_static', 'rowpack_dynamic', 'esbuild_minified', 'rowpack_static_minified', 'rowpack_dynamic_minified', 'prototype_js', 'page_esbuild', 'page_static', 'page_sql']) {
    const s = r.size[k];
    if (s) lines.push(`| ${k} | ${kb(s.raw)} | ${kb(s.gzip)} | ${kb(s.brotli)} |`);
  }
  lines.push(`| .sqlite bundle | ${kb(r.size.sqlite)} | | |`);
  lines.push(`| .sqlite bundle, stripped | ${kb(r.size.sqlite_stripped)} | | |`);
  if (r.size.prototype_sqlite) lines.push(`| prototype .sqlite | ${kb(r.size.prototype_sqlite)} | | |`);
  if (Object.keys(r.node).length) {
    lines.push('', '| Node, load + link + run | ms |', '|---|---:|');
    lines.push(`| esbuild bundle | ${ms(r.node.esbuild_ms)} |`, `| rowpack static | ${ms(r.node.static_ms)} |`, `| rowpack dynamic runtime | ${ms(r.node.dynamic_ms)} |`, `| rowpack SQL engine (${r.node.sql_queries} queries) | ${ms(r.node.sql_engine_ms)} |`);
  }
  if (Object.keys(r.browser).length) {
    lines.push('', 'Chrome, app ready (ms after navigation start; single-file pages opened from disk):', '', '| Page | ready | ready, 4x CPU slowdown |', '|---|---:|---:|');
    for (const e of ['esbuild', 'static', 'dynamic', 'sql']) {
      lines.push(`| ${e} | ${ms(r.browser[e].ready_at_ms)} | ${ms(r.browser[`${e}_cpu4x`].ready_at_ms)} |`);
    }
    const s = r.browser.sql;
    const t = r.browser.sql_cpu4x;
    lines.push('', `SQL page split: SQLite (decode + compile wasm, open db) ${ms(s.sqlite_ready_ms)} ms; one closure query ${ms(s.query_ms)} ms; compile ${ms(s.compile_ms)} ms; link and run total ${ms(s.link_and_run_ms)} ms. With 4x CPU: ${ms(t.sqlite_ready_ms)} / ${ms(t.query_ms)} / ${ms(t.compile_ms)} / ${ms(t.link_and_run_ms)}.`);
  }
  lines.push('');
}
fs.writeFileSync(path.join(outDir, `${stem}.md`), lines.join('\n'));
console.log(lines.join('\n'));
