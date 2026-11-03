/**
 * Object files. Compiling one module can produce a tiny SQLite database of its
 * own (the .o of this project): the module's statements, bindings,
 * references, relocations, exports and import specifiers, all unresolved.
 * The bundler links object files into the bundle with ATTACH DATABASE and one
 * INSERT ... SELECT per table, the way ld combines .o files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { transformModule } from './transform.js';

export const OBJECT_APPLICATION_ID = 0x524f574f; // "ROWO"

const OBJECT_SCHEMA = `
PRAGMA page_size = 512; -- the minimum: an object file is mostly fixed per-table overhead
PRAGMA application_id = ${OBJECT_APPLICATION_ID};
CREATE TABLE module (path TEXT NOT NULL, format TEXT NOT NULL, warnings TEXT NOT NULL);
CREATE TABLE deps (idx INTEGER PRIMARY KEY, specifier TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE statements (idx INTEGER PRIMARY KEY, code TEXT NOT NULL, pure INTEGER NOT NULL);
CREATE TABLE bindings (name TEXT PRIMARY KEY, stmt_idx INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE refs (stmt_idx INTEGER, kind TEXT, name TEXT, dep_idx INTEGER);
CREATE TABLE relocations (stmt_idx INTEGER, start INTEGER, end INTEGER, kind TEXT, name TEXT, dep_idx INTEGER, form TEXT, local TEXT);
CREATE TABLE exports (name TEXT, kind TEXT, local_name TEXT, dep_idx INTEGER, imported_name TEXT);
CREATE TABLE reserved (name TEXT PRIMARY KEY) WITHOUT ROWID;
`;

/** Compile one module into an object file. Returns its bytes. */
export function compileObject(source, id) {
  const t = transformModule(source, id);
  const db = new DatabaseSync(':memory:');
  db.exec(OBJECT_SCHEMA);
  db.exec('BEGIN');
  db.prepare('INSERT INTO module VALUES (?, ?, ?)').run(id, t.format, JSON.stringify(t.warnings));
  const dep = db.prepare('INSERT INTO deps VALUES (?, ?, ?)');
  t.deps.forEach((d, i) => dep.run(i, d.specifier, d.kind));
  const st = db.prepare('INSERT INTO statements VALUES (?, ?, ?)');
  const bi = db.prepare('INSERT OR IGNORE INTO bindings VALUES (?, ?)');
  const rf = db.prepare('INSERT INTO refs VALUES (?, ?, ?, ?)');
  const rl = db.prepare('INSERT INTO relocations VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  t.statements.forEach((s, i) => {
    st.run(i, s.code, s.pure ? 1 : 0);
    for (const n of s.declares) bi.run(n, i);
    for (const r of s.refs) rf.run(i, r.kind, r.name, r.dep ?? null);
    for (const r of s.relocations) rl.run(i, r.start, r.end, r.kind, r.name, r.dep ?? null, r.form, r.local ?? null);
  });
  const ex = db.prepare('INSERT INTO exports VALUES (?, ?, ?, ?, ?)');
  for (const e of t.exports) ex.run(e.name, e.kind, e.local ?? null, e.dep ?? null, e.imported ?? null);
  const rs = db.prepare('INSERT OR IGNORE INTO reserved VALUES (?)');
  for (const n of [...t.globals, ...t.innerNames]) rs.run(n);
  db.exec('COMMIT');
  const bytes = serialize(db);
  db.close();
  return bytes;
}

function serialize(db) {
  if (typeof db.serialize === 'function') return db.serialize();
  // older node:sqlite: write a compact copy to a temp file instead
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rowpack-o-')), 'm.o.sqlite');
  db.prepare('VACUUM INTO ?').run(file);
  const bytes = fs.readFileSync(file);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return bytes;
}

/** What the graph walk needs from an object file before linking: its format and imports. */
export function readObjectHeader(bytes) {
  const db = new DatabaseSync(':memory:');
  db.deserialize(bytes);
  const m = db.prepare('SELECT format, warnings FROM module').get();
  const deps = db.prepare('SELECT specifier, kind FROM deps ORDER BY idx').all().map((d) => ({ specifier: d.specifier, kind: d.kind }));
  db.close();
  return { format: m.format, warnings: JSON.parse(m.warnings), deps };
}

/**
 * Link object files into the bundle database `db` (outside any transaction;
 * the module rows must already exist).
 * @param {Array<{ id: number, bytes: Uint8Array, resolved: number[] }>} objects
 */
export function linkObjects(db, objects) {
  if (!objects.length) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rowpack-ld-'));
  try {
    // SQLite attaches at most 10 databases at once, and not inside a transaction
    for (let i = 0; i < objects.length; i += 9) {
      const group = objects.slice(i, i + 9);
      group.forEach((o, j) => {
        const file = path.join(dir, `${o.id}.o`);
        fs.writeFileSync(file, o.bytes);
        db.prepare(`ATTACH DATABASE ? AS o${j}`).run(file);
      });
      db.exec('BEGIN');
      group.forEach((o, j) => {
        const s = `o${j}`;
        const id = Number(o.id);
        db.exec(`
          UPDATE main.modules SET format = (SELECT format FROM ${s}.module) WHERE id = ${id};
          INSERT INTO main.statements (module_id, idx, code, pure) SELECT ${id}, idx, code, pure FROM ${s}.statements;
          INSERT OR IGNORE INTO main.bindings (module_id, name, stmt_idx) SELECT ${id}, name, stmt_idx FROM ${s}.bindings;
          INSERT INTO main.refs (module_id, stmt_idx, kind, name, dep_idx) SELECT ${id}, stmt_idx, kind, name, dep_idx FROM ${s}.refs;
          INSERT INTO main.relocations (module_id, stmt_idx, start, end, kind, name, dep_idx, form, local)
            SELECT ${id}, stmt_idx, start, end, kind, name, dep_idx, form, local FROM ${s}.relocations;
          INSERT INTO main.exports (module_id, name, kind, local_name, dep_idx, imported_name)
            SELECT ${id}, name, kind, local_name, dep_idx, imported_name FROM ${s}.exports;
          INSERT OR IGNORE INTO main.reserved_names (name) SELECT name FROM ${s}.reserved;
        `);
        // symbol resolution happened in the graph walk: the object only knows specifiers
        const dep = db.prepare(`INSERT INTO main.dependencies (importer_id, idx, specifier, kind, resolved_id)
          SELECT ?, idx, specifier, kind, ? FROM ${s}.deps WHERE idx = ?`);
        o.resolved.forEach((target, idx) => dep.run(id, target, idx));
      });
      db.exec('COMMIT');
      group.forEach((_, j) => db.exec(`DETACH DATABASE o${j}`));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
