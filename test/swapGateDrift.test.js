/**
 * Chat and site must agree on which swap tokens are verified.
 *
 * Chat asks for the unlock PIN on a trade the root lib/dex.js calls
 * unverified; the site warns on the same trades through web/lib/swapGate.ts.
 * web/ cannot import root lib/ on Vercel, so the rule exists twice. This pins
 * the verified set (native, WETH, FLZ) as identical on both sides: the same
 * addresses, read from the same env names, and the same answer for the same
 * trade.
 *
 * Run: node --test test/swapGateDrift.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const WEB_LIB = pathToFileURL(path.join(ROOT, 'web', 'lib') + path.sep).href;

// No database and no .env loading in this test.
const SUPABASE_STUB =
  'data:text/javascript,' +
  encodeURIComponent(
    'export function getSupabase(){throw new Error("no database in this test")}' +
      'export function getSiteConfig(){return {}}'
  );

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || '';
    if (parent.startsWith(WEB_LIB) && /^\.\/supabase(\.ts)?$/.test(specifier)) {
      return { url: SUPABASE_STUB, shortCircuit: true };
    }
    // Next resolves extensionless relative imports; plain node does not.
    if (parent.startsWith(WEB_LIB) && specifier.startsWith('.') && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, parent);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const ENV_NAMES = ['CHAIN_GIWA_SEPOLIA_WETH', 'CHAIN_GIWA_SEPOLIA_FLZ'];
const OTHER = '0x2222222222222222222222222222222222222222';

let chat;
let site;
let siteDex;

before(async () => {
  // Both sides fall back to literals when the env is unset. Those literals are
  // where drift would hide, so they are what gets compared.
  for (const name of ENV_NAMES) delete process.env[name];
  chat = require('../lib/dex');
  const server = await import('../web/lib/dexServer.ts');
  site = await import('../web/lib/swapGate.ts');
  siteDex = server.getDexAddresses();
});

describe('verified swap tokens, chat and site', () => {
  it('have the same WETH and FLZ addresses', () => {
    const chatDex = chat.getDexConfig('giwa_sepolia');
    assert.equal(chatDex.wrappedNative.toLowerCase(), siteDex.wrappedNative.toLowerCase());
    assert.equal(chatDex.flz.toLowerCase(), siteDex.flz.toLowerCase());
  });

  it('read those addresses from the same env names', () => {
    const chains = fs.readFileSync(path.join(ROOT, 'lib', 'chains.js'), 'utf8');
    const server = fs.readFileSync(path.join(ROOT, 'web', 'lib', 'dexServer.ts'), 'utf8');
    for (const name of ENV_NAMES) {
      assert.match(chains, new RegExp(`process\\.env\\.${name}\\b`), `lib/chains.js does not read ${name}`);
      assert.match(server, new RegExp(`process\\.env\\.${name}\\b`), `dexServer.ts does not read ${name}`);
    }
  });

  it('give the same answer for the same trade', () => {
    const trades = [
      [null, siteDex.flz],
      [siteDex.flz, null],
      [null, siteDex.wrappedNative],
      [null, siteDex.flz.toLowerCase()],
      [null, OTHER],
      [OTHER, null],
    ];
    for (const sides of trades) {
      assert.equal(
        chat.isUnverifiedSwap(sides, 'giwa_sepolia'),
        site.isUnverifiedSwap(sides, siteDex),
        `disagree on ${JSON.stringify(sides)}`
      );
    }
  });
});
