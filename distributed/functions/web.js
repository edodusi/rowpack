// Lambda Web Function: a plain HTTP server. One environment serves many
// requests at once, but compiling is CPU work on one event loop, so with
// THREADS=1 concurrent requests just queue. THREADS=auto spreads them over a
// worker_threads pool, one thread per vCPU the environment has.
import http from 'node:http';
import os from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { compileBatch } from './compile.js';

if (!isMainThread) {
  parentPort.on('message', ({ job, modules, format }) => parentPort.postMessage({ job, ...compileBatch(modules, format) }));
} else {
  const threads = process.env.THREADS === 'auto' ? os.availableParallelism() : 1;
  const envId = Math.random().toString(36).slice(2, 8);
  let inFlight = 0;
  let peakInFlight = 0;

  let compile = async (modules, format) => compileBatch(modules, format);
  if (threads > 1) {
    const workers = Array.from({ length: threads }, () => ({ w: new Worker(fileURLToPath(import.meta.url)), busy: 0 }));
    const waiting = new Map();
    let next = 0;
    for (const slot of workers) {
      slot.w.on('message', ({ job, ...out }) => {
        slot.busy--;
        waiting.get(job)(out);
        waiting.delete(job);
      });
    }
    compile = (modules, format) => new Promise((done) => {
      const slot = workers.reduce((a, b) => (b.busy < a.busy ? b : a));
      slot.busy++;
      const job = next++;
      waiting.set(job, done);
      slot.w.postMessage({ job, modules, format });
    });
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ envId, threads, cpus: os.availableParallelism() }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/compile') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        const { modules, format } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const out = await compile(modules, format);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...out, environment: { envId, threads, inFlight, peakInFlight } }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } finally {
        inFlight--;
      }
    });
  });

  // Lambda says where to listen; locally this binds to loopback only.
  const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:3000').split(':');
  server.listen(Number(port), host, () => console.log(`rowpack compile server ${envId} on ${host}:${port}, ${threads} thread(s)`));
}
