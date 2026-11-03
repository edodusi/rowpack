/**
 * Browser pages. Both are single files you can open from disk.
 *   sqlPage:  ships sql.js (SQLite compiled to WebAssembly) plus the .sqlite
 *             bundle, and links modules by querying it.
 *   fastPage: ships only the materialized JavaScript.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { RECORD_SQL, runtimeSource } from './engines.js';

const require = createRequire(import.meta.url);
const scriptSafe = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body>
<div id="root"></div><div id="app"></div>
${body}
</body>
</html>
`;
}

export function sqlPage(sqliteFile, title = 'rowpack') {
  const sqlJs = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.js'), 'utf8');
  const wasm = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')).toString('base64');
  const bundle = fs.readFileSync(sqliteFile).toString('base64');
  return page(title, `<script>${scriptSafe(sqlJs)}</script>
<script>
(async () => {
  const t0 = performance.now();
  const bytes = async (b64, type) => new Uint8Array(await (await fetch('data:' + type + ';base64,' + b64)).arrayBuffer());
  const SQL = await initSqlJs({ wasmBinary: await bytes(${JSON.stringify(wasm)}, 'application/wasm') });
  const db = new SQL.Database(await bytes(${JSON.stringify(bundle)}, 'application/vnd.sqlite3'));
  const tReady = performance.now();
  ${scriptSafe(runtimeSource())}
  const stmt = db.prepare(${JSON.stringify(RECORD_SQL)});
  let queries = 0;
  const runtime = createRuntime((id) => {
    queries++;
    stmt.bind([id]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.reset();
    return row && { ...row, deps: JSON.parse(row.deps), exports: JSON.parse(row.exports) };
  }, createHost());
  const entry = Number(db.exec("SELECT value FROM meta WHERE key = 'entry_id'")[0].values[0][0]);
  runtime.run(entry);
  const tDone = performance.now();
  window.__rowpack = { engine: 'sql', db, queries, sqliteReadyMs: tReady - t0, linkAndRunMs: tDone - tReady, totalMs: tDone - t0 };
})().catch((e) => { window.__rowpackError = String(e && e.stack || e); throw e; });
</script>`);
}

export function fastPage(js, title = 'rowpack') {
  return page(title, `<script>
const __t0 = performance.now();
${scriptSafe(js)}
window.__rowpack = { engine: 'materialized', totalMs: performance.now() - __t0 };
</script>`);
}
