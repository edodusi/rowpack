// Shared by both functions: compile a batch of modules. Pure CPU, no I/O.
// format 'rows' returns the transform as JSON; format 'object' returns one
// SQLite object file per module (gzip, base64), for the bundler to ATTACH.
import zlib from 'node:zlib';
import { transformModule } from '../../src/transform.js';
import { compileObject } from '../../src/object.js';

/** @param {Array<{ key: number, id: string, source: string }>} modules */
export function compileBatch(modules, format = 'rows') {
  const t = performance.now();
  const results = modules.map(({ key, id, source }) => {
    try {
      // an object file is mostly empty page space: gzip takes 6 KB down to about 1 KB
      if (format === 'object') return { key, object: zlib.gzipSync(compileObject(source, id)).toString('base64') };
      return { key, result: transformModule(source, id) };
    } catch (err) {
      return { key, error: err.message };
    }
  });
  return { results, computeMs: performance.now() - t };
}
