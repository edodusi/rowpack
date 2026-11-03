/**
 * build(): walk the module graph, write it into SQLite as rows, then let SQL
 * link it (and tree-shake it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transformModule } from './transform.js';
import { resolve } from './resolve.js';
import { SCHEMA, LINK, TREE_SHAKE } from './sql.js';
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
 * @returns {{ out: string, stats: object, warnings: string[] }}
 */
export function build({ entry, out, treeShake = true }) {
  const t0 = performance.now();
  const entryPath = fs.realpathSync(path.resolve(entry));
  const root = path.dirname(entryPath);
  const warnings = [];

  // ---- 1. graph walk: parse every module exactly once -------------------
  const ids = new Map(); // abs path -> id
  const graph = []; // in id order
  const queue = [entryPath];
  ids.set(entryPath, 1);

  for (let i = 0; i < queue.length; i++) {
    const file = queue[i];
    const ext = path.extname(file).toLowerCase();
    const node = { id: i + 1, file, path: displayPath(file, root), format: null, transformed: null, asset: null, deps: [] };
    graph.push(node);

    const asset = ASSET_TYPES[ext];
    if (asset) {
      const [format, mime] = asset;
      node.format = format;
      node.asset = { mime, content: TEXT_FORMATS.has(format) ? fs.readFileSync(file, 'utf8') : fs.readFileSync(file) };
      continue;
    }

    const t = transformModule(fs.readFileSync(file, 'utf8'), node.path);
    node.format = t.format;
    node.transformed = t;
    warnings.push(...t.warnings);
    for (const dep of t.deps) {
      const target = resolve(dep.specifier, file);
      if (!target) throw new Error(`${node.path}: cannot resolve "${dep.specifier}"`);
      if (!ids.has(target)) {
        ids.set(target, ids.size + 1);
        queue.push(target);
      }
      node.deps.push(ids.get(target));
    }
  }
  const tParse = performance.now();

  // ---- 2. rows ----------------------------------------------------------
  // Build in memory, then VACUUM INTO the file: one compact write, no journal.
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.exec('BEGIN'); db.exec('PRAGMA defer_foreign_keys = ON');
  const q = {
    asset: db.prepare('INSERT INTO assets (id, mime, content) VALUES (?, ?, ?)'),
    module: db.prepare('INSERT INTO modules (id, path, format, is_entry, asset_id) VALUES (?, ?, ?, ?, ?)'),
    statement: db.prepare('INSERT INTO statements (module_id, idx, code, pure) VALUES (?, ?, ?, ?)'),
    binding: db.prepare('INSERT OR IGNORE INTO bindings (module_id, name, stmt_idx) VALUES (?, ?, ?)'),
    ref: db.prepare('INSERT INTO refs (module_id, stmt_idx, kind, name, dep_idx) VALUES (?, ?, ?, ?, ?)'),
    dep: db.prepare('INSERT INTO dependencies (importer_id, idx, specifier, kind, resolved_id) VALUES (?, ?, ?, ?, ?)'),
    export: db.prepare('INSERT INTO exports (module_id, name, kind, local_name, dep_idx, imported_name) VALUES (?, ?, ?, ?, ?, ?)'),
    meta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)'),
    runtime: db.prepare('INSERT INTO runtime (name, code) VALUES (?, ?)'),
  };

  for (const n of graph) {
    if (n.asset) q.asset.run(n.id, n.asset.mime, n.asset.content);
    q.module.run(n.id, n.path, n.format, n.id === 1 ? 1 : 0, n.asset ? n.id : null);
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
    });
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
