# rowpack

A toy JavaScript bundler whose output is a SQLite database.

Inspired by Farid Zakaria's post [Your executable is a SQLite database](https://fzakaria.com/2026/08/23/your-executable-is-a-sqlite-database), which asks what falls out if ELF were SQLite. rowpack asks the same of a JavaScript bundle: modules, statements, bindings, imports and exports are rows, and the linker, the tree-shaker and the patcher are SQL queries.

It is a toy. It is also correct on the things it claims, and the numbers below are measured, not estimated.

```sh
npm install
rowpack build demos/hello/index.js -o hello.sqlite --js hello.js --html hello.html --inspector
rowpack run hello.sqlite                      # the dynamic linker queries the database
node hello.js                                 # or run the statically linked script
sqlite3 hello.sqlite "SELECT * FROM ldd"      # or just look inside
```

## What is in the database

| Table or view | ELF analogy | What it holds |
|---|---|---|
| `modules`, `assets` | object files | one row per module; CSS, SVG, JSON and binaries as TEXT or BLOB |
| `statements` | `.text` | top-level statements, the unit of tree-shaking |
| `bindings`, `refs` | `.symtab` | which statement declares and reads which binding |
| `relocations` | `.rela` | every place code names a binding, by offset |
| `dependencies` | `DT_NEEDED` | import specifiers and what they resolved to |
| `exports`, `linked_exports` | `.dynsym` | exports as written, and after linking |
| `load_image` | program headers | what the loader reads, one row per module |
| `ldd`, `symbols`, `imports`, `unresolved_imports`, `module_sizes` | `ldd`, `nm` | views |

`PRAGMA application_id` is `0x524f5750` ("ROWP").

## What the SQL does

- **Linking** is the spec's ResolveExport as a recursive CTE: it follows re-export chains and `export *` to the binding that owns each name, and drops names that two stars make ambiguous.
- **Tree-shaking** is a second recursive CTE that walks from side effects and used exports through statement and binding rows. It honours `"sideEffects": false`. On lodash-es it keeps 157 of 641 modules and 456 of 1,927 statements, the same module set esbuild keeps.
- **Patching** (`rowpack patch --redirect` or `--replace`) changes rows in one transaction, relinks, and rolls back if anything no longer resolves.
- **The SQL engine** loads everything the entry needs with one recursive query and links it at runtime, in Node (`node:sqlite`) or in the browser ([sql.js](https://sql.js.org/)).
- **The static linker** turns the rows into one flat script: modules in ESM evaluation order in one scope, unique names, every relocation patched to a direct reference. That is the output you would ship.
- **strip** drops the link-edit tables. The bundle still runs and `ldd` still works.

## Correctness

The tests compare against Node's own ESM loader: live bindings, cycles, TDZ errors, `export *` conflicts, default export forms, evaluation order, shadowing, `import()`, namespace objects, string export names and JSON imports. Every fixture runs through the SQL engine, the static script and the dynamic script, with and without tree-shaking. TodoMVC Vanilla ES6 renders and behaves identically in headless Chrome whether esbuild or rowpack built it.

```sh
npm test                          # 149 tests
node demos/todomvc/prepare.js     # fetches TodoMVC (GPL-3.0, not vendored) for the browser test
```

## Numbers

Apple M5 Pro, Node 26, esbuild 0.28, Chrome 156. Medians. Full report in [`bench/results`](bench/results/), reproduce with `node bench/run.js`.

| | TodoMVC | lodash-es, 5 functions | lodash-es, all |
|---|---:|---:|---:|
| Build, rowpack (warm) | 32 ms | 129 ms | 120 ms |
| Build, esbuild (warm) | 14 ms | 64 ms | 59 ms |
| Build, original prototype | 172 ms | 2,807 ms | 2,410 ms |
| Minified + brotli, rowpack static | 243.0 KB | 8.3 KB | 30.6 KB |
| Minified + brotli, esbuild | 240.6 KB | 8.5 KB | 30.2 KB |
| Chrome app ready, esbuild | 26 ms | 10 ms | 19 ms |
| Chrome app ready, rowpack static | 29 ms | 9 ms | 21 ms |
| Chrome app ready, rowpack SQL engine | 63 ms | 40 ms | 59 ms |

Minified sizes use esbuild's minifier on both outputs, so the comparison is about bundling, not minification. TodoMVC's output is mostly a WAV file and SVGs. The SQL engine page also ships 688 KB of SQLite compiled to WebAssembly (sql.js 1.17), which takes 13 to 21 ms to start before any module is linked.

A rerun on 2026-11-25, after a dependency update (sql.js 1.17, Chrome 158), is in [`bench/results`](bench/results/) too. Sizes are identical, build times stay within run-to-run noise, and Chrome's app-ready times for the esbuild and static pages are 2 to 4 ms lower, so the table above still holds.

What this says: as a database, the bundle is a nice thing to query and a slow thing to boot. Linked statically, it is roughly as small and as fast as esbuild's output, and esbuild still builds about twice as fast.

## Limits

No source maps, no code splitting, no top-level await, no JSX or TypeScript, no minifier. CommonJS modules are wrapped, not tree-shaken. Static linking falls back to the dynamic runtime for `eval`, CommonJS requiring ESM, and `import()` of modules nothing imports statically.

## How this was built

The first prototype was written by an AI agent (Gemini in Antigravity). I then rewrote it with Kiro Crew as my assistant: a strict test suite against Node first, then fixes, then measured optimizations. The commit history starts from the untouched prototype so you can see the difference.

## License

MIT
