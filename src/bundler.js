/**
 * build(): walk the module graph, write it into SQLite as rows, then let SQL
 * link it (and tree-shake it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { transformModule } from './transform.js';
import { resolve, hasSideEffects, clearResolveCache } from './resolve.js';
import { SCHEMA, LINK, TREE_SHAKE, REFRESH_IMAGE } from './sql.js';
import { runtimeSource } from './engines.js';

const ASSET_TYPES = {
  '.json': ['json', 'application/json'],
  '.css': ['css', 'text/css'],
  '.svg': ['text', 'image/svg+xml'],
  '.txt': ['text', 'text/plain'],
  '.html': ['text', 'text/html'],
  '.md': ['text', 'text/markdown'],
  '.png': ['url', 'image/png'],
  '.jpg': ['url', 'image/jpeg'],
  '.jpeg': ['url', 'image/jpeg'],
  '.gif': ['url', 'image/gif'],
  '.webp': ['url', 'image/webp'],
  '.avif': ['url', 'image/avif'],
  '.ico': ['url', 'image/x-icon'],
  '.woff': ['url', 'font/woff'],
  '.woff2': ['url', 'font/woff2'],
  '.wav': ['url', 'audio/wav'],
  '.mp3': ['url', 'audio/mpeg'],
  '.ogg': ['url', 'audio/ogg'],
};
const TEXT_FORMATS = new Set(['json', 'css', 'text']);

/**
 * @param {object} opts
 * @param {string} opts.entry
 * @param {string} opts.out          path of the .sqlite bundle
 * @param {boolean} [opts.treeShake] default true
 * @param {number} [opts.jobs]       compile workers; 1 = in this thread (default)
 * @param {{ run(file: string, id: string): Promise<object>, close(): void }} [opts.compiler]
 *        where modules get compiled; overrides jobs (see distributed/)
 * @returns {Promise<{ out: string, stats: object, warnings: string[] }>}
 */
export async function build({ entry, out, treeShake = true, jobs = 1, compiler = null }) {
  const t0 = performance.now();
  clearResolveCache(); // caches live for one build: files may change between builds
  const entryPath = fs.realpathSync(path.resolve(entry));
  const root = path.dirname(entryPath);
  const warnings = [];

  // ---- 1. graph walk: parse every module exactly once -------------------
  const graph = await walkGraph(entryPath, root, compiler ?? (jobs > 1 ? createPool(jobs) : null));
  for (const n of graph) if (n.transformed) warnings.push(...n.transformed.warnings);
  const tParse = performance.now();

  // ---- 2. rows ----------------------------------------------------------
  // Build in memory, then VACUUM INTO the file: one compact write, no journal.
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('BEGIN'); db.exec('PRAGMA defer_foreign_keys = ON');
  const q = {
    asset: db.prepare('INSERT INTO assets (id, mime, content) VALUES (?, ?, ?)'),
    module: db.prepare('INSERT INTO modules (id, path, format, is_entry, side_effects, asset_id) VALUES (?, ?, ?, ?, ?, ?)'),
    statement: db.prepare('INSERT INTO statements (module_id, idx, code, pure) VALUES (?, ?, ?, ?)'),
    binding: db.prepare('INSERT OR IGNORE INTO bindings (module_id, name, stmt_idx) VALUES (?, ?, ?)'),
    ref: db.prepare('INSERT INTO refs (module_id, stmt_idx, kind, name, dep_idx) VALUES (?, ?, ?, ?, ?)'),
    reloc: db.prepare('INSERT INTO relocations (module_id, stmt_idx, start, end, kind, name, dep_idx, form, local) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    reserve: db.prepare('INSERT OR IGNORE INTO reserved_names (name) VALUES (?)'),
    dep: db.prepare('INSERT INTO dependencies (importer_id, idx, specifier, kind, resolved_id) VALUES (?, ?, ?, ?, ?)'),
    export: db.prepare('INSERT INTO exports (module_id, name, kind, local_name, dep_idx, imported_name) VALUES (?, ?, ?, ?, ?, ?)'),
    meta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)'),
    runtime: db.prepare('INSERT INTO runtime (name, code) VALUES (?, ?)'),
  };

  for (const n of graph) {
    if (n.asset) q.asset.run(n.id, n.asset.mime, n.asset.content);
    q.module.run(n.id, n.path, n.format, n.id === 1 ? 1 : 0, n.id === 1 || hasSideEffects(n.file) ? 1 : 0, n.asset ? n.id : null);
    if (n.asset) {
      q.export.run(n.id, 'default', 'local', 'default', null, null);
      continue;
    }
    const t = n.transformed;
    t.deps.forEach((d, idx) => q.dep.run(n.id, idx, d.specifier, d.kind, n.deps[idx]));
    t.statements.forEach((s, idx) => {
      q.statement.run(n.id, idx, s.code, s.pure ? 1 : 0);
      for (const name of s.declares) q.binding.run(n.id, name, idx);
      for (const r of s.refs) q.ref.run(n.id, idx, r.kind, r.name, r.dep ?? null);
      for (const r of s.relocations) q.reloc.run(n.id, idx, r.start, r.end, r.kind, r.name, r.dep ?? null, r.form, r.local ?? null);
    });
    for (const name of t.globals) q.reserve.run(name);
    for (const name of t.innerNames) q.reserve.run(name);
    for (const e of t.exports) q.export.run(n.id, e.name, e.kind, e.local ?? null, e.dep ?? null, e.imported ?? null);
  }

  q.meta.run('entry_id', '1');
  q.meta.run('entry', graph[0].path);
  q.meta.run('generator', 'rowpack 0.1.0');
  q.runtime.run('runtime.js', runtimeSource());
  db.exec('COMMIT');
  const tInsert = performance.now();

  // ---- 3. link and check, in SQL ---------------------------------------
  db.exec(LINK);
  assertLinked(db);
  const before = counts(db);
  if (treeShake) {
    db.exec('BEGIN'); db.exec('PRAGMA defer_foreign_keys = ON');
    db.exec(TREE_SHAKE);
    db.exec(LINK);
    db.exec('COMMIT');
    assertLinked(db);
  }
  db.exec(REFRESH_IMAGE);
  const tLink = performance.now();

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.rmSync(out, { force: true });
  db.prepare('VACUUM INTO ?').run(path.resolve(out));
  db.close();
  const tWrite = performance.now();

  return {
    out,
    warnings,
    stats: {
      before,
      after: counts(new DatabaseSync(out, { readOnly: true }), true),
      bytes: fs.statSync(out).size,
      ms: { parse: tParse - t0, insert: tInsert - tParse, linkAndShake: tLink - tInsert, write: tWrite - tLink, total: tWrite - t0 },
    },
  };
}

/**
 * Discover and transform every module. Transforms run in parallel when jobs > 1;
 * ids are assigned afterwards in breadth-first import order, so the bundle is
 * the same whatever order the workers finish in.
 */
async function walkGraph(entryPath, root, pool) {
  const nodes = new Map();
  const pending = new Set();
  const transform = (file, id) => (pool ? pool.run(file, id) : Promise.resolve().then(() => transformModule(fs.readFileSync(file, 'utf8'), id)));

  const visit = (file) => {
    if (nodes.has(file)) return;
    const node = { file, path: displayPath(file, root), format: null, transformed: null, asset: null, depFiles: [] };
    nodes.set(file, node);
    const asset = ASSET_TYPES[path.extname(file).toLowerCase()];
    if (asset) {
      const [format, mime] = asset;
      node.format = format;
      node.asset = { mime, content: TEXT_FORMATS.has(format) ? fs.readFileSync(file, 'utf8') : fs.readFileSync(file) };
      return;
    }
    const job = transform(file, node.path).then((t) => {
      node.format = t.format;
      node.transformed = t;
      for (const dep of t.deps) {
        const target = resolve(dep.specifier, file);
        if (!target) throw new Error(`${node.path}: cannot resolve "${dep.specifier}"`);
        node.depFiles.push(target);
        visit(target);
      }
    });
    pending.add(job);
    job.finally(() => pending.delete(job)).catch(() => {});
  };

  try {
    visit(entryPath);
    while (pending.size) await Promise.all(pending);
  } finally {
    pool?.close();
  }

  const graph = [];
  const ids = new Map([[entryPath, 1]]);
  for (let i = 0, queue = [entryPath]; i < queue.length; i++) {
    const node = nodes.get(queue[i]);
    node.id = i + 1;
    graph.push(node);
    for (const f of node.depFiles) {
      if (!ids.has(f)) {
        ids.set(f, ids.size + 1);
        queue.push(f);
      }
    }
    node.deps = node.depFiles.map((f) => ids.get(f));
  }
  return graph;
}

function createPool(size) {
  const workers = Array.from({ length: size }, () => ({ w: new Worker(new URL('./worker.js', import.meta.url)), busy: 0 }));
  const waiting = new Map();
  let next = 0;
  for (const { w } of workers) {
    w.on('message', ({ job, result, error }) => {
      const { resolve: ok, reject, slot } = waiting.get(job);
      waiting.delete(job);
      slot.busy--;
      if (error) reject(new Error(error));
      else ok(result);
    });
  }
  return {
    run(file, id) {
      const slot = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      slot.busy++;
      const job = next++;
      return new Promise((ok, reject) => {
        waiting.set(job, { resolve: ok, reject, slot });
        slot.w.postMessage({ job, file, id });
      });
    },
    close: () => workers.forEach(({ w }) => w.terminate()),
  };
}

function displayPath(file, root) {
  const nm = file.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  if (nm !== -1) return file.slice(nm + 1).split(path.sep).join('/');
  return './' + path.relative(root, file).split(path.sep).join('/');
}

function counts(db, close = false) {
  const one = (sql) => db.prepare(sql).get().n;
  const c = {
    modules: one('SELECT count(*) n FROM modules'),
    statements: one('SELECT count(*) n FROM statements'),
    exports: one('SELECT count(*) n FROM linked_exports'),
  };
  if (close) db.close();
  return c;
}

/** Fails the build the way Node fails to link: a missing named export is an error. */
export function assertLinked(db) {
  const missing = db.prepare('SELECT * FROM unresolved_imports').all();
  if (missing.length) {
    const list = missing.map((m) => `  ${m.module}: "${m.import}" is not exported by ${m.from_module}`).join('\n');
    throw new Error(`link error:\n${list}`);
  }
}
