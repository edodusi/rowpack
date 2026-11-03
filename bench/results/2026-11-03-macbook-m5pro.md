# Benchmark 2026-11-03

Apple M5 Pro (18 cores), Darwin 25.6.0, Node v26.10.0, esbuild 0.28.2, Chrome 156.0.8078.80. Medians.

## todomvc

Modules after tree-shaking: 53 of 53; statements: 80 of 81.

| Build | ms |
|---|---:|
| rowpack, .sqlite only (warm) | 31.9 |
| rowpack, .sqlite only, 8 compile workers (warm) | 70.1 |
| rowpack, .sqlite + static JS (warm) | 34.6 |
| esbuild (warm, in-process) | 14.1 |
| rowpack, cold CLI | 107.1 |
| esbuild, cold CLI | 22.2 |
| prototype (its own timer) | 172.2 |

| Output | raw KB | gzip KB | brotli KB |
|---|---:|---:|---:|
| esbuild | 754.3 | 273.2 | 247.6 |
| rowpack_static | 792.4 | 281.6 | 254.6 |
| rowpack_dynamic | 809.3 | 286.3 | 257.6 |
| esbuild_minified | 609.2 | 261.8 | 240.6 |
| rowpack_static_minified | 625.9 | 264.4 | 243.0 |
| rowpack_dynamic_minified | 641.0 | 267.9 | 245.1 |
| prototype_js | 1033.7 | 345.3 | 304.6 |
| page_esbuild | 754.7 | 272.5 | 249.4 |
| page_static | 792.8 | 281.8 | 254.8 |
| page_sql | 2055.3 | 797.9 | 672.2 |
| .sqlite bundle | 1216.0 | | |
| .sqlite bundle, stripped | 832.0 | | |
| prototype .sqlite | 8200.0 | | |

Chrome, app ready (ms after navigation start; single-file pages opened from disk):

| Page | ready | ready, 4x CPU slowdown |
|---|---:|---:|
| esbuild | 25.9 | 91.6 |
| static | 29.2 | 104.3 |
| dynamic | 30.7 | 107.2 |
| sql | 63.3 | 265.9 |

SQL page split: SQLite (decode + compile wasm, open db) 18.7 ms; one closure query 2.8 ms; compile 1.7 ms; link and run total 25.7 ms. With 4x CPU: 96.5 / 12.4 / 7.2 / 108.5.

## lodash-few

Modules after tree-shaking: 157 of 641; statements: 456 of 1927.

| Build | ms |
|---|---:|
| rowpack, .sqlite only (warm) | 129.1 |
| rowpack, .sqlite only, 8 compile workers (warm) | 106.4 |
| rowpack, .sqlite + static JS (warm) | 132.9 |
| esbuild (warm, in-process) | 63.6 |
| rowpack, cold CLI | 213.5 |
| esbuild, cold CLI | 82.4 |
| prototype (its own timer) | 2806.6 |

| Output | raw KB | gzip KB | brotli KB |
|---|---:|---:|---:|
| esbuild | 69.6 | 14.8 | 12.8 |
| rowpack_static | 68.9 | 15.8 | 13.7 |
| rowpack_dynamic | 114.6 | 20.7 | 17.3 |
| esbuild_minified | 24.5 | 9.7 | 8.5 |
| rowpack_static_minified | 24.4 | 9.5 | 8.3 |
| rowpack_dynamic_minified | 61.6 | 14.5 | 12.4 |
| prototype_js | 1135.8 | 164.4 | 106.2 |
| page_esbuild | 70.0 | 15.0 | 12.9 |
| page_static | 69.3 | 16.1 | 13.8 |
| page_sql | 1260.7 | 489.6 | 403.5 |
| .sqlite bundle | 488.0 | | |
| .sqlite bundle, stripped | 236.0 | | |
| prototype .sqlite | 8720.0 | | |

| Node, load + link + run | ms |
|---|---:|
| esbuild bundle | 0.2 |
| rowpack static | 0.2 |
| rowpack dynamic runtime | 0.5 |
| rowpack SQL engine (1 queries) | 1.2 |

Chrome, app ready (ms after navigation start; single-file pages opened from disk):

| Page | ready | ready, 4x CPU slowdown |
|---|---:|---:|
| esbuild | 10.0 | 31.1 |
| static | 8.6 | 31.7 |
| dynamic | 11.4 | 42.1 |
| sql | 39.8 | 171.3 |

SQL page split: SQLite (decode + compile wasm, open db) 13.8 ms; one closure query 2.9 ms; compile 1.0 ms; link and run total 13.4 ms. With 4x CPU: 72.6 / 12.1 / 4.2 / 54.1.

## lodash-all

Modules after tree-shaking: 641 of 641; statements: 1921 of 1921.

| Build | ms |
|---|---:|
| rowpack, .sqlite only (warm) | 120.1 |
| rowpack, .sqlite only, 8 compile workers (warm) | 101.8 |
| rowpack, .sqlite + static JS (warm) | 134.2 |
| esbuild (warm, in-process) | 59.1 |
| rowpack, cold CLI | 217.8 |
| esbuild, cold CLI | 76.0 |
| prototype (its own timer) | 2409.6 |

| Output | raw KB | gzip KB | brotli KB |
|---|---:|---:|---:|
| esbuild | 295.7 | 55.5 | 44.3 |
| rowpack_static | 297.3 | 59.2 | 47.7 |
| rowpack_dynamic | 497.8 | 79.9 | 55.4 |
| esbuild_minified | 95.7 | 35.2 | 30.2 |
| rowpack_static_minified | 101.7 | 35.4 | 30.6 |
| rowpack_dynamic_minified | 275.2 | 58.0 | 42.0 |
| prototype_js | 1135.4 | 164.3 | 106.2 |
| page_esbuild | 296.0 | 55.7 | 44.4 |
| page_static | 297.6 | 59.4 | 47.8 |
| page_sql | 2002.0 | 648.4 | 510.6 |
| .sqlite bundle | 1724.0 | | |
| .sqlite bundle, stripped | 792.0 | | |
| prototype .sqlite | 8720.0 | | |

| Node, load + link + run | ms |
|---|---:|
| esbuild bundle | 0.9 |
| rowpack static | 0.9 |
| rowpack dynamic runtime | 1.8 |
| rowpack SQL engine (1 queries) | 3.7 |

Chrome, app ready (ms after navigation start; single-file pages opened from disk):

| Page | ready | ready, 4x CPU slowdown |
|---|---:|---:|
| esbuild | 18.5 | 69.2 |
| static | 21.4 | 77.0 |
| dynamic | 30.0 | 118.6 |
| sql | 58.6 | 243.3 |

SQL page split: SQLite (decode + compile wasm, open db) 19.0 ms; one closure query 6.7 ms; compile 2.9 ms; link and run total 24.3 ms. With 4x CPU: 92.5 / 25.0 / 11.3 / 94.8.
