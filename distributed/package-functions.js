#!/usr/bin/env node
// Bundle both functions into self-contained folders under distributed/dist/.
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const here = import.meta.dirname;
const out = path.join(here, 'dist');
fs.rmSync(out, { recursive: true, force: true });

for (const [name, entry] of [['event', 'event.js'], ['web', 'web.js']]) {
  await esbuild.build({
    entryPoints: [path.join(here, 'functions', entry)],
    outfile: path.join(out, name, name === 'web' ? 'index.js' : 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    minify: false,
    legalComments: 'linked',
    logLevel: 'warning',
  });
  // Web Functions load index.js by default, so the folder is marked as ESM
  fs.writeFileSync(path.join(out, name, 'package.json'), '{ "type": "module" }\n');
}
console.log(`packaged functions in ${path.relative(process.cwd(), out)}`);
