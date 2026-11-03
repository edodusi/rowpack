const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { parseAndTransformModule } = require('./parser.js');
const { generateBrowserHtml, generateProdHtml } = require('./runtime/browser-bootstrap.js');
const { materializeJs } = require('./materializer.js');

/**
 * Resolves an import specifier relative to the importer file path.
 */
function resolveModulePath(specifier, importerPath) {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
    const resolved = path.resolve(path.dirname(importerPath), specifier);
    const extensions = [
      '', '.js', '.mjs', '.cjs', '.json', '.css',
      '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.ico',
      '.wav', '.mp3', '.ogg',
      '/index.js', '/index.mjs'
    ];
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return path.normalize(candidate);
      }
    }
  } else {
    // Bare specifier from node_modules or built-ins
    try {
      const candidate = require.resolve(specifier, {
        paths: [path.dirname(importerPath), process.cwd()]
      });
      if (fs.existsSync(candidate)) {
        return path.normalize(candidate);
      }
    } catch (e) {}

    let curr = path.dirname(importerPath);
    while (curr && curr !== path.dirname(curr)) {
      const candidatePkg = path.join(curr, 'node_modules', specifier);
      if (fs.existsSync(candidatePkg)) {
        if (fs.statSync(candidatePkg).isDirectory()) {
          const pkgJsonPath = path.join(candidatePkg, 'package.json');
          if (fs.existsSync(pkgJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
            const mainFile = pkg.module || pkg.main || 'index.js';
            const target = path.join(candidatePkg, mainFile);
            if (fs.existsSync(target)) return path.normalize(target);
          }
          const idx = path.join(candidatePkg, 'index.js');
          if (fs.existsSync(idx)) return path.normalize(idx);
        } else if (fs.statSync(candidatePkg).isFile()) {
          return path.normalize(candidatePkg);
        }
      }
      curr = path.dirname(curr);
    }
  }

  throw new Error(`Cannot resolve import "${specifier}" from "${importerPath}"`);
}

/**
 * Builds a SQLite JavaScript bundle.
 *
 * @param {object} options
 * @param {string} options.entry - Entry file path (e.g. './src/index.js')
 * @param {string} [options.outSqlite] - Output path for .sqlite database
 * @param {string} [options.outHtml] - Output path for .html browser executable
 * @param {string} [options.bundleName] - Display title for the bundle
 * @returns {{ sqlitePath: string, htmlPath: string, stats: object }}
 */
function build(options) {
  const entryPath = path.resolve(options.entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry file does not exist: ${entryPath}`);
  }

  const rootDir = path.dirname(entryPath);
  const bundleName = options.bundleName || path.basename(entryPath, path.extname(entryPath));

  // Module collection
  const modulesByPath = new Map();
  const queue = [entryPath];
  let nextModuleId = 1;

  const rawDependencies = [];
  const rawSymbols = [];
  const rawAssets = [];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (modulesByPath.has(currentPath)) continue;

    let relativePath;
    if (currentPath.includes('node_modules')) {
      const parts = currentPath.split(/node_modules[\/\\]/);
      relativePath = 'node_modules/' + parts[parts.length - 1].replace(/\\/g, '/');
    } else {
      relativePath = './' + path.relative(rootDir, currentPath).replace(/\\/g, '/');
    }

    const ext = path.extname(currentPath).toLowerCase();
    let parsed;
    let modType = 'js';
    let rawByteLength = 0;

    if (ext === '.css') {
      modType = 'css';
      const cssContent = fs.readFileSync(currentPath, 'utf8');
      rawByteLength = Buffer.byteLength(cssContent, 'utf8');
      parsed = {
        code: `const __css = ${JSON.stringify(cssContent)};
if (typeof document !== 'undefined') {
  const __style = document.createElement('style');
  __style.setAttribute('data-module', ${JSON.stringify(relativePath)});
  __style.textContent = __css;
  document.head.appendChild(__style);
}
__exports.default = __css;
module.exports = __css;`,
        dependencies: [],
        exports: [{ symbol: 'default', localName: 'default' }],
        imports: []
      };
      rawAssets.push({
        path: relativePath,
        type: 'css',
        size: rawByteLength,
        content: Buffer.from(cssContent, 'utf8')
      });
    } else if (ext === '.json') {
      modType = 'json';
      const jsonContent = fs.readFileSync(currentPath, 'utf8');
      rawByteLength = Buffer.byteLength(jsonContent, 'utf8');
      parsed = {
        code: `const __data = ${jsonContent.trim()};
__exports.default = __data;
module.exports = __data;
for (const k of Object.keys(__data)) {
  __exports[k] = __data[k];
}`,
        dependencies: [],
        exports: [{ symbol: 'default', localName: 'default' }],
        imports: []
      };
      rawAssets.push({
        path: relativePath,
        type: 'json',
        size: rawByteLength,
        content: Buffer.from(jsonContent, 'utf8')
      });
    } else if (['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.ico', '.wav', '.mp3', '.ogg'].includes(ext)) {
      modType = 'asset';
      const assetBuffer = fs.readFileSync(currentPath);
      rawByteLength = assetBuffer.length;
      const mimeMap = {
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ico': 'image/x-icon',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg'
      };
      const mime = mimeMap[ext] || 'application/octet-stream';
      const dataUrl = `data:${mime};base64,${assetBuffer.toString('base64')}`;

      if (ext === '.svg') {
        const rawSvg = assetBuffer.toString('utf8');
        parsed = {
          code: `const __raw = ${JSON.stringify(rawSvg)};
const __url = ${JSON.stringify(dataUrl)};
const __asset = new String(__raw);
__asset.url = __url;
__exports.default = __asset;
__exports.url = __url;
__exports.raw = __raw;
module.exports = __asset;`,
          dependencies: [],
          exports: [{ symbol: 'default', localName: 'default' }, { symbol: 'url', localName: 'url' }, { symbol: 'raw', localName: 'raw' }],
          imports: []
        };
      } else {
        parsed = {
          code: `const __asset = ${JSON.stringify(dataUrl)};
__exports.default = __asset;
module.exports = __asset;`,
          dependencies: [],
          exports: [{ symbol: 'default', localName: 'default' }],
          imports: []
        };
      }

      rawAssets.push({
        path: relativePath,
        type: ext.slice(1),
        size: assetBuffer.length,
        content: assetBuffer
      });
    } else {
      // JavaScript module
      const source = fs.readFileSync(currentPath, 'utf8');
      rawByteLength = Buffer.byteLength(source, 'utf8');
      parsed = parseAndTransformModule(source, relativePath);
    }

    const moduleId = nextModuleId++;

    const moduleRecord = {
      id: moduleId,
      absPath: currentPath,
      relPath: relativePath,
      code: parsed.code,
      type: modType,
      size: rawByteLength,
      isEntry: currentPath === entryPath ? 1 : 0
    };

    modulesByPath.set(currentPath, moduleRecord);

    // Process dependencies
    for (const specifier of parsed.dependencies) {
      let resolvedTarget;
      try {
        resolvedTarget = resolveModulePath(specifier, currentPath);
        if (!modulesByPath.has(resolvedTarget) && !queue.includes(resolvedTarget)) {
          queue.push(resolvedTarget);
        }
      } catch (err) {
        resolvedTarget = null;
      }

      rawDependencies.push({
        importerId: moduleId,
        specifier,
        resolvedPath: resolvedTarget
      });
    }

    // Process exported symbols
    for (const exp of parsed.exports) {
      rawSymbols.push({
        moduleId,
        name: exp.symbol,
        kind: 'export',
        localName: exp.localName,
        sourceSpecifier: null,
        targetModuleId: null
      });
    }

    // Process imported symbols
    for (const imp of parsed.imports) {
      let targetPath = null;
      try {
        targetPath = resolveModulePath(imp.specifier, currentPath);
      } catch (e) {}

      rawSymbols.push({
        moduleId,
        name: imp.symbol,
        kind: 'import',
        localName: imp.localName,
        sourceSpecifier: imp.specifier,
        targetPath
      });
    }
  }

  // Create SQLite Database
  const outSqlite = options.outSqlite || path.join(path.dirname(entryPath), '../dist/bundle.sqlite');
  const outHtml = options.outHtml || path.join(path.dirname(entryPath), '../dist/bundle.html');
  const outJs = options.outJs || path.join(path.dirname(entryPath), '../dist/bundle.js');

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(path.resolve(outSqlite)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(outHtml)), { recursive: true });
  fs.mkdirSync(path.dirname(path.resolve(outJs)), { recursive: true });

  if (fs.existsSync(outSqlite)) {
    fs.unlinkSync(outSqlite);
  }

  const db = new DatabaseSync(outSqlite);

  // Set ELF-like application_id (0x53514c42 = "SQLB")
  db.exec('PRAGMA application_id = 0x53514c42;');
  db.exec('PRAGMA user_version = 1;');

  // Schema creation
  db.exec(`
    CREATE TABLE bundle_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE modules (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      code TEXT NOT NULL,
      type TEXT DEFAULT 'js',
      is_entry INTEGER DEFAULT 0,
      size INTEGER NOT NULL
    );

    CREATE TABLE dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      importer_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      specifier TEXT NOT NULL,
      resolved_module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL
    );

    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('export', 'import')),
      local_name TEXT,
      source_specifier TEXT,
      target_module_id INTEGER REFERENCES modules(id) ON DELETE SET NULL
    );

    CREATE TABLE _bootstrap (
      id INTEGER PRIMARY KEY,
      content TEXT NOT NULL
    );

    CREATE INDEX idx_modules_path ON modules(path);
    CREATE INDEX idx_deps_importer ON dependencies(importer_id, specifier);
    CREATE INDEX idx_symbols_lookup ON symbols(module_id, name, kind);
    CREATE INDEX idx_symbols_target ON symbols(target_module_id, name);

    -- Declarative Views (ldd, exports, imports, unresolved_symbols)
    CREATE VIEW ldd AS
    SELECT
      m1.path AS importer,
      d.specifier,
      COALESCE(m2.path, '<unresolved>') AS resolves_to
    FROM dependencies d
    JOIN modules m1 ON d.importer_id = m1.id
    LEFT JOIN modules m2 ON d.resolved_module_id = m2.id
    ORDER BY m1.path, d.specifier;

    CREATE VIEW exports AS
    SELECT
      m.path AS module,
      s.name AS symbol,
      s.local_name
    FROM symbols s
    JOIN modules m ON s.module_id = m.id
    WHERE s.kind = 'export'
    ORDER BY m.path, s.name;

    CREATE VIEW imports AS
    SELECT
      m.path AS module,
      s.name AS symbol,
      s.source_specifier,
      COALESCE(t.path, '<unresolved>') AS resolves_to
    FROM symbols s
    JOIN modules m ON s.module_id = m.id
    LEFT JOIN modules t ON s.target_module_id = t.id
    WHERE s.kind = 'import'
    ORDER BY m.path, s.name;

    CREATE VIEW unresolved_symbols AS
    SELECT
      m.path AS module,
      s.name AS symbol,
      s.source_specifier
    FROM symbols s
    JOIN modules m ON s.module_id = m.id
    WHERE s.kind = 'import' AND s.target_module_id IS NULL;

    -- Materialized pure JS bundle table and view
    CREATE TABLE js_bundle (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL
    );

    CREATE VIEW js_output AS
    SELECT code FROM js_bundle WHERE id = 1;

    -- Static assets and stylesheets table (ELF segments BLOB equivalent)
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      content BLOB NOT NULL
    );
  `);

  // Insert Metadata
  const entryRecord = modulesByPath.get(entryPath);
  const insertMeta = db.prepare('INSERT INTO bundle_meta (key, value) VALUES (?, ?)');
  insertMeta.run('entry_point', entryRecord.relPath);
  insertMeta.run('entry_id', String(entryRecord.id));
  insertMeta.run('bundle_name', bundleName);
  insertMeta.run('bundler', 'SQLBundle v1.0 (SELF-JS)');
  insertMeta.run('created_at', new Date().toISOString());

  // Insert Modules
  const insertModule = db.prepare(
    'INSERT INTO modules (id, path, code, type, is_entry, size) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const mod of modulesByPath.values()) {
    insertModule.run(mod.id, mod.relPath, mod.code, mod.type, mod.isEntry, mod.size);
  }

  // Insert Dependencies
  const insertDep = db.prepare(
    'INSERT INTO dependencies (importer_id, specifier, resolved_module_id) VALUES (?, ?, ?)'
  );
  for (const dep of rawDependencies) {
    const resolvedMod = dep.resolvedPath ? modulesByPath.get(dep.resolvedPath) : null;
    insertDep.run(dep.importerId, dep.specifier, resolvedMod ? resolvedMod.id : null);
  }

  // Insert Symbols
  const insertSym = db.prepare(
    'INSERT INTO symbols (module_id, name, kind, local_name, source_specifier, target_module_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const sym of rawSymbols) {
    let targetModuleId = null;
    if (sym.targetPath && modulesByPath.has(sym.targetPath)) {
      targetModuleId = modulesByPath.get(sym.targetPath).id;
    }
    insertSym.run(sym.moduleId, sym.name, sym.kind, sym.localName, sym.sourceSpecifier, targetModuleId);
  }

  // Insert Assets
  const insertAsset = db.prepare(
    'INSERT INTO assets (path, type, size, content) VALUES (?, ?, ?, ?)'
  );
  for (const asset of rawAssets) {
    insertAsset.run(asset.path, asset.type, asset.size, asset.content);
  }

  // Materialize pure JS bundle directly from SQLite relations
  const materializedJs = materializeJs(db);
  db.prepare('INSERT INTO js_bundle (id, code) VALUES (1, ?)').run(materializedJs);
  fs.writeFileSync(outJs, materializedJs, 'utf8');

  db.close();

  // Read the generated SQLite database buffer
  const sqliteBuffer = fs.readFileSync(outSqlite);

  // Generate browser HTML executable with Dual Engine support
  const htmlContent = generateBrowserHtml(sqliteBuffer, bundleName, materializedJs, modulesByPath.size);
  fs.writeFileSync(outHtml, htmlContent, 'utf8');

  // Generate ultra-lightweight production HTML (0 Wasm, 2 KB)
  const prodHtml = outHtml.replace(/\.html$/, '.prod.html');
  fs.writeFileSync(prodHtml, generateProdHtml(materializedJs, bundleName), 'utf8');

  // Also write bootstrap content into the SQLite database for self-describing bundle
  const dbReopen = new DatabaseSync(outSqlite);
  dbReopen.prepare('INSERT INTO _bootstrap (id, content) VALUES (1, ?)').run(htmlContent);
  dbReopen.close();

  return {
    sqlitePath: outSqlite,
    htmlPath: outHtml,
    prodHtmlPath: prodHtml,
    jsPath: outJs,
    stats: {
      moduleCount: modulesByPath.size,
      dependencyCount: rawDependencies.length,
      symbolCount: rawSymbols.length,
      assetCount: rawAssets.length,
      sqliteSize: sqliteBuffer.length,
      jsSize: Buffer.byteLength(materializedJs, 'utf8')
    }
  };
}

module.exports = {
  build
};
