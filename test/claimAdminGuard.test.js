/**
 * Admin is accounts.is_admin, set by hand in the SQL editor, and nothing else.
 *
 * claimadmin, ADMIN_SETUP_SECRET and ADMIN_PHONES used to grant it from chat,
 * and admin used to skip the session unlock, the daily limit and the credit
 * check. Both are gone: the old command promotes nobody (and its secret is
 * still kept out of the log, for anyone who types it from habit), the legacy
 * users row cannot make anyone an admin, and an admin is locked out of
 * spending exactly like everyone else.
 *
 * The escrow custody checks at the end are unrelated and live here because
 * this file already loads the runtime they need.
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
// A setup secret as it may still sit in an old .env. It must grant nothing.
const GOOD_SECRET = 'a-very-long-setup-secret-0123456789';

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

describe('claimadmin is retired', () => {
  beforeEach(seed);

  it('the old command with the old secret promotes nobody', async () => {
    const sent = [];
    await router.handle(ctxFor(sent), `/claimadmin ${GOOD_SECRET}`);
    assert.equal(fake.db.tables.accounts[0].is_admin, false);
    assert.equal(users()[0].is_admin, false);
    assert.doesNotMatch(sent.join('\n'), /now an admin/i);
  });

  it('keeps the old secret out of the log if someone still types it', async () => {
    const logged = [];
    const original = console.log;
    console.log = (...args) => logged.push(args.join(' '));
    try {
      await router.handle(ctxFor([]), `/claimadmin ${GOOD_SECRET}`);
    } finally {
      console.log = original;
    }
    assert.ok(logged.length > 0);
    assert.ok(!logged.join('\n').includes(GOOD_SECRET));
  });

  it('nothing in lib reads ADMIN_PHONES or ADMIN_SETUP_SECRET any more', () => {
    const libDir = path.join(__dirname, '..', 'lib');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && entry.name !== 'securityConfig.js') {
          if (/ADMIN_PHONES|ADMIN_SETUP_SECRET|adminPhones|adminSetupSecret/.test(fs.readFileSync(full, 'utf8'))) {
            offenders.push(path.relative(libDir, full));
          }
        }
      }
    };
    walk(libDir);
    assert.deepEqual(offenders, []);
  });
});

describe('admin is accounts.is_admin, and nothing else', () => {
  beforeEach(seed);

  it('the account flag opens the operator commands on an unlocked chat', async () => {
    fake.db.tables.accounts[0].is_admin = true;
    fake.db.tables.accounts[0].unlock_pin_hash = 'pin-hash-present';
    fake.db.tables.sessions.push({
      account_id: 'acc-a',
      channel: 'telegram',
      external_id: TG_ID,
      is_locked: false,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const sent = [];
    await router.handle(ctxFor(sent), '/pool');
    assert.match(sent.join('\n'), /Ops wallet/);
  });

  it('the flag alone is not enough: a chat that never unlocked cannot list users or credit', async () => {
    fake.db.tables.accounts[0].is_admin = true;
    fake.db.tables.accounts[0].unlock_pin_hash = 'pin-hash-present';
    for (const command of ['/users', '/pool', '/credit 2348012345678 0.01']) {
      const sent = [];
      await router.handle(ctxFor(sent), command);
      assert.match(sent.join('\n'), /Operator commands need an unlocked chat/, command);
    }
    assert.equal(users()[0].balance_eth, 0);
  });

  it('the legacy users flag alone does not', async () => {
    users()[0].is_admin = true;
    const sent = [];
    await router.handle(ctxFor(sent), '/pool');
    assert.match(sent.join('\n'), /admin-only/);
  });

  it('only the operator commands read the flag: no money path exempts an admin', () => {
    const libDir = path.join(__dirname, '..', 'lib');
    const readers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'generated') walk(full);
        } else if (entry.name.endsWith('.js')) {
          const code = fs
            .readFileSync(full, 'utf8')
            .split('\n')
            .filter((line) => !/^\s*(\/?\*|\/\/)/.test(line))
            .join('\n');
          if (/\bisAdmin\b|is_admin|isAdminAccount\(/.test(code)) readers.push(path.relative(libDir, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(libDir);
    assert.deepEqual(readers.sort(), ['commands/chat.js', 'handlers/admin.js']);
  });

  it('an admin goes through the same lock as everyone else', async () => {
    // Both flags, so this would also catch the old bypass, which read the
    // legacy users row.
    fake.db.tables.accounts[0].is_admin = true;
    users()[0].is_admin = true;
    fake.db.tables.accounts[0].unlock_pin_hash = 'pin-hash-present';
    fake.db.tables.sessions.push({
      account_id: 'acc-a',
      channel: 'telegram',
      external_id: TG_ID,
      is_locked: true,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const sent = [];
    await router.handle(ctxFor(sent), '/pool');
    assert.match(sent.join('\n'), /Session locked/);
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
