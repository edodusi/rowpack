/**
 * Everything that makes the bundle a database: the schema, the linker and the
 * tree-shaker. The linker and the tree-shaker are plain SQL, so they also run
 * in the sqlite3 CLI against any bundle.
 */

export const APPLICATION_ID = 0x524f5750; // "ROWP"
export const SCHEMA_VERSION = 1;

export const SCHEMA = `
PRAGMA application_id = ${APPLICATION_ID};
PRAGMA user_version = ${SCHEMA_VERSION};

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- text assets are stored as TEXT, binary ones as BLOB: same column, SQLite does not mind
CREATE TABLE assets (
  id      INTEGER PRIMARY KEY,
  mime    TEXT NOT NULL,
  content ANY NOT NULL
) STRICT;

CREATE TABLE modules (
  id       INTEGER PRIMARY KEY,
  path     TEXT NOT NULL UNIQUE,
  format   TEXT NOT NULL CHECK (format IN ('esm', 'cjs', 'json', 'css', 'text', 'url')),
  is_entry INTEGER NOT NULL DEFAULT 0,
  asset_id INTEGER REFERENCES assets(id)
) STRICT;

-- top-level statements: the unit of tree-shaking
CREATE TABLE statements (
  module_id INTEGER NOT NULL REFERENCES modules(id),
  idx       INTEGER NOT NULL,
  code      TEXT NOT NULL,
  pure      INTEGER NOT NULL,
  PRIMARY KEY (module_id, idx)
) STRICT, WITHOUT ROWID;

-- which statement declares each module-scope binding
CREATE TABLE bindings (
  module_id INTEGER NOT NULL,
  name      TEXT NOT NULL,
  stmt_idx  INTEGER NOT NULL,
  PRIMARY KEY (module_id, name)
) STRICT, WITHOUT ROWID;

-- which bindings each statement reads: local ones, or an export of a dependency
CREATE TABLE refs (
  module_id INTEGER NOT NULL,
  stmt_idx  INTEGER NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('local', 'import')),
  name      TEXT NOT NULL,           -- '*' means the whole namespace
  dep_idx   INTEGER
) STRICT;
CREATE INDEX refs_by_stmt ON refs (module_id, stmt_idx);

CREATE TABLE dependencies (
  importer_id INTEGER NOT NULL REFERENCES modules(id),
  idx         INTEGER NOT NULL,
  specifier   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('static', 'dynamic', 'require')),
  resolved_id INTEGER REFERENCES modules(id),
  PRIMARY KEY (importer_id, idx)
) STRICT, WITHOUT ROWID;
CREATE INDEX dependencies_by_target ON dependencies (resolved_id);

-- exports as written in the source
CREATE TABLE exports (
  module_id     INTEGER NOT NULL,
  name          TEXT NOT NULL,      -- '*' for "export * from"
  kind          TEXT NOT NULL CHECK (kind IN ('local', 'indirect', 'star')),
  local_name    TEXT,
  dep_idx       INTEGER,
  imported_name TEXT
) STRICT;
CREATE INDEX exports_by_module ON exports (module_id, name);

-- exports after linking: every visible name points at the binding that owns it.
-- origin_local NULL means "the namespace object of origin_id".
CREATE TABLE linked_exports (
  module_id    INTEGER NOT NULL,
  name         TEXT NOT NULL,
  origin_id    INTEGER NOT NULL,
  origin_local TEXT,
  PRIMARY KEY (module_id, name)
) STRICT, WITHOUT ROWID;

-- the loader, so the bundle carries the code that runs it
CREATE TABLE runtime (name TEXT PRIMARY KEY, code TEXT NOT NULL) STRICT, WITHOUT ROWID;

-- the module factory body, assembled on read: export getters, imports, statements
CREATE VIEW module_code AS
SELECT m.id AS id,
  CASE WHEN m.format = 'esm' THEN '"use strict";' || char(10) ELSE '' END ||
  coalesce('__export({ ' || (
    SELECT group_concat(json_quote(l) || ': () => ' || l, ', ')
    FROM (SELECT DISTINCT local_name AS l FROM exports e WHERE e.module_id = m.id AND e.kind = 'local')
  ) || ' });' || char(10), '') ||
  coalesce((
    SELECT 'const ' || group_concat('__rp_i' || d.idx || ' = __import(' || d.idx || ')', ', ' ORDER BY d.idx) || ';' || char(10)
    FROM dependencies d WHERE d.importer_id = m.id AND d.kind = 'static'
  ), '') ||
  coalesce((SELECT group_concat(s.code, char(10) ORDER BY s.idx) FROM statements s WHERE s.module_id = m.id), '')
  AS code
FROM modules m WHERE m.format IN ('esm', 'cjs');

-- the dynamic linker's view of a module: one row, one query per module load
CREATE VIEW module_records AS
SELECT m.id, m.path, m.format,
  CASE WHEN m.format IN ('esm', 'cjs') THEN c.code END AS code,
  (SELECT json_group_object(CAST(d.idx AS TEXT), d.resolved_id) FROM dependencies d WHERE d.importer_id = m.id) AS deps,
  (SELECT json_group_array(json_array(x.name, x.origin_id, x.origin_local))
     FROM (SELECT * FROM linked_exports x WHERE x.module_id = m.id ORDER BY x.name) x) AS exports,
  a.mime, a.content
FROM modules m
LEFT JOIN module_code c ON c.id = m.id
LEFT JOIN assets a ON a.id = m.asset_id;

-- ldd(1)
CREATE VIEW ldd AS
SELECT i.path AS importer, d.specifier, d.kind, coalesce(t.path, '<unresolved>') AS resolves_to
FROM dependencies d JOIN modules i ON i.id = d.importer_id LEFT JOIN modules t ON t.id = d.resolved_id
ORDER BY i.path, d.idx;

-- nm -D
CREATE VIEW symbols AS
SELECT m.path AS module, x.name AS export, o.path AS defined_in, coalesce(x.origin_local, '<namespace>') AS binding
FROM linked_exports x JOIN modules m ON m.id = x.module_id JOIN modules o ON o.id = x.origin_id
ORDER BY m.path, x.name;

-- the link errors Node would throw as SyntaxError
CREATE VIEW unresolved_imports AS
SELECT DISTINCT m.path AS module, r.name AS import, t.path AS from_module
FROM refs r
JOIN modules m ON m.id = r.module_id
JOIN dependencies d ON d.importer_id = r.module_id AND d.idx = r.dep_idx
JOIN modules t ON t.id = d.resolved_id
WHERE r.kind = 'import' AND r.name <> '*' AND t.format <> 'cjs'
  AND NOT EXISTS (SELECT 1 FROM linked_exports x WHERE x.module_id = t.id AND x.name = r.name);

-- a module's size as it will be shipped
CREATE VIEW module_sizes AS
SELECT m.path, m.format,
  coalesce(length(CAST(c.code AS BLOB)), 0) + coalesce(length(CAST(a.content AS BLOB)), 0) AS bytes
FROM modules m LEFT JOIN module_code c ON c.id = m.id LEFT JOIN assets a ON a.id = m.asset_id
ORDER BY bytes DESC;
`;

/**
 * ESM linking (spec "ResolveExport"): follow re-export chains and "export *"
 * to the binding that owns each name. Names reached through two stars that
 * end in different bindings are ambiguous and left out, as the spec requires.
 */
export const LINK = `
DELETE FROM linked_exports;
WITH RECURSIVE
names(module_id, name, target_id, target_key, via_star) AS (
  SELECT e.module_id, e.name,
         CASE e.kind WHEN 'local' THEN e.module_id ELSE d.resolved_id END,
         CASE WHEN e.kind = 'local' THEN 'L:' || e.local_name
              WHEN e.imported_name = '*' THEN 'N'
              ELSE 'E:' || e.imported_name END,
         0
  FROM exports e
  LEFT JOIN dependencies d ON d.importer_id = e.module_id AND d.idx = e.dep_idx
  WHERE e.kind IN ('local', 'indirect')
  UNION
  SELECT s.module_id, n.name, n.module_id, 'E:' || n.name, 1
  FROM exports s
  JOIN dependencies d ON d.importer_id = s.module_id AND d.idx = s.dep_idx
  JOIN names n ON n.module_id = d.resolved_id
  WHERE s.kind = 'star' AND n.name <> 'default'
    AND NOT EXISTS (SELECT 1 FROM exports o WHERE o.module_id = s.module_id AND o.name = n.name AND o.kind <> 'star')
),
resolved(module_id, name, via_star, target_id, target_key) AS (
  SELECT module_id, name, via_star, target_id, target_key FROM names
  UNION
  SELECT r.module_id, r.name, r.via_star, n.target_id, n.target_key
  FROM resolved r
  JOIN names n ON n.module_id = r.target_id AND n.name = substr(r.target_key, 3)
  WHERE r.target_key LIKE 'E:%'
),
final AS (
  SELECT DISTINCT module_id, name, target_id, target_key FROM resolved
  WHERE target_key NOT LIKE 'E:%' AND target_id IS NOT NULL
)
INSERT INTO linked_exports (module_id, name, origin_id, origin_local)
SELECT module_id, name, min(target_id), CASE WHEN min(target_key) = 'N' THEN NULL ELSE substr(min(target_key), 3) END
FROM final
GROUP BY module_id, name
HAVING count(*) = 1;
`;

/**
 * Tree-shaking. Two kinds of node in one recursive walk:
 *   ('s', module, idx)  a statement that must stay
 *   ('u', module, name) an export someone reads ('*' = all of them)
 * Roots are statements with side effects and everything the entry exports.
 */
export const TREE_SHAKE = `
CREATE TEMP TABLE live AS
WITH RECURSIVE
node(kind, module_id, key) AS (
  SELECT 's', module_id, CAST(idx AS TEXT) FROM statements WHERE pure = 0
  UNION
  SELECT 'u', id, '*' FROM modules WHERE is_entry = 1
  UNION
  -- a live statement keeps the local declarations it reads
  SELECT 's', b.module_id, CAST(b.stmt_idx AS TEXT)
  FROM node n
  JOIN refs r ON n.kind = 's' AND r.module_id = n.module_id AND r.stmt_idx = CAST(n.key AS INTEGER) AND r.kind = 'local'
  JOIN bindings b ON b.module_id = r.module_id AND b.name = r.name
  UNION
  -- ... and uses the dependency exports it reads
  SELECT 'u', d.resolved_id, r.name
  FROM node n
  JOIN refs r ON n.kind = 's' AND r.module_id = n.module_id AND r.stmt_idx = CAST(n.key AS INTEGER) AND r.kind = 'import'
  JOIN dependencies d ON d.importer_id = r.module_id AND d.idx = r.dep_idx
  WHERE d.resolved_id IS NOT NULL
  UNION
  -- a used export keeps the statement declaring its binding
  SELECT 's', b.module_id, CAST(b.stmt_idx AS TEXT)
  FROM node n
  JOIN linked_exports x ON n.kind = 'u' AND x.module_id = n.module_id AND (n.key = '*' OR x.name = n.key)
  JOIN bindings b ON b.module_id = x.origin_id AND b.name = x.origin_local
  UNION
  -- a used namespace re-export uses everything in it
  SELECT 'u', x.origin_id, '*'
  FROM node n
  JOIN linked_exports x ON n.kind = 'u' AND x.module_id = n.module_id AND (n.key = '*' OR x.name = n.key)
  WHERE x.origin_local IS NULL
  UNION
  -- a used re-export means its owner module's namespace must exist
  SELECT 'u', x.origin_id, x.origin_local
  FROM node n
  JOIN linked_exports x ON n.kind = 'u' AND x.module_id = n.module_id AND (n.key = '*' OR x.name = n.key)
  WHERE x.origin_local IS NOT NULL AND x.origin_id <> x.module_id
)
SELECT * FROM node;

-- modules that do something or are read from, plus every module on the way to one
CREATE TEMP TABLE keep AS
WITH RECURSIVE k(id) AS (
  SELECT DISTINCT module_id FROM temp.live
  UNION SELECT id FROM modules WHERE format IN ('cjs', 'css') OR is_entry = 1
  UNION
  SELECT d.importer_id FROM dependencies d JOIN k ON d.resolved_id = k.id WHERE d.kind <> 'dynamic'
)
SELECT DISTINCT id FROM k;

DELETE FROM statements WHERE NOT EXISTS (SELECT 1 FROM temp.live l WHERE l.kind = 's' AND l.module_id = statements.module_id AND l.key = CAST(statements.idx AS TEXT));
DELETE FROM refs WHERE NOT EXISTS (SELECT 1 FROM statements s WHERE s.module_id = refs.module_id AND s.idx = refs.stmt_idx);
DELETE FROM bindings WHERE NOT EXISTS (SELECT 1 FROM statements s WHERE s.module_id = bindings.module_id AND s.idx = bindings.stmt_idx);
DELETE FROM exports WHERE kind = 'local' AND module_id IN (SELECT id FROM modules WHERE format = 'esm') AND NOT EXISTS (SELECT 1 FROM bindings b WHERE b.module_id = exports.module_id AND b.name = exports.local_name);

DELETE FROM modules WHERE id NOT IN (SELECT id FROM temp.keep);
DELETE FROM statements WHERE module_id NOT IN (SELECT id FROM modules);
DELETE FROM refs WHERE module_id NOT IN (SELECT id FROM modules);
DELETE FROM bindings WHERE module_id NOT IN (SELECT id FROM modules);
DELETE FROM exports WHERE module_id NOT IN (SELECT id FROM modules);
DELETE FROM dependencies WHERE importer_id NOT IN (SELECT id FROM modules) OR resolved_id NOT IN (SELECT id FROM modules);
DELETE FROM assets WHERE id NOT IN (SELECT asset_id FROM modules WHERE asset_id IS NOT NULL);

DROP TABLE temp.live;
DROP TABLE temp.keep;
`;
