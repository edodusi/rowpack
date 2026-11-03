const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { build } = require('./bundler.js');
const { SQLLinker, createNodeDbAdapter } = require('./runtime/linker.js');
const { materializeJs } = require('./materializer.js');

function printUsage() {
  console.log(`
SQLBundle (SELF-JS) — "Your Executable is a SQLite Database"

Usage:
  sqlbundle build <entry.js> [options]
  sqlbundle run <bundle.sqlite> [--fast]
  sqlbundle emit-js <bundle.sqlite> [-o bundle.js]
  sqlbundle inspect <bundle.sqlite>
  sqlbundle strip <bundle.sqlite>
  sqlbundle patch <bundle.sqlite> --redirect <oldSpecifier>=<newModulePath>
  sqlbundle query <bundle.sqlite> "<SQL query>"

Options:
  -o, --out <path>       Output path for .sqlite database
  --html <path>          Output path for standalone browser .html executable
  --js <path>            Output path for materialized pure JavaScript bundle
  --name <title>         Display title for the bundle
  --fast                 Execute directly in V8 bypassing SQL query engine
  -h, --help             Display this help message
`);
}

function runCli(args) {
  const command = args[0];

  if (!command || command === '-h' || command === '--help') {
    printUsage();
    return;
  }

  if (command === 'build') {
    const entry = args[1];
    if (!entry) {
      console.error('Error: Entry file path required for "build".');
      process.exit(1);
    }

    let outSqlite = null;
    let outHtml = null;
    let outJs = null;
    let bundleName = null;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '-o' || args[i] === '--out') {
        outSqlite = args[++i];
      } else if (args[i] === '--html') {
        outHtml = args[++i];
      } else if (args[i] === '--js') {
        outJs = args[++i];
      } else if (args[i] === '--name') {
        bundleName = args[++i];
      }
    }

    const startTime = performance.now();
    const result = build({ entry, outSqlite, outHtml, outJs, bundleName });
    const elapsed = (performance.now() - startTime).toFixed(2);

    console.log(`\n✨ Successfully built SQLBundle in ${elapsed}ms:`);
    console.log(`   📦 SQLite DB : ${result.sqlitePath} (${(result.stats.sqliteSize / 1024).toFixed(1)} KB)`);
    console.log(`   🌐 Browser HTML: ${result.htmlPath}`);
    console.log(`   ⚡ Fast JS    : ${result.jsPath} (${(result.stats.jsSize / 1024).toFixed(1)} KB)`);
    console.log(`   📊 Modules   : ${result.stats.moduleCount}`);
    console.log(`   🔗 Links     : ${result.stats.dependencyCount}`);
    console.log(`   🏷️ Symbols   : ${result.stats.symbolCount}\n`);
    return;
  }

  if (command === 'emit-js') {
    const bundleFile = args[1];
    if (!bundleFile || !fs.existsSync(bundleFile)) {
      console.error('Error: Bundle path required for "emit-js".');
      process.exit(1);
    }
    let outFile = bundleFile.replace(/\.sqlite$/, '.js');
    if (outFile === bundleFile) outFile += '.js';
    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '-o' || args[i] === '--out') && args[i + 1]) {
        outFile = args[++i];
      }
    }
    const db = new DatabaseSync(bundleFile);
    try {
      const code = materializeJs(db);
      db.prepare('INSERT OR REPLACE INTO js_bundle (id, code) VALUES (1, ?)').run(code);
      fs.writeFileSync(outFile, code, 'utf8');
      console.log(`\n⚡ Successfully materialized pure JavaScript bundle:`);
      console.log(`   📄 Output file : ${outFile} (${(Buffer.byteLength(code, 'utf8') / 1024).toFixed(1)} KB)`);
      console.log(`   🚀 Execution   : Native V8 O(1) performance (0 KB Wasm, zero SQL overhead)\n`);
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'run') {
    const bundleFile = args[1];
    if (!bundleFile) {
      console.error('Error: Bundle path required for "run".');
      process.exit(1);
    }

    if (!fs.existsSync(bundleFile)) {
      console.error(`Error: Bundle file not found: ${bundleFile}`);
      process.exit(1);
    }

    const isFast = args.includes('--fast') || bundleFile.endsWith('.js');

    if (isFast) {
      const startTime = performance.now();
      let code;
      if (bundleFile.endsWith('.js')) {
        code = fs.readFileSync(bundleFile, 'utf8');
      } else {
        const db = new DatabaseSync(bundleFile);
        code = materializeJs(db);
        db.close();
      }
      const output = eval(code);
      const elapsed = (performance.now() - startTime).toFixed(3);
      console.log(`\n⚡ Executed via Fast Materialized Runtime in ${elapsed}ms (0 SQL queries):`);
      if (output !== undefined) {
        console.log('[Entry Module Returned]:', output);
      }
      return;
    }

    const db = new DatabaseSync(bundleFile);
    const linker = new SQLLinker(createNodeDbAdapter(db));
    try {
      const startTime = performance.now();
      const output = linker.executeEntry();
      const elapsed = (performance.now() - startTime).toFixed(2);
      console.log(`\n🔍 Executed via SQL Linker in ${elapsed}ms (${linker.stats.sqlQueriesExecuted} SQL queries):`);
      if (output !== undefined) {
        console.log('[Entry Module Returned]:', output);
      }
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'inspect') {
    const bundleFile = args[1];
    if (!bundleFile || !fs.existsSync(bundleFile)) {
      console.error('Error: Bundle path required for "inspect".');
      process.exit(1);
    }

    const db = new DatabaseSync(bundleFile);
    try {
      console.log(`\n=== SQLBundle Executable: ${bundleFile} ===`);

      // Metadata
      console.log('\n[Header / Meta (bundle_meta)]:');
      const meta = db.prepare('SELECT key, value FROM bundle_meta').all();
      for (const m of meta) {
        console.log(`  ${m.key.padEnd(16)}: ${m.value}`);
      }

      // Modules
      console.log('\n[Modules (modules table)]:');
      const modules = db.prepare('SELECT id, path, size, is_entry FROM modules ORDER BY id').all();
      for (const mod of modules) {
        const flag = mod.is_entry ? ' [ENTRY]' : '';
        console.log(`  [#${mod.id}] ${mod.path} (${mod.size} B)${flag}`);
      }

      // Dependencies (ldd)
      console.log('\n[Dynamic Dependencies (ldd view)]:');
      const ldd = db.prepare('SELECT importer, specifier, resolves_to FROM ldd').all();
      for (const d of ldd) {
        console.log(`  ${d.importer} -> ${d.specifier} => ${d.resolves_to}`);
      }

      // Exports
      console.log('\n[Exported Symbols (exports view)]:');
      const exports = db.prepare('SELECT module, symbol FROM exports').all();
      for (const e of exports) {
        console.log(`  ${e.module}: ${e.symbol}`);
      }
      console.log();
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'strip') {
    // Tree-shaking / dead code elimination via SQL CTE and VACUUM
    const bundleFile = args[1];
    if (!bundleFile || !fs.existsSync(bundleFile)) {
      console.error('Error: Bundle path required for "strip".');
      process.exit(1);
    }

    const beforeSize = fs.statSync(bundleFile).size;
    const db = new DatabaseSync(bundleFile);

    try {
      // Find unused modules and remove them
      db.exec(`
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
      db.exec('VACUUM;');
      console.log('✅ Strip completed successfully via SQL transaction and VACUUM.');
    } finally {
      db.close();
    }

    const afterSize = fs.statSync(bundleFile).size;
    console.log(`   Size: ${beforeSize} bytes -> ${afterSize} bytes (${beforeSize - afterSize} bytes saved)\n`);
    return;
  }

  if (command === 'patch') {
    // Equivalent to patchelf: dynamically redirect an import
    const bundleFile = args[1];
    let redirectArg = null;

    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--redirect' && args[i + 1]) {
        redirectArg = args[++i];
      }
    }

    if (!bundleFile || !redirectArg || !redirectArg.includes('=')) {
      console.error('Error: Usage: sqlbundle patch <bundle> --redirect <oldSpecifier>=<newModulePath>');
      process.exit(1);
    }

    const [oldSpecifier, newModulePath] = redirectArg.split('=');
    const db = new DatabaseSync(bundleFile);
    try {
      const targetMod = db.prepare('SELECT id FROM modules WHERE path = ?').all(newModulePath);
      if (targetMod.length === 0) {
        console.error(`Error: Target module "${newModulePath}" not found in bundle.`);
        process.exit(1);
      }
      const newId = targetMod[0].id;
      const res = db.prepare('UPDATE dependencies SET resolved_module_id = ? WHERE specifier = ?').run(newId, oldSpecifier);
      console.log(`✅ Patched ${res.changes} dependency reference(s) to "${oldSpecifier}" -> "${newModulePath}" (ID ${newId}).`);
    } finally {
      db.close();
    }
    return;
  }

  if (command === 'query') {
    const bundleFile = args[1];
    const sql = args[2];
    if (!bundleFile || !sql) {
      console.error('Error: Usage: sqlbundle query <bundle.sqlite> "<SQL>"');
      process.exit(1);
    }

    const db = new DatabaseSync(bundleFile);
    try {
      const rows = db.prepare(sql).all();
      console.table(rows);
    } finally {
      db.close();
    }
    return;
  }

  console.error(`Unknown command: "${command}". Run with --help for usage.`);
  process.exit(1);
}

module.exports = {
  runCli
};
