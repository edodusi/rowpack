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

// rowpack-serve: the server, the app it builds (with three.js from source) and sql.js for the database page
const serve = path.join(out, 'serve');
await esbuild.build({
  entryPoints: [path.join(here, 'serve', 'server.js')],
  outfile: path.join(serve, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'linked',
  logLevel: 'warning',
  // the AWS SDK and friends use require(); give the ESM bundle one
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
fs.writeFileSync(path.join(serve, 'package.json'), '{ "type": "module" }\n');
const root = path.join(here, '..');
fs.cpSync(path.join(here, 'serve', 'app'), path.join(serve, 'app'), { recursive: true });
const three = path.join(root, 'node_modules', 'three');
for (const f of ['package.json', 'LICENSE', 'src']) fs.cpSync(path.join(three, f), path.join(serve, 'app', 'node_modules', 'three', f), { recursive: true });
fs.mkdirSync(path.join(serve, 'sqljs'));
for (const f of ['sql-wasm.js', 'sql-wasm.wasm']) fs.copyFileSync(path.join(root, 'node_modules', 'sql.js', 'dist', f), path.join(serve, 'sqljs', f));
console.log(`packaged functions in ${path.relative(process.cwd(), out)}`);
