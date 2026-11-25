# Benchmark 2026-11-25

Apple M5 Pro (18 cores), Darwin 25.6.0, Node v26.10.0, esbuild 0.28.2, Chrome 158.0.8127.38. Medians.

## todomvc

Modules after tree-shaking: 53 of 53; statements: 80 of 81.

| Build | ms |
|---|---:|
| rowpack, .sqlite only (warm) | 31.1 |
| rowpack, .sqlite only, 8 compile workers (warm) | 66.2 |
| rowpack, .sqlite + static JS (warm) | 33.7 |
| esbuild (warm, in-process) | 13.9 |
| rowpack, cold CLI | 104.3 |
| esbuild, cold CLI | 22.8 |
| prototype (its own timer) | 161.7 |

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
| page_sql | 2075.2 | 804.2 | 679.1 |
| .sqlite bundle | 1216.0 | | |
| .sqlite bundle, stripped | 832.0 | | |
| prototype .sqlite | 8200.0 | | |

Chrome, app ready (ms after navigation start; single-file pages opened from disk):

| Page | ready | ready, 4x CPU slowdown |
|---|---:|---:|
| esbuild | 22.6 | 93.2 |
| static | 24.8 | 101.0 |
| dynamic | 26.1 | 108.5 |
| sql | 62.8 | 247.9 |

SQL page split: SQLite (decode + compile wasm, open db) 21.2 ms; one closure query 2.8 ms; compile 1.7 ms; link and run total 28.0 ms. With 4x CPU: 88.6 / 11.2 / 6.6 / 104.1.

## lodash-few

Modules after tree-shaking: 157 of 641; statements: 456 of 1927.

| Build | ms |
|---|---:|
| rowpack, .sqlite only (warm) | 142.1 |
| rowpack, .sqlite only, 8 compile workers (warm) | 103.0 |
| rowpack, .sqlite + static JS (warm) | 145.7 |
| esbuild (warm, in-process) | 67.7 |
| rowpack, cold CLI | 196.9 |
| esbuild, cold CLI | 73.0 |
| prototype (its own timer) | 2440.9 |

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
| page_sql | 1280.6 | 496.0 | 408.9 |
| .sqlite bundle | 488.0 | | |
| .sqlite bundle, stripped | 236.0 | | |
| prototype .sqlite | 8720.0 | | |

| Node, load + link + run | ms |
|---|---:|
| esbuild bundle | 0.2 |
| rowpack static | 0.2 |
| rowpack dynamic runtime | 0.5 |
| rowpack SQL engine (1 queries) | 1.1 |

Chrome, app ready (ms after navigation start; single-file pages opened from disk):

| Page | ready | ready, 4x CPU slowdown |
|---|---:|---:|
| esbuild | 8.3 | 33.8 |
| static | 7.9 | 34.5 |
| dynamic | 10.5 | 44.7 |
| sql | 38.8 | 177.0 |

SQL page split: SQLite (decode + compile wasm, open db) 13.6 ms; one closure query 2.8 ms; compile 1.1 ms; link and run total 13.6 ms. With 4x CPU: 75.3 / 12.0 / 4.3 / 55.4.

## lodash-all

Modules after tree-shaking: 641 of 641; statements: 1921 of 1921.

| Build | ms |
|---|---:|
| rowpack, .sqlite only (warm) | 134.0 |
| rowpack, .sqlite only, 8 compile workers (warm) | 108.6 |
| rowpack, .sqlite + static JS (warm) | 148.5 |
| esbuild (warm, in-process) | 62.3 |
| rowpack, cold CLI | 210.2 |
| esbuild, cold CLI | 71.9 |
| prototype (its own timer) | 2397.8 |

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
| page_sql | 2021.9 | 654.3 | 515.5 |
| .sqlite bundle | 1724.0 | | |
| .sqlite bundle, stripped | 792.0 | | |
| prototype .sqlite | 8720.0 | | |

| Node, load + link + run | ms |
|---|---:|
| esbuild bundle | 0.8 |
| rowpack static | 0.8 |
| rowpack dynamic runtime | 1.7 |
| rowpack SQL engine (1 queries) | 3.4 |

Chrome, app ready (ms after navigation start; single-file pages opened from disk):

| Page | ready | ready, 4x CPU slowdown |
|---|---:|---:|
| esbuild | 15.3 | 67.5 |
| static | 17.3 | 71.9 |
| dynamic | 26.8 | 112.1 |
| sql | 57.9 | 243.9 |

SQL page split: SQLite (decode + compile wasm, open db) 21.4 ms; one closure query 6.4 ms; compile 3.0 ms; link and run total 24.0 ms. With 4x CPU: 93.6 / 25.2 / 11.1 / 94.3.
