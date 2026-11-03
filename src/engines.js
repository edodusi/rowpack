/**
 * The two ways to run a bundle:
 *   - the SQL engine: the dynamic linker queries the database for each module
 *     it loads (Node uses node:sqlite, browsers use sql.js);
 *   - the materialized engine: the same records, read once at build time and
 *     written out as a plain JavaScript file.
 */
import { DatabaseSync } from 'node:sqlite';
import { createRuntime, createHost } from './runtime.js';

/** The one query the dynamic linker runs per module. */
export const RECORD_SQL = 'SELECT id, path, format, code, deps, exports, mime, content FROM module_records WHERE id = ?';

export function runtimeSource() {
  return `const createRuntime = ${createRuntime.toString()};\nconst createHost = ${createHost.toString()};`;
}

export function toRecord(row) {
  return {
    path: row.path,
    format: row.format,
    code: row.code,
    deps: JSON.parse(row.deps),
    exports: JSON.parse(row.exports),
    mime: row.mime,
    content: row.content,
  };
}

/** Run a .sqlite bundle in Node by querying it. Returns the entry namespace and stats. */
export function runSql(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const stmt = db.prepare(RECORD_SQL);
  let queries = 0;
  const runtime = createRuntime((id) => {
    queries++;
    const row = stmt.get(id);
    return row && toRecord(row);
  }, createHost());
  const entry = Number(db.prepare("SELECT value FROM meta WHERE key = 'entry_id'").get().value);
  const ns = runtime.run(entry);
  return { ns, queries, close: () => db.close() };
}

/**
 * Write the materialized engine: every record becomes an object literal and
 * every module body becomes a real function, so nothing is eval'd at runtime.
 */
export function materialize(file) {
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
