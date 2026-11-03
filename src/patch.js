/**
 * In-place edits of a built bundle, each one a single transaction that is
 * relinked and checked before it commits. Anything derived (module code, the
 * materialized output) is computed from the rows on read, so nothing goes stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transformModule } from './transform.js';
import { LINK, TREE_SHAKE } from './sql.js';
import { assertLinked } from './bundler.js';

function transaction(file, fn) {
  const db = new DatabaseSync(file);
  db.exec('BEGIN IMMEDIATE'); db.exec('PRAGMA defer_foreign_keys = ON');
  try {
    const result = fn(db);
    db.exec(LINK);
    assertLinked(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}

const moduleId = (db, p) => {
  const row = db.prepare('SELECT id FROM modules WHERE path = ?').get(p);
  if (!row) throw new Error(`no module "${p}" in the bundle`);
  return row.id;
};

/** Point import specifier `specifier` at another module already in the bundle. */
export function redirect(file, { specifier, to, importer = null }) {
  return transaction(file, (db) => {
    const target = moduleId(db, to);
    const res = importer
      ? db.prepare('UPDATE dependencies SET resolved_id = ? WHERE specifier = ? AND importer_id = ?').run(target, specifier, moduleId(db, importer))
      : db.prepare('UPDATE dependencies SET resolved_id = ? WHERE specifier = ?').run(target, specifier);
    if (res.changes === 0) throw new Error(`no import of "${specifier}"${importer ? ` in ${importer}` : ''}`);
    return res.changes;
  });
}

/** Replace the code of one module with a new file, keeping its id and importers. */
export function replace(file, { module, source }) {
  const code = fs.readFileSync(source, 'utf8');
  return transaction(file, (db) => {
    const id = moduleId(db, module);
    const t = transformModule(code, module);
    const known = new Map(db.prepare('SELECT specifier, resolved_id FROM dependencies WHERE importer_id = ?').all(id).map((d) => [d.specifier, d.resolved_id]));
    const resolveIn = (spec) => {
      if (known.has(spec)) return known.get(spec);
      if (spec.startsWith('.')) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(module), spec));
        const candidates = ['', '.js', '.mjs', '/index.js'].map((e) => `./${base}${e}`.replace(/^\.\/\.\//, './'));
        for (const c of candidates) {
          const row = db.prepare('SELECT id FROM modules WHERE path = ?').get(c);
          if (row) return row.id;
        }
      }
      throw new Error(`${source}: "${spec}" is not in the bundle; rebuild instead`);
    };
    for (const table of ['statements', 'bindings', 'refs', 'relocations', 'exports']) {
      db.prepare(`DELETE FROM ${table} WHERE module_id = ?`).run(id);
    }
    db.prepare('DELETE FROM dependencies WHERE importer_id = ?').run(id);
    db.prepare('UPDATE modules SET format = ? WHERE id = ?').run(t.format, id);
    t.deps.forEach((d, idx) => db.prepare('INSERT INTO dependencies VALUES (?, ?, ?, ?, ?)').run(id, idx, d.specifier, d.kind, resolveIn(d.specifier)));
    t.statements.forEach((s, idx) => {
      db.prepare('INSERT INTO statements VALUES (?, ?, ?, ?)').run(id, idx, s.code, s.pure ? 1 : 0);
      for (const n of s.declares) db.prepare('INSERT OR IGNORE INTO bindings VALUES (?, ?, ?)').run(id, n, idx);
      for (const r of s.refs) db.prepare('INSERT INTO refs VALUES (?, ?, ?, ?, ?)').run(id, idx, r.kind, r.name, r.dep ?? null);
      for (const r of s.relocations) {
        db.prepare('INSERT INTO relocations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, idx, r.start, r.end, r.kind, r.name, r.dep ?? null, r.form, r.local ?? null);
      }
    });
    for (const n of [...t.globals, ...t.innerNames]) db.prepare('INSERT OR IGNORE INTO reserved_names VALUES (?)').run(n);
    for (const e of t.exports) {
      db.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?, ?)').run(id, e.name, e.kind, e.local ?? null, e.dep ?? null, e.imported ?? null);
    }
    return id;
  });
}

/** Tree-shake an existing bundle in place (a no-op on bundles built with shaking on). */
export function shake(file) {
  const db = new DatabaseSync(file);
  const before = db.prepare('SELECT (SELECT count(*) FROM modules) m, (SELECT count(*) FROM statements) s').get();
  db.exec('BEGIN IMMEDIATE'); db.exec('PRAGMA defer_foreign_keys = ON');
  try {
    db.exec(TREE_SHAKE);
    db.exec(LINK);
    assertLinked(db);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  db.exec('VACUUM');
  const after = db.prepare('SELECT (SELECT count(*) FROM modules) m, (SELECT count(*) FROM statements) s').get();
  db.close();
  return { before, after };
}
