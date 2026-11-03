/**
 * SQL-Driven Dynamic Module Linker.
 * Resolves dependencies, loads module code, and verifies symbol exports
 * directly against the SQLite bundle database.
 */

class SQLLinker {
  /**
   * @param {object} dbAdapter - Adapter providing `all(sql, params)` and `run(sql, params)`
   * @param {object} [options] - Additional options (e.g. custom globals, logger)
   */
  constructor(dbAdapter, options = {}) {
    this.db = dbAdapter;
    this.options = options;
    this.moduleCache = new Map();
    this.stats = {
      modulesLoaded: 0,
      sqlQueriesExecuted: 0
    };
  }

  /**
   * Execute a SQL query that returns rows.
   */
  query(sql, params = []) {
    this.stats.sqlQueriesExecuted++;
    return this.db.all(sql, params);
  }

  /**
   * Get application metadata from `bundle_meta`.
   */
  getMeta(key) {
    const rows = this.query('SELECT value FROM bundle_meta WHERE key = ?', [key]);
    return rows.length > 0 ? rows[0].value : null;
  }

  /**
   * Load and execute a module by ID.
   * Performs resolution and linking via SQL.
   */
  requireModule(moduleId) {
    if (this.moduleCache.has(moduleId)) {
      return this.moduleCache.get(moduleId).exports;
    }

    // Query module code and path
    const moduleRows = this.query(
      'SELECT id, path, code, is_entry FROM modules WHERE id = ?',
      [moduleId]
    );

    if (moduleRows.length === 0) {
      throw new Error(`[LinkError] Module ID ${moduleId} not found in bundle database.`);
    }

    const modRecord = moduleRows[0];

    // Pre-query dependency table (ELF DT_NEEDED equivalent)
    const depRows = this.query(
      'SELECT specifier, resolved_module_id FROM dependencies WHERE importer_id = ?',
      [moduleId]
    );

    const depMap = new Map();
    for (const dep of depRows) {
      depMap.set(dep.specifier, dep.resolved_module_id);
    }

    const moduleObj = {
      id: moduleId,
      path: modRecord.path,
      exports: {}
    };

    // Cache early to support circular dependencies
    this.moduleCache.set(moduleId, moduleObj);
    this.stats.modulesLoaded++;

    // Scoped require for this module
    const localRequire = (specifier) => {
      let targetId = depMap.get(specifier);

      // Fallback SQL query in case dependencies were dynamically patched in SQLite
      if (targetId == null) {
        const dynamicLookup = this.query(
          'SELECT resolved_module_id FROM dependencies WHERE importer_id = ? AND specifier = ?',
          [moduleId, specifier]
        );
        if (dynamicLookup.length > 0) {
          targetId = dynamicLookup[0].resolved_module_id;
        }
      }

      if (targetId == null) {
        throw new Error(
          `[LinkError] Symbol resolution failure: Cannot resolve "${specifier}" imported by "${modRecord.path}" (ID ${moduleId}).`
        );
      }

      return this.requireModule(targetId);
    };

    // Provide __sql access to module code
    const sqlAccess = (query, params = []) => {
      return this.query(query, params);
    };

    // Dynamic import() support
    localRequire.import = (specifier) => {
      return Promise.resolve(localRequire(specifier));
    };

    // Compile and execute the closure
    try {
      const moduleFactory = new Function(
        'module',
        'exports',
        'require',
        '__sql',
        '__module',
        '__exports',
        '__require',
        modRecord.code
      );
      moduleFactory(moduleObj, moduleObj.exports, localRequire, sqlAccess, moduleObj, moduleObj.exports, localRequire);
    } catch (err) {
      throw new Error(
        `[RuntimeError] Execution failed in module "${modRecord.path}" (ID ${moduleId}): ${err.message}\n` +
        err.stack
      );
    }

    return moduleObj.exports;
  }

  /**
   * Run the bundle entry point.
   */
  executeEntry() {
    const entryIdStr = this.getMeta('entry_id');
    if (!entryIdStr) {
      // Fallback: check module marked is_entry
      const entryRows = this.query('SELECT id FROM modules WHERE is_entry = 1 LIMIT 1');
      if (entryRows.length === 0) {
        throw new Error('[LinkError] No entry module defined in bundle_meta or modules table.');
      }
      return this.requireModule(entryRows[0].id);
    }

    const entryId = parseInt(entryIdStr, 10);
    return this.requireModule(entryId);
  }
}

/**
 * Creates an adapter for Node's `DatabaseSync` (node:sqlite).
 */
function createNodeDbAdapter(databaseSync) {
  return {
    all(sql, params = []) {
      const stmt = databaseSync.prepare(sql);
      return stmt.all(...params);
    },
    run(sql, params = []) {
      const stmt = databaseSync.prepare(sql);
      return stmt.run(...params);
    }
  };
}

/**
 * Creates an adapter for sql.js (WebAssembly SQLite).
 */
function createSqlJsDbAdapter(sqlJsDatabase) {
  return {
    all(sql, params = []) {
      const stmt = sqlJsDatabase.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      stmt.free();
      return rows;
    },
    run(sql, params = []) {
      sqlJsDatabase.run(sql, params);
    }
  };
}

module.exports = {
  SQLLinker,
  createNodeDbAdapter,
  createSqlJsDbAdapter
};
