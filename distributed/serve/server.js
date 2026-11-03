/**
 * rowpack-serve: a website whose JavaScript does not exist until someone asks.
 *
 * The first visitor's request (through CloudFront) lands here. The server
 * bundles the app that ships inside this package: every module's source is
 * hashed, object files already in S3 are reused, the rest are compiled by a
 * classic Lambda in parallel and stored in S3 for next time. The bundle is
 * linked here with SQL, uploaded to S3, and the page streams progress while it
 * happens. Everyone after that gets the cached page from CloudFront.
 *
 * It only ever builds the one app in ./app. Nothing in a request chooses what
 * gets compiled.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { DatabaseSync } from 'node:sqlite';
import { build, materialize, strip, sqlPage } from '../../src/index.js';
import { remoteCompiler, lambdaSend } from '../client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(HERE, 'app');
const ENTRY = path.join(APP_DIR, 'index.js');
const BUCKET = process.env.BUCKET;
const COMPILE_FUNCTION = process.env.COMPILE_FUNCTION;
const REGION = process.env.AWS_REGION || 'eu-west-1';
const COMPILER_VERSION = 'rowpack-0.1.0-object-1'; // part of every cache key
const s3 = new S3Client({ region: REGION });

// ---- the build id: a hash of every file the app could import ---------------
function hashTree(dir) {
  const h = crypto.createHash('sha256').update(COMPILER_VERSION);
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(path.relative(dir, p)).update('\0').update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
}
const BUILD_ID = hashTree(APP_DIR);
const prefix = `builds/${BUILD_ID}`;

const getText = async (Key) => {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
    return Buffer.from(await r.Body.transformToByteArray());
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
};
const put = (Key, Body, extra = {}) => s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body, ...extra }));

// ---- the compiler: S3 object cache in front of the compile Lambda -----------
function cachedCompiler(progress) {
  const remote = remoteCompiler({ send: lambdaSend({ functionName: COMPILE_FUNCTION, region: REGION, format: 'object' }), batch: 25, concurrency: 64 });
  return {
    remote,
    async run(file, id) {
      progress.found++;
      const source = fs.readFileSync(file);
      const key = `objects/${crypto.createHash('sha256').update(COMPILER_VERSION).update(id).update('\0').update(source).digest('hex')}.o.gz`;
      const cached = await getText(key);
      if (cached) {
        progress.cached++;
        progress.done++;
        return { object: zlib.gunzipSync(cached) };
      }
      const r = await remote.run(file, id);
      await put(key, zlib.gzipSync(r.object), { ContentType: 'application/gzip' });
      progress.compiled++;
      progress.done++;
      return r;
    },
    close() {},
  };
}

// ---- one build per build id, across every environment ---------------------
let building = null;

async function buildOnce(progress) {
  const t0 = performance.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowpack-serve-'));
  const db = path.join(dir, 'app.sqlite');
  const compiler = cachedCompiler(progress);
  const { stats } = await build({ entry: ENTRY, out: db, compiler });
  progress.phase = 'linking';
  const js = materialize(db);
  const sizes = new DatabaseSync(db, { readOnly: true });
  const modules = sizes.prepare("SELECT path, bytes FROM module_sizes WHERE format = 'esm'").all().map((m) => ({ path: m.path, bytes: m.bytes }));
  sizes.close();
  strip(db);
  const manifest = {
    buildId: BUILD_ID,
    builtAt: new Date().toISOString(),
    buildMs: Math.round(performance.now() - t0),
    modules,
    shaking: { before: stats.before.modules, after: stats.after.modules },
    compile: { cached: progress.cached, compiled: progress.compiled, lambdaRequests: compiler.remote.stats.requests },
  };
  progress.phase = 'uploading';
  const immutable = 'public, max-age=31536000, immutable';
  await Promise.all([
    put(`${prefix}/app.js`, js, { ContentType: 'text/javascript', CacheControl: immutable }),
    put(`${prefix}/app.sqlite`, fs.readFileSync(db), { ContentType: 'application/vnd.sqlite3', CacheControl: immutable }),
    put(`${prefix}/db.html`, sqlPage(db, 'rowpack: this page is a database', { inspector: true, sqlJsDir: path.join(HERE, 'sqljs') }), { ContentType: 'text/html', CacheControl: immutable }),
  ]);
  await put(`${prefix}/manifest.json`, JSON.stringify(manifest), { ContentType: 'application/json', CacheControl: immutable });
  fs.rmSync(dir, { recursive: true, force: true });
  return manifest;
}

/** Try to become the builder: S3 conditional write on a lock object. */
async function acquireLock() {
  const Key = `locks/${BUILD_ID}`;
  try {
    await put(Key, String(Date.now()), { IfNoneMatch: '*' });
    return true;
  } catch (err) {
    if (err.$metadata?.httpStatusCode !== 412 && err.$metadata?.httpStatusCode !== 409) throw err;
    // a lock older than two minutes belongs to a build that died: take it over, once
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    if (Date.now() - head.LastModified.getTime() < 120_000) return false;
    try {
      await put(Key, String(Date.now()), { IfMatch: head.ETag });
      return true;
    } catch {
      return false;
    }
  }
}

// Read from S3 on every page request (CloudFront absorbs the traffic), so
// emptying the bucket with serve-reset.sh makes the next visit a first visit.
async function readManifest() {
  const m = await getText(`${prefix}/manifest.json`);
  return m ? JSON.parse(m.toString('utf8')) : null;
}

// ---- pages -----------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>rowpack-serve</title>
<style>
html,body{margin:0;height:100%;background:#0d1117;color:#c9d1d9;font:14px/1.5 ui-monospace,Menlo,monospace}
#status{position:fixed;left:16px;bottom:16px;max-width:min(560px,90vw);background:rgba(1,4,9,.85);border:1px solid #30363d;border-radius:8px;padding:12px 14px;z-index:2}
#status a{color:#58a6ff}#status b{color:#f0f6fc}
progress{width:100%;height:8px;accent-color:#3fb950}
</style></head><body><div id="root"></div>`;

function finalHtml(m, { cold }) {
  const facts = `${m.modules.length} modules (of ${m.shaking.before} before tree-shaking), ` +
    `${m.compile.compiled} compiled on Lambda in ${m.compile.lambdaRequests} requests, ${m.compile.cached} reused from S3, built in ${m.buildMs} ms`;
  return `<script>window.__ROWPACK_BUILD__=${JSON.stringify({ modules: m.modules }).replace(/</g, '\\u003c')};
document.getElementById('status').innerHTML=${JSON.stringify(`<b>${cold ? 'You just built this page.' : 'Built on first visit.'}</b><br>${esc(facts)}.<br><a href="/${prefix}/db.html">Open the bundle as a database</a>`)};</script>
<script src="/${prefix}/app.js"></script>`;
}

async function servePage(res) {
  const ready = await readManifest();
  if (ready) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' });
    res.end(`${head}<div id="status"></div>${finalHtml(ready, { cold: false })}</body></html>`);
    return;
  }

  // nothing built yet: stream the build as it happens, and do not cache this response
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.write(`${head}<div id="status"><b>No JavaScript exists for this page yet.</b><br><span id="msg">Starting a build…</span><br><progress id="bar" max="1" value="0"></progress></div>
<script>function p(t,d,f){document.getElementById('msg').textContent=t;var b=document.getElementById('bar');b.max=Math.max(f,1);b.value=d}</script>\n`);
  const progress = { found: 0, done: 0, cached: 0, compiled: 0, phase: 'compiling' };
  const tick = setInterval(() => {
    const text = progress.phase === 'compiling'
      ? `compiling: ${progress.done} of ${progress.found} modules found so far (${progress.compiled} on Lambda, ${progress.cached} from the S3 cache)`
      : progress.phase === 'waiting' ? 'another visitor started this build, waiting for it…' : `${progress.phase}…`;
    res.write(`<script>p(${JSON.stringify(text)},${progress.done},${progress.found})</script>\n`);
  }, 150);

  try {
    let manifest;
    if (!building && (await acquireLock())) {
      building = buildOnce(progress).finally(() => { building = null; });
      manifest = await building;
    } else {
      progress.phase = 'waiting';
      const until = Date.now() + 90_000;
      while (!(manifest = await readManifest()) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
      if (!manifest) throw new Error('the build did not finish in time; reload to try again');
    }
    clearInterval(tick);
    res.end(`${finalHtml(manifest, { cold: true })}</body></html>`);
  } catch (err) {
    clearInterval(tick);
    console.error(err);
    res.end(`<script>p(${JSON.stringify(`build failed: ${err.message}`)},0,1)</script></body></html>`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET') return res.writeHead(405).end();
  if (url.pathname === '/favicon.ico') return res.writeHead(204, { 'cache-control': 'public, max-age=86400' }).end();
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ buildId: BUILD_ID }));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    servePage(res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    return;
  }
  res.writeHead(404, { 'cache-control': 'public, max-age=60' }).end('not found');
});

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3000').split(':');
server.listen(Number(port), host, () => console.log(`rowpack-serve ${BUILD_ID} on ${host}:${port}`));
