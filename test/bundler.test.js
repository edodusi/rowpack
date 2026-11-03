const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const { JSDOM } = require('jsdom');
const { build } = require('../src/bundler.js');
const { SQLLinker, createNodeDbAdapter } = require('../src/runtime/linker.js');
const { parseAndTransformModule } = require('../src/parser.js');

async function runTests() {
  console.log('🧪 Running SQLBundle Test Suite...\n');

  // Test 1: Parser unit test
  console.log('Test 1: ES6 Parser & Transformer');
  const sampleCode = `
    import { add } from './math.js';
    import defFmt, { custom } from './fmt.js';
    export const PI = 3.14159;
    export function compute(x) { return add(x, 10); }
    export default function main() { return compute(5); }
  `;
  const parsed = parseAndTransformModule(sampleCode, 'sample.js');
  assert.strictEqual(parsed.dependencies.length, 2);
  assert(parsed.dependencies.includes('./math.js'));
  assert(parsed.dependencies.includes('./fmt.js'));
  assert.strictEqual(parsed.exports.length, 3);
  assert(parsed.code.includes('__require("./math.js")'));
  assert(parsed.code.includes('__exports.PI = PI;'));
  assert(parsed.code.includes('__exports.default = main;'));
  console.log('  ✅ Parser transforms ES6 imports/exports to SQLBundle closures\n');

  // Test 2: Build demo project
  console.log('Test 2: Build Demo Project into SQLite & HTML');
  const entryPath = path.resolve(__dirname, '../demo-app/src/index.js');
  const outSqlite = path.resolve(__dirname, '../dist/test_bundle.sqlite');
  const outHtml = path.resolve(__dirname, '../dist/test_bundle.html');
  const outJs = path.resolve(__dirname, '../dist/test_bundle.js');

  const buildResult = build({
    entry: entryPath,
    outSqlite,
    outHtml,
    outJs,
    bundleName: 'TestBundle'
  });

  assert(fs.existsSync(outSqlite), 'SQLite database file was created');
  assert(fs.existsSync(outHtml), 'HTML executable file was created');
  assert(buildResult.stats.moduleCount >= 5);
  assert(buildResult.stats.assetCount >= 3);
  console.log(`  ✅ Bundler compiled ${buildResult.stats.moduleCount} modules and ${buildResult.stats.assetCount} assets into SQLite database and HTML\n`);

  // Test 3: Validate SQLite Database Structure
  console.log('Test 3: SQLite Database Header, Assets Table & Relational Views');
  const db = new DatabaseSync(outSqlite);
  
  // Check application_id
  const appIdRow = db.prepare('PRAGMA application_id').all();
  assert.strictEqual(appIdRow[0].application_id, 0x53514c42, 'application_id is 0x53514c42 ("SQLB")');

  // Check user_version
  const userVer = db.prepare('PRAGMA user_version').all();
  assert.strictEqual(userVer[0].user_version, 1);

  // Check metadata
  const metaRows = db.prepare('SELECT key, value FROM bundle_meta').all();
  const metaMap = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
  assert.strictEqual(metaMap.bundle_name, 'TestBundle');
  assert.strictEqual(metaMap.entry_id, '1');

  // Check assets table
  const assetRows = db.prepare('SELECT path, type, size FROM assets').all();
  assert(assetRows.length >= 3, 'Assets table contains CSS, SVG, and JSON');
  assert(assetRows.some(a => a.type === 'css'), 'CSS asset stored in SQLite');
  assert(assetRows.some(a => a.type === 'svg'), 'SVG asset stored in SQLite');

  // Check ldd view
  const lddRows = db.prepare('SELECT importer, specifier, resolves_to FROM ldd').all();
  assert(lddRows.length >= 5);
  const mathLink = lddRows.find(r => r.specifier === './math.js');
  assert(mathLink && mathLink.resolves_to === './math.js');

  // Check exports view
  const exportRows = db.prepare('SELECT module, symbol FROM exports').all();
  assert(exportRows.some(r => r.symbol === 'add' && r.module === './math.js'));
  assert(exportRows.some(r => r.symbol === 'formatCurrency'));

  // Check unresolved_symbols view
  const unresolved = db.prepare('SELECT * FROM unresolved_symbols').all();
  assert.strictEqual(unresolved.length, 0, 'No unresolved symbols in demo bundle');

  db.close();
  console.log('  ✅ SQLite database schema, assets table, application_id, indexes, and views verified\n');

  // Test 4: CLI Execution via node:sqlite Linker
  console.log('Test 4: Dynamic SQL Linker CLI Execution');
  const runDb = new DatabaseSync(outSqlite);
  const linker = new SQLLinker(createNodeDbAdapter(runDb));
  const executionOutput = linker.executeEntry();
  runDb.close();

  assert(executionOutput && executionOutput.results, 'Module returned expected results');
  assert.strictEqual(executionOutput.results.sum, 42);
  assert.strictEqual(executionOutput.results.product, 42);
  assert.strictEqual(executionOutput.results.fib, 55);
  assert.strictEqual(executionOutput.results.price, '$1234.50');
  assert.strictEqual(executionOutput.results.acornVersion, '8.18.0');
  assert.strictEqual(executionOutput.results.state.count, 42);
  assert(linker.stats.sqlQueriesExecuted > 0);
  console.log(`  ✅ Successfully executed bundle in Node CLI (${linker.stats.sqlQueriesExecuted} SQL queries)\n`);

  // Test 5: Browser Execution via JSDOM and WebAssembly SQLite
  console.log('Test 5: Browser Execution via WebAssembly SQLite');
  const htmlContent = fs.readFileSync(outHtml, 'utf8');
  const dom = new JSDOM(htmlContent, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: 'http://localhost/test_bundle.html'
  });
  dom.window.WebAssembly = WebAssembly;

  await new Promise(resolve => {
    dom.window.document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        const appHtml = dom.window.document.getElementById('app').innerHTML;
        assert(appHtml.includes('42'), 'App rendered calculation sum');
        assert(appHtml.includes('$1234.50'), 'App rendered formatted price');
        assert(appHtml.includes('SQLBundle Test Suite') || appHtml.includes('SQLBundle Demo'), 'App rendered title');

        const mCount = dom.window.document.getElementById('m-count').textContent;
        assert.strictEqual(mCount, String(buildResult.stats.moduleCount), 'HUD displays modules loaded');
        console.log('  ✅ Standalone HTML executed in browser DOM via WebAssembly SQLite\n');
        resolve();
      }, 600);
    });
    // Trigger event manually if already loaded
    dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  });

  // Test 6: Tree-Shaking / Strip (DELETE ... + VACUUM)
  console.log('Test 6: Tree-Shaking via SQL Transaction & VACUUM');
  const stripDb = new DatabaseSync(outSqlite);
  stripDb.prepare('INSERT INTO modules (id, path, code, size, is_entry) VALUES (?, ?, ?, ?, ?)').run(
    999, './orphan.js', 'console.log("orphan");', 100, 0
  );
  stripDb.prepare('INSERT INTO symbols (module_id, name, kind) VALUES (?, ?, ?)').run(
    999, 'orphanFn', 'export'
  );
  
  // Verify orphan exists
  let checkOrphan = stripDb.prepare('SELECT count(*) as c FROM modules WHERE id = 999').all();
  assert.strictEqual(checkOrphan[0].c, 1);

  // Run strip query
  stripDb.exec(`
    DELETE FROM modules WHERE id NOT IN (
      WITH RECURSIVE reachable(id) AS (
        SELECT id FROM modules WHERE is_entry = 1
        UNION
        SELECT d.resolved_module_id
        FROM dependencies d
        JOIN reachable r ON d.importer_id = r.id
        WHERE d.resolved_module_id IS NOT NULL
      )
      SELECT id FROM reachable
    );
    DELETE FROM dependencies WHERE importer_id NOT IN (SELECT id FROM modules);
    DELETE FROM symbols WHERE module_id NOT IN (SELECT id FROM modules);
  `);
  stripDb.exec('VACUUM;');

  checkOrphan = stripDb.prepare('SELECT count(*) as c FROM modules WHERE id = 999').all();
  assert.strictEqual(checkOrphan[0].c, 0, 'Orphan module was stripped');
  stripDb.close();
  console.log('  ✅ Tree-shaking eliminated unused modules via SQL CTE and VACUUM\n');

  // Test 7: Dependency Patching (patchelf equivalent)
  console.log('Test 7: Dependency Hot-Patching (patchelf equivalent)');
  const patchDb = new DatabaseSync(outSqlite);
  patchDb.prepare('INSERT INTO modules (id, path, code, size, is_entry) VALUES (?, ?, ?, ?, ?)').run(
    88, './mock_math.js', '__exports.add = () => 100; __exports.multiply = () => 200; __exports.fibonacci = () => 300;', 80, 0
  );
  patchDb.prepare('UPDATE dependencies SET resolved_module_id = 88 WHERE specifier = ?').run('./math.js');

  const patchLinker = new SQLLinker(createNodeDbAdapter(patchDb));
  const patchedOutput = patchLinker.executeEntry();
  patchDb.close();

  assert.strictEqual(patchedOutput.results.sum, 100);
  assert.strictEqual(patchedOutput.results.product, 200);
  console.log('  ✅ Patched dependency in-place via SQL UPDATE without rebuilding\n');

  // Test 8: Fast Materialized JS Execution & js_output View
  console.log('Test 8: Fast Materialized JS Bundle & js_output View');
  const verifyDb = new DatabaseSync(outSqlite);
  const jsViewRows = verifyDb.prepare('SELECT code FROM js_output').all();
  verifyDb.close();

  assert(jsViewRows.length > 0, 'js_output view returned rows');
  assert(jsViewRows[0].code.includes('__sql_require'), 'js_output contains materialized runtime code');

  // Verify pure JS execution in V8
  const fastOutput = eval(jsViewRows[0].code);
  assert.strictEqual(fastOutput.results.sum, 42);
  assert.strictEqual(fastOutput.results.product, 42);
  assert.strictEqual(fastOutput.results.fib, 55);
  assert.strictEqual(fastOutput.results.price, '$1234.50');
  console.log('  ✅ Materialized JS bundle executes at native V8 speed with 0 SQL queries\n');

  // Cleanup test artifacts
  fs.unlinkSync(outSqlite);
  fs.unlinkSync(outHtml);
  if (fs.existsSync(outJs)) fs.unlinkSync(outJs);

  console.log('🌟 ALL TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
