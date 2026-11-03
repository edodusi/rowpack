// Shared by both functions: compile a batch of modules. Pure CPU, no I/O.
import { transformModule } from '../../src/transform.js';

/** @param {Array<{ key: number, id: string, source: string }>} modules */
export function compileBatch(modules) {
  const t = performance.now();
  const results = modules.map(({ key, id, source }) => {
    try {
      return { key, result: transformModule(source, id) };
    } catch (err) {
      return { key, error: err.message };
    }
  });
  return { results, computeMs: performance.now() - t };
}
