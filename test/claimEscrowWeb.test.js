/**
 * The site pays claims from escrow with its own copy of the escrow signer
 * (web/lib cannot import the root lib/ on Vercel). It must follow the same rule
 * as lib/escrowWallet.js: the key derived from the ops key is allowed on the
 * named testnet only, and every other chain requires ESCROW_PRIVATE_KEY.
 *
 * Run: node --test test/claimEscrowWeb.test.js
 */

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');

const WEB_LIB = pathToFileURL(path.join(__dirname, '..', 'web', 'lib') + path.sep).href;

// No database in this test, and no .env loading: web/lib/supabase.ts reads the
// real env files at import time, so it is replaced with an inert module.
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

const OPS_KEY = `0x${'1'.repeat(64)}`;
const TESTNET = { id: 'giwa_sepolia', chainId: 91342 };

const saved = {
  ESCROW_PRIVATE_KEY: process.env.ESCROW_PRIVATE_KEY,
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  DEFAULT_CHAIN: process.env.DEFAULT_CHAIN,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function useDerivedFallback() {
  delete process.env.ESCROW_PRIVATE_KEY;
  delete process.env.DEFAULT_CHAIN;
  process.env.PRIVATE_KEY = OPS_KEY;
}

let web;

before(async () => {
  web = await import('../web/lib/claimPayout.ts');
});

afterEach(restoreEnv);

describe('web escrow signer', () => {
  it('derives the fallback key on the named testnet, identical to the bot', () => {
    useDerivedFallback();
    const wallet = web.getEscrowWallet(TESTNET);

    const cfg = require('../lib/config').config;
    const previousChain = cfg.defaultChainKey;
    try {
      cfg.defaultChainKey = 'giwa_sepolia';
      const bot = require('../lib/escrowWallet').getEscrowWallet();
      assert.equal(wallet.address, bot.address, 'site and bot must pay from the same escrow');
    } finally {
      cfg.defaultChainKey = previousChain;
    }
    assert.notEqual(wallet.address.toLowerCase(), `0x${'1'.repeat(40)}`);
  });

  it('refuses the fallback when the chain id is not the testnet', () => {
    useDerivedFallback();
    assert.throws(
      () => web.getEscrowWallet({ id: 'giwa_sepolia', chainId: 1 }),
      /ESCROW_PRIVATE_KEY is required on giwa_sepolia \(chain id 1\)/
    );
  });

  it('refuses the fallback on a chain it has not been told about', () => {
    useDerivedFallback();
    assert.throws(
      () => web.getEscrowWallet({ id: 'some_mainnet', chainId: 91342 }),
      /ESCROW_PRIVATE_KEY is required on some_mainnet/
    );
  });

  it('refuses the fallback when DEFAULT_CHAIN names another chain', () => {
    useDerivedFallback();
    process.env.DEFAULT_CHAIN = 'some_mainnet';
    assert.throws(() => web.getEscrowWallet(TESTNET), /ESCROW_PRIVATE_KEY is required on some_mainnet/);
  });

  it('uses a dedicated ESCROW_PRIVATE_KEY on any chain', () => {
    const dedicated = `0x${'2'.repeat(64)}`;
    process.env.ESCROW_PRIVATE_KEY = dedicated;
    process.env.PRIVATE_KEY = OPS_KEY;
    process.env.DEFAULT_CHAIN = 'some_mainnet';
    const wallet = web.getEscrowWallet({ id: 'some_mainnet', chainId: 1 });
    assert.equal(wallet.privateKey, dedicated);
  });

  it('still requires some key', () => {
    delete process.env.ESCROW_PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;
    assert.throws(() => web.getEscrowWallet(TESTNET), /ESCROW_PRIVATE_KEY or PRIVATE_KEY required/);
  });
});
