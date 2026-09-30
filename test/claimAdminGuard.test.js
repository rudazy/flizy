/**
 * `claimadmin` is the most valuable command in the product, so it gets the same
 * protection as the others that take a secret over chat.
 *
 * What admin buys, from lib/engine/policy.js: exemption from the session unlock
 * requirement (evaluateSendPolicy and evaluateSwapPolicy), and within
 * evaluateSendPolicy from the daily send limit and the credit check. Three spend
 * controls, removed by one command.
 *
 * So the secret is compared in constant time, a failure is logged, and guesses
 * are counted on the same lockout ladder as link codes, keyed the same way on
 * (channel, external_id). Unlike a link code, the admin lockout fails closed:
 * if the counter cannot be read or a failure cannot be recorded, the attempt is
 * refused rather than let through uncounted.
 *
 * Run: node --test test/claimAdminGuard.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
// Long enough to clear the floor, so the tests exercise the comparison and the
// lockout rather than the configuration refusal.
const GOOD_SECRET = 'a-very-long-setup-secret-0123456789';
process.env.ADMIN_SETUP_SECRET = GOOD_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({
  from: (table) => fake.client.from(table),
  rpc: (name, args) => fake.client.rpc(name, args),
});

const runtimePath = require.resolve('../lib/runtime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    chain: {
      id: 'giwa_sepolia',
      name: 'GIWA Sepolia',
      chainId: 91342,
      nativeSymbol: 'ETH',
      rpcUrl: 'http://localhost:0',
    },
    supabase: {
      from: (table) => fake.client.from(table),
      rpc: (name, args) => fake.client.rpc(name, args),
    },
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');

const TG_ID = '553311777';

function ctxFor(sent) {
  return {
    channel: 'telegram',
    externalId: TG_ID,
    key: `telegram:${TG_ID}`,
    raw: {},
    reply: async (text) => {
      sent.push(text);
    },
    resolveVerifiedPhone: async () => null,
    requestPhone: async () => {},
  };
}

function seed() {
  fake = createFakeSupabase({
    accounts: [
      {
        id: 'acc-a',
        email: 'a@example.com',
        display_name: 'A',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x9999999999999999999999999999999999999999',
        unlock_pin_hash: null,
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-a', channel: 'telegram', external_id: TG_ID, phone_e164: null },
    ],
    users: [{ id: 'u1', phone: `telegram:${TG_ID}`, account_id: 'acc-a', balance_eth: 0, is_admin: false }],
    link_code_attempts: [],
    sessions: [],
  });
  router.discardPendingFlows(`telegram:${TG_ID}`);
}

const users = () => fake.db.tables.users || [];
const attempts = () => fake.db.tables.link_code_attempts || [];
const isAdminNow = () => Boolean(users()[0] && users()[0].is_admin);

describe('a wrong secret is counted, not just refused', () => {
  beforeEach(seed);

  it('refuses and records the attempt', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), '/claimadmin wrong-guess-entirely');

    assert.match(sent.join('\n'), /Invalid setup secret/i);
    assert.equal(isAdminNow(), false, 'nobody was promoted');
    assert.equal(attempts().length, 1, 'the guess was recorded');
  });

  it('counts each guess, so grinding runs into the ladder', async () => {
    for (let i = 0; i < 4; i += 1) {
      const sent = [];
      await router.handle(ctxFor(sent), `/claimadmin guess-number-${i}`);
      assert.equal(isAdminNow(), false);
    }
    const row = attempts()[0];
    assert.ok(Number(row.failed_attempts) >= 4, `expected 4 or more, got ${row.failed_attempts}`);
  });

  it('eventually locks the chat out, and says so without hinting', async () => {
    // Enough wrong guesses to pass the free allowance and land in the ladder.
    for (let i = 0; i < 8; i += 1) {
      await router.handle(ctxFor([]), `/claimadmin still-wrong-${i}`);
    }
    const sent = [];
    await router.handle(ctxFor(sent), `/claimadmin ${GOOD_SECRET}`);
    const out = sent.join('\n');

    // The correct secret offered while locked out must not promote. The lockout
    // check sits above the comparison for exactly this reason.
    assert.match(out, /Too many wrong secrets/i);
    assert.equal(isAdminNow(), false, 'a locked-out chat cannot promote, even with the real secret');
    assert.doesNotMatch(out, /valid|correct|close/i, 'and it must not say the guess was right');
  });
});

describe('the right secret still works', () => {
  beforeEach(seed);

  it('promotes and clears the counter', async () => {
    // One wrong guess first, so there is a counter to clear.
    await router.handle(ctxFor([]), '/claimadmin wrong-the-first-time');
    assert.equal(attempts().length, 1);

    const sent = [];
    await router.handle(ctxFor(sent), `/claimadmin ${GOOD_SECRET}`);

    assert.match(sent.join('\n'), /now an admin/i);
    assert.equal(isAdminNow(), true);
    const row = attempts()[0];
    assert.equal(Number(row?.failed_attempts || 0), 0, 'a correct secret clears the counter');
  });

  it('says so plainly when already an admin', async () => {
    users()[0].is_admin = true;
    const sent = [];
    await router.handle(ctxFor(sent), `/claimadmin ${GOOD_SECRET}`);
    assert.match(sent.join('\n'), /already an admin/i);
  });
});

describe('the comparison and the floor', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'handlers', 'admin.js'), 'utf8');

  it('compares the secret in constant time', () => {
    assert.match(SRC, /crypto\.timingSafeEqual\(/, 'the secret must not be compared with ===');
    // A direct comparison leaks the secret one character at a time.
    assert.doesNotMatch(
      SRC,
      /secret\s*!==\s*expected|expected\s*!==\s*secret/,
      'a direct string comparison on the secret leaks it through timing'
    );
  });

  it('checks the lockout before it checks the secret', () => {
    const lockAt = SRC.indexOf('linkLockState(channel, externalId)');
    const compareAt = SRC.indexOf('secretsMatch(secret, expected)');
    assert.ok(lockAt > 0 && compareAt > 0, 'both steps must be present');
    assert.ok(
      lockAt < compareAt,
      'comparing first would let a locked-out guesser keep learning from timing'
    );
  });

  it('logs a failure, so grinding is visible', () => {
    assert.match(SRC, /\[admin\] claimadmin failed/, 'a failed attempt must leave a trace');
    assert.match(SRC, /\[admin\] promoted to admin/, 'and so must a successful promotion');
  });

  it('refuses a trivially short configured secret', async () => {
    seed();
    const previous = process.env.ADMIN_SETUP_SECRET;
    process.env.ADMIN_SETUP_SECRET = 'short';
    // config caches at require time, so this asserts the floor exists and its
    // value rather than re-reading the environment.
    try {
      assert.match(SRC, /ADMIN_SECRET_MIN_LENGTH = 16/);
      assert.match(SRC, /length < ADMIN_SECRET_MIN_LENGTH/);
      assert.match(SRC, /Admin setup is not usable/);
    } finally {
      process.env.ADMIN_SETUP_SECRET = previous;
    }
  });
});

describe('escrow custody is separate in fact, not just in address', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'escrowWallet.js'), 'utf8');

  it('allows the derived escrow key only on a named testnet', () => {
    // Deriving escrow from the ops key gives a different address but not
    // separate custody: one stolen key empties gas and every pending claim.
    // The guard is what stops the fallback reaching a chain where that matters.
    assert.match(SRC, /DERIVED_ESCROW_OK_CHAINS = new Set\(\['giwa_sepolia'\]\)/);
    assert.match(SRC, /if \(!DERIVED_ESCROW_OK_CHAINS\.has\(chainKey\)\)/);
    assert.match(SRC, /ESCROW_PRIVATE_KEY is required on/);
  });

  it('says out loud when it is running on the fallback', () => {
    assert.match(SRC, /\[escrow\] ESCROW_PRIVATE_KEY is not set/);
  });

  it('refuses a chain it has not been told about', async () => {
    // Driven, not just read: the throw is the whole protection.
    const { getEscrowWallet } = require('../lib/escrowWallet');
    const cfg = require('../lib/config').config;
    const previousChain = cfg.defaultChainKey;
    const previousEscrow = process.env.ESCROW_PRIVATE_KEY;
    const previousOps = process.env.PRIVATE_KEY;
    try {
      delete process.env.ESCROW_PRIVATE_KEY;
      process.env.PRIVATE_KEY = `0x${'1'.repeat(64)}`;
      cfg.defaultChainKey = 'some_mainnet';
      assert.throws(() => getEscrowWallet(), /ESCROW_PRIVATE_KEY is required on some_mainnet/);

      // And the named testnet still works, or this guard would be an outage.
      cfg.defaultChainKey = 'giwa_sepolia';
      const wallet = getEscrowWallet();
      assert.match(wallet.address, /^0x[0-9a-fA-F]{40}$/);
      assert.notEqual(
        wallet.address.toLowerCase(),
        '0x' + '1'.repeat(40),
        'escrow must not be the ops address itself'
      );
    } finally {
      cfg.defaultChainKey = previousChain;
      if (previousEscrow === undefined) delete process.env.ESCROW_PRIVATE_KEY;
      else process.env.ESCROW_PRIVATE_KEY = previousEscrow;
      if (previousOps === undefined) delete process.env.PRIVATE_KEY;
      else process.env.PRIVATE_KEY = previousOps;
    }
  });
});
