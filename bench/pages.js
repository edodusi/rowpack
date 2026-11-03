/**
 * Builds the same app three ways into single-file pages:
 *   esbuild    the baseline (CSS inlined in a <style>, SVG as text, WAV as data URL,
 *              the same loaders rowpack uses)
 *   fast       rowpack's materialized JavaScript
 *   sql        rowpack's .sqlite bundle, linked in the browser by sql.js
 */
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { build, materialize, sqlPage, fastPage } from '../src/index.js';

export async function esbuildBundle(entry, { minify = false } = {}) {
  const r = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify,
    write: false,
    outdir: 'out',
    loader: { '.svg': 'text', '.wav': 'dataurl', '.png': 'dataurl' },
    logLevel: 'silent',
  });
  const pick = (ext) => r.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? '';
  return { js: pick('.js'), css: pick('.css') };
}

export function esbuildPage({ js, css }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>esbuild</title><style>${css}</style></head>
<body><div id="root"></div><div id="app"></div>
<script>
const __t0 = performance.now();
${js.replace(/<\/(script)/gi, '<\\/$1')}
window.__rowpack = { engine: 'esbuild', totalMs: performance.now() - __t0 };
</script>
</body></html>
`;
}

export async function buildPages(entry, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const p = (n) => path.join(outDir, n);
  build({ entry, out: p('app.sqlite') });
  const js = materialize(p('app.sqlite'));
  fs.writeFileSync(p('app.js'), js);
  fs.writeFileSync(p('sql.html'), sqlPage(p('app.sqlite')));
  fs.writeFileSync(p('fast.html'), fastPage(js));
  fs.writeFileSync(p('esbuild.html'), esbuildPage(await esbuildBundle(entry)));
  return { sql: p('sql.html'), fast: p('fast.html'), esbuild: p('esbuild.html') };
}
