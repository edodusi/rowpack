import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build } from './bundler.js';
import { runSql, materialize } from './engines.js';
import { sqlPage, fastPage } from './html.js';
import { redirect, replace, shake, strip } from './patch.js';

const USAGE = `rowpack: a JavaScript bundler whose output is a SQLite database

  rowpack build <entry.js> -o <bundle.sqlite> [--js <out.js>] [--html <out.html>] [--fast-html <out.html>] [--no-tree-shake] [--strip] [--jobs [N]]
  rowpack run <bundle.sqlite | bundle.js>
  rowpack emit <bundle.sqlite> -o <out.js> [--engine static|dynamic]
  rowpack shake <bundle.sqlite>
  rowpack strip <bundle.sqlite>
  rowpack patch <bundle.sqlite> --redirect <specifier>=<module> [--importer <module>]
  rowpack patch <bundle.sqlite> --replace <module> <file.js>
  rowpack query <bundle.sqlite> "<sql>"
`;

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') out.out = args[++i];
    else if (a.startsWith('--no-')) out[a.slice(5)] = false;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      out[key] = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : true;
    } else out._.push(a);
  }
  return out;
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

export async function main(argv) {
  const [command, ...rest] = argv;
  const f = flags(rest);
  const [target] = f._;

  switch (command) {
    case 'build': {
      if (!target || !f.out) throw new Error('build needs <entry.js> and -o <bundle.sqlite>');
      const jobs = f.jobs === true ? os.availableParallelism() : Number(f.jobs || 1);
      const { stats, warnings } = await build({ entry: target, out: f.out, treeShake: f['tree-shake'] !== false, jobs });
      for (const w of warnings) console.error(`warning: ${w}`);
      if (f.js || f['fast-html']) {
        const js = materialize(f.out, { engine: f.engine || 'static', onFallback: (why) => console.error(`note: dynamic runtime used: ${why}`) });
        if (f.js) fs.writeFileSync(f.js, js);
        if (f['fast-html']) fs.writeFileSync(f['fast-html'], fastPage(js, path.basename(target)));
      }
      if (f.strip) strip(f.out);
      if (f.html) fs.writeFileSync(f.html, sqlPage(f.out, path.basename(target)));
      console.error(
        `built ${f.out} (${kb(stats.bytes)}) in ${stats.ms.total.toFixed(1)} ms: ` +
        `${stats.after.modules}/${stats.before.modules} modules, ${stats.after.statements}/${stats.before.statements} statements kept`,
      );
      return;
    }
    case 'run': {
      if (target.endsWith('.js')) {
        // materialized bundles are plain scripts
        new Function(fs.readFileSync(target, 'utf8'))();
        return;
      }
      runSql(target); // left open: dynamic import() may still query after this returns
      return;
    }
    case 'emit': {
      fs.writeFileSync(f.out, materialize(target, { engine: f.engine || 'static', onFallback: (why) => console.error(`note: dynamic runtime used: ${why}`) }));
      return;
    }
    case 'strip': {
      const { before, after } = strip(target);
      console.error(`stripped ${target}: ${kb(before)} -> ${kb(after)}`);
      return;
    }
    case 'shake': {
      const { before, after } = shake(target);
      console.error(`modules ${before.m} -> ${after.m}, statements ${before.s} -> ${after.s}`);
      return;
    }
    case 'patch': {
      if (typeof f.redirect === 'string') {
        const [specifier, to] = f.redirect.split('=');
        const n = redirect(target, { specifier, to, importer: typeof f.importer === 'string' ? f.importer : null });
        console.error(`redirected ${n} import(s) of "${specifier}" to ${to}`);
      } else if (typeof f.replace === 'string') {
        replace(target, { module: f.replace, source: f._[1] });
        console.error(`replaced ${f.replace} with ${f._[1]}`);
      } else throw new Error('patch needs --redirect or --replace');
      return;
    }
    case 'query': {
      const db = new DatabaseSync(target, { readOnly: true });
      console.table(db.prepare(f._[1]).all());
      db.close();
      return;
    }
    default:
      console.log(USAGE);
  }
}
