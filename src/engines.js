/**
 * The two ways to run a bundle:
 *   - the SQL engine: the dynamic linker queries the database for each module
 *     it loads (Node uses node:sqlite, browsers use sql.js);
 *   - the materialized engine: the same records, read once at build time and
 *     written out as a plain JavaScript file.
 */
import { DatabaseSync } from 'node:sqlite';
import { createRuntime, createHost, createSqlSource } from './runtime.js';
import { staticLink } from './static-link.js';

export function runtimeSource() {
  return [createRuntime, createHost, createSqlSource].map((f) => `const ${f.name} = ${f.toString()};`).join('\n');
}

/** Run a .sqlite bundle in Node by querying it. Returns the entry namespace and stats. */
export function runSql(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const statements = new Map();
  const query = (sql, params) => {
    let stmt = statements.get(sql);
    if (!stmt) statements.set(sql, (stmt = db.prepare(sql)));
    return stmt.all(...params);
  };
  const entry = Number(db.prepare("SELECT value FROM meta WHERE key = 'entry_id'").get().value);
  const source = createSqlSource(query, entry);
  const ns = createRuntime(source.getRecord, createHost()).run(entry);
  return { ns, get queries() { return source.stats.queries; }, close: () => db.close() };
}

/**
 * Write the bundle out as a plain script.
 *   engine 'static' (default): statically linked, one scope, direct references;
 *                    falls back to 'dynamic' when the bundle needs it.
 *   engine 'dynamic': the module records written as object literals and run by
 *                    the same runtime the SQL engine uses.
 * @returns {string}
 */
export function materialize(file, { engine = 'static', onFallback = () => {} } = {}) {
  if (engine === 'static') {
    const r = staticLink(file);
    if (r.code) return r.code;
    onFallback(r.fallback);
  }
  return materializeDynamic(file);
}

function materializeDynamic(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const entry = db.prepare("SELECT value FROM meta WHERE key = 'entry_id'").get().value;
  const rows = db.prepare('SELECT id, path, format, code, deps, exports, mime, content FROM module_records ORDER BY id').all();
  db.close();

  const records = rows.map((row) => {
    const fields = [
      `path: ${JSON.stringify(row.path)}`,
      `format: ${JSON.stringify(row.format)}`,
      `deps: ${row.deps}`,
      `exports: ${row.exports}`,
    ];
    if (row.format === 'esm') fields.push(`factory: function (__export, __import, __dynamic) {\n${row.code}\n}`);
    else if (row.format === 'cjs') fields.push(`factory: function (module, exports, require) {\n${row.code}\n}`);
    else if (row.format === 'url') fields.push(`content: ${JSON.stringify(`data:${row.mime};base64,${Buffer.from(row.content).toString('base64')}`)}`);
    else fields.push(`content: ${JSON.stringify(row.content)}`);
    return `${row.id}: { ${fields.join(', ')} }`;
  });

  return `(() => {
${runtimeSource()}
const records = {
${records.join(',\n')}
};
return createRuntime((id) => records[id], createHost()).run(${entry});
})();
`;
}
