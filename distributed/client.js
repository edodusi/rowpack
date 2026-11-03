/**
 * The client side of distributed compiling: a `compiler` for build() that
 * reads each module locally and ships its source to a remote function, like
 * distcc ships preprocessed files. Requests are batched and capped in flight.
 */
import fs from 'node:fs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { Agent } from 'undici';

/** Classic Lambda: one Invoke call per batch. */
export function lambdaSend({ functionName, region, maxSockets = 1024 }) {
  const client = new LambdaClient({
    region,
    maxAttempts: 1, // retries are ours, so they are counted
    requestHandler: new NodeHttpHandler({ httpsAgent: { maxSockets, keepAlive: true } }),
  });
  return async (modules) => {
    try {
      const res = await client.send(new InvokeCommand({ FunctionName: functionName, Payload: JSON.stringify({ modules }) }));
      const body = JSON.parse(Buffer.from(res.Payload).toString('utf8'));
      if (res.FunctionError) throw new Error(`${res.FunctionError}: ${body.errorMessage}`);
      return body;
    } catch (err) {
      if (err.name === 'TooManyRequestsException') err.retryable = true;
      throw err;
    }
  };
}

/** Lambda Web Function with IamAuth: a SigV4-signed HTTPS POST per batch. */
export function webSend({ domain, region }) {
  const signer = new SignatureV4({ service: 'lambda', region, credentials: defaultProvider(), sha256: Sha256 });
  const dispatcher = new Agent({ connections: 1024, pipelining: 0, keepAliveTimeout: 30_000 });
  return async (modules) => {
    const body = JSON.stringify({ modules });
    const hash = Buffer.from(await new Sha256().update(body).digest()).toString('hex');
    const signed = await signer.sign({
      method: 'POST',
      protocol: 'https:',
      hostname: domain,
      path: '/compile',
      headers: { host: domain, 'content-type': 'application/json', 'x-amz-content-sha256': hash },
      body,
    });
    const res = await fetch(`https://${domain}/compile`, { method: 'POST', headers: signed.headers, body, dispatcher });
    if (res.status === 429 || res.status === 503) {
      await res.body?.cancel();
      throw Object.assign(new Error(`HTTP ${res.status} ${res.headers.get('lambda-web-error-type') || ''}`), { retryable: true });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };
}

const MAX_BATCH_BYTES = 1_500_000; // keeps request and response well under Lambda's 6 MB

/**
 * @param {object} o
 * @param {(modules: Array<{key, id, source}>) => Promise<{ results: Array<{key, result?, error?}>, computeMs?: number, environment?: object }>} o.send
 * @param {number} [o.batch]        modules per request
 * @param {number} [o.concurrency]  requests in flight
 */
export function remoteCompiler({ send, batch = 1, concurrency = 8 }) {
  const queue = [];
  const waiting = new Map();
  let key = 0;
  let inFlight = 0;
  let scheduled = false;
  const stats = { requests: 0, modules: 0, bytesUp: 0, computeMs: 0, rounds: 0, environments: new Set(), peakInFlight: 0, retries: 0 };

  const pump = () => {
    scheduled = false;
    if (queue.length) stats.rounds++;
    while (queue.length && inFlight < concurrency) {
      const items = [];
      let bytes = 0;
      while (queue.length && items.length < batch && (items.length === 0 || bytes + queue[0].source.length < MAX_BATCH_BYTES)) {
        const m = queue.shift();
        bytes += m.source.length;
        items.push(m);
      }
      inFlight++;
      stats.peakInFlight = Math.max(stats.peakInFlight, inFlight);
      stats.requests++;
      stats.modules += items.length;
      stats.bytesUp += bytes;
      sendWithRetry(items)
        .then((res) => {
          stats.computeMs += res.computeMs || 0;
          const env = res.environment;
          if (env) stats.environments.add(env.envId ?? env.coldAt);
          for (const r of res.results) {
            const w = waiting.get(r.key);
            waiting.delete(r.key);
            if (r.error) w.reject(new Error(r.error));
            else w.resolve(r.result);
          }
        })
        .catch((err) => items.forEach((m) => waiting.get(m.key)?.reject(err)))
        .finally(() => {
          inFlight--;
          schedule();
        });
    }
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(pump); // let the graph walk enqueue everything it just found
    }
  };

  // throttling (HTTP 429, TooManyRequestsException) is retried with backoff and jitter
  async function sendWithRetry(items, attempt = 0) {
    try {
      return await send(items);
    } catch (err) {
      if (err.retryable && attempt < 8) {
        stats.retries++;
        await new Promise((r) => setTimeout(r, Math.random() * 50 * 2 ** attempt));
        return sendWithRetry(items, attempt + 1);
      }
      throw err;
    }
  }

  return {
    stats,
    run(file, id) {
      const k = key++;
      return new Promise((resolve, reject) => {
        waiting.set(k, { resolve, reject });
        queue.push({ key: k, id, source: fs.readFileSync(file, 'utf8') });
        schedule();
      });
    },
    close() {},
  };
}
