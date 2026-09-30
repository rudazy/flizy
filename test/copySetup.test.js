/**
 * Copy setup stores wallets and limits. It has no execution path.
 *
 * Run: node --test test/copySetup.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const OWN = '0x0000000000000000000000000000000000000004';
const A = '0x0000000000000000000000000000000000000001';
const B = '0x0000000000000000000000000000000000000002';
const C = '0x0000000000000000000000000000000000000003';
const D = '0x0000000000000000000000000000000000000005';

let copy;
let paste;
let fake;
let deletes = 0;

const IN_LIST = /^\((0x[0-9a-fA-F]{40})(,0x[0-9a-fA-F]{40})*\)$/;

/**
 * supabase-js takes `.not(col, 'in', '(a,b)')` as a PostgREST list string,
 * while the fake takes an array. This checks the string is well formed, hands
 * the fake its array, and counts delete queries.
 */
function postgrestClient(fakeClient) {
  return {
    from(table) {
      const builder = fakeClient.from(table);
      const fakeNot = builder.not.bind(builder);
      const fakeDelete = builder.delete.bind(builder);
      builder.not = (col, op, value) => {
        if (op === 'in') {
          assert.equal(typeof value, 'string', 'supabase-js needs the list as a string');
          assert.match(value, IN_LIST);
          return fakeNot(col, op, value.slice(1, -1).split(','));
        }
        return fakeNot(col, op, value);
      };
      builder.delete = () => {
        deletes += 1;
        return fakeDelete();
      };
      return builder;
    },
  };
}

function tradeBody(wallets, extra = {}) {
  return {
    kind: 'trade',
    wallets: wallets.map((address) => ({ address, enabled: true })),
    allocationEth: '1',
    perTradeEth: '0.1',
    maxTradeEth: '0.2',
    maxDailyEth: '0.5',
    maxDailyCount: 0,
    copyBuys: true,
    copySells: true,
    slippagePct: '1',
    ...extra,
  };
}

before(async () => {
  copy = await import('../web/lib/copySetup.ts');
  paste = await import('../web/lib/copyPaste.ts');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: 'acct-1', agent_wallet_address: OWN }],
  });
  fake.client = postgrestClient(fake.client);
  deletes = 0;
});

describe('copy paste', () => {
  it('splits addresses, skips junk, and refuses a key without echoing it', () => {
    const key = `0x${'ab'.repeat(32)}`;
    const split = paste.splitWalletPaste(`${A}\nnot-a-wallet\n${B}\n${A}`, []);
    assert.deepEqual(
      split.addresses.map((address) => address.toLowerCase()),
      [A, B]
    );
    assert.equal(split.skipped, 1);
    assert.equal(split.error, '');

    const refused = paste.splitWalletPaste(`${A}\n${key}`, []);
    assert.equal(refused.addresses.length, 0);
    assert.match(refused.error, /key/i);
    assert.doesNotMatch(refused.error, /abab/);
  });

  it('stops at 100 wallets', () => {
    const existing = Array.from({ length: 100 }, (_, index) => {
      return `0x${(index + 1).toString(16).padStart(40, '0')}`;
    });
    const next = `0x${(200).toString(16).padStart(40, '0')}`;
    const split = paste.splitWalletPaste(next, existing);
    assert.match(split.error, /100/);
  });
});

describe('copy setup', () => {
  it('does not import an execution path', () => {
    const source = fs.readFileSync(path.join(__dirname, '../web/lib/copySetup.ts'), 'utf8');
    assert.doesNotMatch(source, /executeSwap|dexServer|sendTransaction|queryFilter/);
  });

  it('saves wallets with stable labels and keeps a wallet that is turned off', async () => {
    const saved = await copy.saveCopySetup('acct-1', tradeBody([A, B, C]), fake.client);
    assert.deepEqual(
      saved.wallets.map((wallet) => wallet.label),
      ['Wallet A', 'Wallet B', 'Wallet C']
    );

    const off = tradeBody([A, B, C]);
    off.wallets[1].enabled = false;
    const toggled = await copy.saveCopySetup('acct-1', off, fake.client);
    assert.equal(toggled.wallets.length, 3);
    assert.equal(toggled.wallets[1].label, 'Wallet B');
    assert.equal(toggled.wallets[1].enabled, false);

    const removed = await copy.saveCopySetup('acct-1', tradeBody([B, C, D]), fake.client);
    assert.deepEqual(
      removed.wallets.map((wallet) => `${wallet.label}:${wallet.address.slice(-1)}`),
      ['Wallet B:2', 'Wallet C:3', 'Wallet A:5']
    );
  });

  it('keeps trade and mint lists apart, and does not copy sells for a mint', async () => {
    await copy.saveCopySetup('acct-1', tradeBody([A]), fake.client);
    const mint = await copy.saveCopySetup(
      'acct-1',
      {
        kind: 'mint',
        wallets: [{ address: B, enabled: true }],
        allocationEth: '0.4',
        perTradeEth: '0.1',
        maxTradeEth: '0.1',
        maxDailyEth: '0.2',
        maxDailyCount: 2,
        copyBuys: true,
        copySells: true,
        slippagePct: '9',
      },
      fake.client
    );
    assert.equal(mint.wallets.length, 1);
    assert.equal(mint.wallets[0].label, 'Wallet A');
    assert.equal(mint.copySells, false);
    assert.equal(mint.slippagePct, '1');
    assert.equal(mint.maxDailyCount, 2);

    const trade = await copy.readCopySetup('acct-1', 'trade', fake.client);
    assert.equal(trade.wallets.length, 1);
    assert.equal(trade.wallets[0].address.toLowerCase(), A);
    assert.equal(trade.copySells, true);
  });

  it('refuses the account wallet, a key, and a limit above the allocation', async () => {
    await assert.rejects(
      () => copy.saveCopySetup('acct-1', tradeBody([OWN]), fake.client),
      /own Flizy wallet/
    );
    await assert.rejects(
      () => copy.saveCopySetup('acct-1', tradeBody([`0x${'11'.repeat(32)}`]), fake.client),
      /key/i
    );
    await assert.rejects(
      () => copy.saveCopySetup('acct-1', tradeBody([A], { perTradeEth: '2' }), fake.client),
      /allocation/
    );
    await assert.rejects(
      () => copy.saveCopySetup('acct-1', tradeBody([A], { maxDailyCount: 3 }), fake.client),
      /mint count/
    );
    const rows = fake.db.tables.copy_wallets || [];
    assert.equal(rows.length, 0);
    assert.equal((fake.db.tables.copy_setups || []).length, 0);
  });

  it('stores the allocation in wei and reads it back as ETH', async () => {
    const saved = await copy.saveCopySetup('acct-1', tradeBody([A], { allocationEth: '1.5' }), fake.client);
    assert.equal(saved.allocationEth, '1.5');
    assert.equal(saved.perTradeEth, '0.1');
    const row = fake.db.tables.copy_setups[0];
    assert.equal(row.allocation_wei, '1500000000000000000');
  });
});

describe('copy setup writes', () => {
  it('removes dropped wallets with one delete, however many there are', async () => {
    const many = Array.from({ length: 40 }, (_, index) => `0x${(index + 16).toString(16).padStart(40, '0')}`);
    await copy.saveCopySetup('acct-1', tradeBody(many), fake.client);
    deletes = 0;
    const kept = await copy.saveCopySetup('acct-1', tradeBody([many[3]]), fake.client);
    assert.equal(deletes, 1);
    assert.deepEqual(kept.wallets.map((wallet) => wallet.address.toLowerCase()), [many[3]]);
  });

  it('clears the list when every wallet is removed', async () => {
    await copy.saveCopySetup('acct-1', tradeBody([A, B]), fake.client);
    const cleared = await copy.saveCopySetup('acct-1', tradeBody([]), fake.client);
    assert.equal(cleared.wallets.length, 0);
    assert.equal((fake.db.tables.copy_wallets || []).length, 0);
  });

  it('refuses an oversized amount as a client error, before the database', async () => {
    await assert.rejects(
      () =>
        copy.saveCopySetup(
          'acct-1',
          tradeBody([A], { allocationEth: '1'.repeat(80), perTradeEth: '', maxTradeEth: '', maxDailyEth: '' }),
          fake.client
        ),
      (err) => err.name === 'ClientError' && /Allocation is too large/.test(err.message)
    );
    await assert.rejects(
      () => copy.saveCopySetup('acct-1', tradeBody([A], { allocationEth: '1000000000' }), fake.client),
      /Allocation is too large/
    );
    assert.equal((fake.db.tables.copy_setups || []).length, 0);

    const fine = await copy.saveCopySetup(
      'acct-1',
      tradeBody([A], { allocationEth: '000999999999.5' }),
      fake.client
    );
    assert.equal(fine.allocationEth, '999999999.5');
  });

  it('refuses a save that lost a race, and leaves the winner untouched', async () => {
    await copy.saveCopySetup('acct-1', tradeBody([A, B]), fake.client);
    const before = (fake.db.tables.copy_wallets || []).map((row) => row.address).sort();

    // Another save lands between this one's version read and its first write.
    const inner = fake.client;
    let bumped = false;
    const racing = {
      from(table) {
        if (table === 'copy_wallets' && !bumped) {
          bumped = true;
          fake.db.tables.copy_setups[0].updated_at = '2099-01-01T00:00:00.000Z';
        }
        return inner.from(table);
      },
    };

    await assert.rejects(
      () => copy.saveCopySetup('acct-1', tradeBody([C]), racing),
      /changed in another tab/
    );
    const after = (fake.db.tables.copy_wallets || []).map((row) => row.address).sort();
    assert.deepEqual(after, before);
  });

  it('has no second paste parser beside copyPaste.splitWalletPaste', () => {
    assert.equal(copy.parseWalletPaste, undefined);
  });
});
