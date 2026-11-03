/**
 * A compile worker: reads and transforms one module per message.
 * The main thread does resolution and owns the database.
 */
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { transformModule } from './transform.js';

parentPort.on('message', ({ job, file, id }) => {
  try {
    parentPort.postMessage({ job, result: transformModule(fs.readFileSync(file, 'utf8'), id) });
  } catch (err) {
    parentPort.postMessage({ job, error: err.message });
  }
});
