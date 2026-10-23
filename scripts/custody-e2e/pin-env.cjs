/**
 * Preload for the dev server during the custody browser walk. Keeps every
 * transaction on a local GIWA fork.
 *
 * web/lib/supabase.ts reloads web/.env.local with override, so a GIWA_RPC set
 * in the shell would be replaced by the live one. This pins the listed keys:
 * process.env becomes a Proxy that ignores writes to them. As a backstop, any
 * request from this process to a *.giwa.io host is refused outright.
 *
 * Loaded through NODE_OPTIONS so Next's worker processes get it too. Values
 * come from E2E_FORK_RPC, E2E_PILOT and E2E_DELEGATE. Test use only.
 */

const PINNED = {
  GIWA_RPC: process.env.E2E_FORK_RPC,
  CHAIN_GIWA_SEPOLIA_RPC: process.env.E2E_FORK_RPC,
  CUSTODY_PILOT_ACCOUNTS: process.env.E2E_PILOT,
  CUSTODY_DELEGATE_ADDRESS: process.env.E2E_DELEGATE,
};
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(PINNED.GIWA_RPC))) throw new Error('E2E_FORK_RPC must be a local fork (http://127.0.0.1:<port>)');

const real = process.env;
for (const [k, v] of Object.entries(PINNED)) real[k] = v;
process.env = new Proxy(real, {
  set(target, key, value) {
    if (Object.prototype.hasOwnProperty.call(PINNED, key)) return true;
    target[key] = value;
    return true;
  },
  defineProperty(target, key, desc) {
    if (Object.prototype.hasOwnProperty.call(PINNED, key)) return true;
    return Reflect.defineProperty(target, key, desc);
  },
});

// Backstop: nothing in this process may reach the live GIWA network.
const LIVE = /(^|\.)giwa\.io$/i;
const hostOf = (input) => {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (input && typeof input.url === 'string') return new URL(input.url).hostname;
    if (input && (input.hostname || input.host)) return String(input.hostname || input.host).split(':')[0];
  } catch {
    // Not a URL this guard can read; the call goes on as normal.
  }
  return '';
};
for (const mod of ['http', 'https']) {
  const m = require(mod);
  for (const fn of ['request', 'get']) {
    const orig = m[fn];
    m[fn] = function guarded(input, ...rest) {
      if (LIVE.test(hostOf(input))) throw new Error(`custody e2e: blocked live request to ${hostOf(input)}`);
      return orig.call(this, input, ...rest);
    };
  }
}
if (typeof globalThis.fetch === 'function') {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (LIVE.test(hostOf(input))) return Promise.reject(new Error(`custody e2e: blocked live request to ${hostOf(input)}`));
    return origFetch(input, init);
  };
}
