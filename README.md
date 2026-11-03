# SQLBundle (SELF-JS) — "Your Executable is a SQLite Database"

An experimental JavaScript bundler inspired by Farid Zakaria's article [Your executable is a SQLite database](https://fzakaria.com/2026/08/23/your-executable-is-a-sqlite-database).

Instead of producing a monolithic JavaScript file with hardcoded module dictionaries (like Webpack, Rollup, or esbuild), **SQLBundle** compiles an ES6 module graph into a **first-class SQLite database**.

The output bundle:
- Is an authentic SQLite 3 database (`PRAGMA application_id = 0x53514c42`, ASCII `"SQLB"`).
- Stores modules, symbols, and dependencies in relational tables.
- Performs all dynamic linking, symbol lookup, and module resolution **via SQL queries**.
- Runs in **Node.js** (using native `node:sqlite`) and in **Web Browsers** (using embedded **SQLite WebAssembly** with zero external network dependencies).
- Can be inspected and manipulated using the standard `sqlite3` CLI tool.

---

## Conceptual Mapping: ELF vs. SQLBundle

| ELF / Standard Bundler Concept | SQLBundle SQLite Equivalent |
| :--- | :--- |
| ELF Header / Bundler Manifest | `bundle_meta` table (`entry_point`, `application_id`, `bundler`, etc.) |
| Object files / Chunks | `modules` table (`id`, `path`, `code`, `is_entry`, `size`) |
| `DT_NEEDED` (Dynamic libraries) | `dependencies` table (`importer_id`, `specifier`, `resolved_module_id`) |
| `.dynsym` / Symbol table | `symbols` table (`module_id`, `name`, `kind`, `local_name`) |
| `.hash` / `.gnu.hash` | SQLite B-tree indexes (`idx_modules_path`, `idx_deps_importer`, etc.) |
| `ldd` command | `CREATE VIEW ldd AS SELECT ...` |
| `nm -D` (exports & imports) | `CREATE VIEW exports` and `CREATE VIEW imports` |
| `strip(1)` / Tree-Shaking | `DELETE FROM modules WHERE id NOT IN (WITH RECURSIVE reachable...); VACUUM;` |
| `patchelf(1)` | `UPDATE dependencies SET resolved_module_id = ... WHERE specifier = ...;` |
| Linker lookup in code | `SELECT code FROM modules WHERE id = ?;` |
| Ahead-Of-Time Materialized Runtime | `CREATE VIEW js_output AS SELECT code FROM js_bundle;` |

---

## Installation & Quick Start

```bash
# Clone and install dependencies
npm install

# Run the test suite
npm test
```

### 1. Build an ES6 Project into SQLite

```bash
./bin/sqlbundle.js build demo-app/src/index.js -o dist/demo.sqlite --html dist/demo.html
```

This generates:
- `dist/demo.sqlite`: Pure SQLite database binary executable.
- `dist/demo.html`: Browser executable containing embedded SQLite WebAssembly runtime, the bundled database, and a live inspection HUD.

### 2. Inspect with Native `sqlite3` CLI

Because the bundle is an authentic SQLite database, you can query it with any SQLite client:

```bash
# View dynamic dependencies (ldd)
sqlite3 dist/demo.sqlite "SELECT * FROM ldd;"

# View exported symbols (nm -D)
sqlite3 dist/demo.sqlite "SELECT * FROM exports;"

# View application ID (0x53514c42 == 'SQLB')
xxd -s 64 -l 8 dist/demo.sqlite
```

### 3. Run in the Terminal (CLI)

```bash
./bin/sqlbundle.js run dist/demo.sqlite
```

### 4. Run in the Browser

Open `dist/demo.html` directly in any web browser, or serve it via any static HTTP server:

```bash
python3 -m http.server 8080 --directory dist
```

Navigate to `http://localhost:8080/demo.html`.
The page will:
1. Boot SQLite inside WebAssembly.
2. Query the SQLite database to resolve and link the ES6 modules.
3. Render the application UI.
4. Provide an interactive **SQLite HUD Inspector** with real-time logs, dependency graph (`ldd`), symbol table, and an interactive SQL query terminal!

---

## Bundler CLI Operations

### Tree-Shaking (`strip`)

Removes unreferenced modules and vacuums the database:

```bash
./bin/sqlbundle.js strip dist/demo.sqlite
```

### Dependency Hot-Patching (`patch`)

Redirects a dependency specifier in-place without rebuilding:

```bash
./bin/sqlbundle.js patch dist/demo.sqlite --redirect ./math.js=./mock_math.js
```

### Ad-hoc SQL Querying (`query`)

```bash
./bin/sqlbundle.js query dist/demo.sqlite "SELECT path, size FROM modules ORDER BY size DESC;"
```

---

## Combining SQLite Build with Blazing Fast Runtime Execution

To achieve Webpack/esbuild execution speeds without the runtime overhead of a WebAssembly SQL virtual machine, SQLBundle supports **Ahead-Of-Time Materialization**:

### 1. Zero-Overhead Pure JS Output
Every build automatically materializes a pure JavaScript bundle:
```bash
# Run pure JS bundle with native V8 O(1) performance (0 SQL queries)
node dist/demo.js

# Or run via CLI with --fast flag
./bin/sqlbundle.js run dist/demo.sqlite --fast
```

### 2. Extracting JS directly from SQLite CLI
Because the materialized code is stored directly in the database, you can extract a production-ready JavaScript bundle using standard `sqlite3`:
```bash
sqlite3 dist/demo.sqlite "SELECT code FROM js_output;" > production-bundle.js
```

### 3. Re-materializing after Hot-Patching
If you mutate dependencies in SQLite (`sqlbundle patch`), re-materialize the JS bundle in < 1ms:
```bash
./bin/sqlbundle.js emit-js dist/demo.sqlite -o dist/demo.js
```
