/**
 * Local step server for the Privy owner spike.
 *
 * Binds 127.0.0.1 only. Accepts POSTs only from the local spike page origin,
 * runs one step at a time (the relayer and delegate nonces are shared), and
 * returns error messages without stacks. Keys never leave this process.
 *
 * Run: node spikes/privy-owner/server/server.cjs
 */

const http = require('http');
const steps = require('./steps.cjs');
const { writeResults } = require('./results.cjs');

const PORT = 5175;
const ALLOWED_ORIGINS = new Set(['http://localhost:5174', 'http://127.0.0.1:5174']);
const MAX_BODY = 64 * 1024;

const ROUTES = {
  'GET /api/state': async () => steps.publicState(),
  'POST /api/s1/challenge': async () => steps.s1Challenge(),
  'POST /api/s1/verify': async (b) => steps.s1Verify(b),
  'POST /api/s2': async () => steps.s2Setup(),
  'POST /api/s3': async () => steps.s3Transfer(),
  'POST /api/s4/payload': async () => steps.s4Payload(),
  'POST /api/s4/verify': async (b) => steps.s4Verify(b),
  'POST /api/s5': async () => steps.s5Redeem(),
  'POST /api/s6/payload': async () => steps.s6Payload(),
  'POST /api/s6/submit': async (b) => steps.s6Submit(b),
  'POST /api/s7/payload': async () => steps.s7Payload(),
  'POST /api/s7/submit': async (b) => steps.s7Submit(b),
  'POST /api/s8': async () => steps.s8Check(),
  'POST /api/s9/verify': async (b) => steps.s9Verify(b),
};

let queue = Promise.resolve();
function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const server = http.createServer(async (req, res) => {
  const route = ROUTES[`${req.method} ${req.url}`];
  if (!route) return send(res, 404, { error: 'not found' });
  if (req.method === 'POST') {
    if (!ALLOWED_ORIGINS.has(req.headers.origin || '')) return send(res, 403, { error: 'origin not allowed' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 415, { error: 'expected application/json' });
    }
  }
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await serialize(async () => {
      const out = await route(body);
      writeResults(steps.loadState());
      return out;
    });
    if (result && result.status) console.log(`${req.url} ${result.status}`);
    send(res, 200, result);
  } catch (err) {
    console.log(`${req.url} error: ${err.shortMessage || err.message}`);
    send(res, 400, { error: err.shortMessage || err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`spike step server on http://127.0.0.1:${PORT}`);
});
