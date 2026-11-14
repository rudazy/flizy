/**
 * The daily passkey limit on the payment paths that used to skip it: a chat
 * claim hold (lib/engine/executeClaim.js), a pay-page payment
 * (web/app/api/pay/execute/route.ts) and a site checkout payment
 * (web/app/api/checkout/[id]/pay/route.ts).
 *
 * Covers: a hold from a secured account goes through its daily permission,
 * and over what is left it is refused with nothing sent; what is left for a
 * site payment is what the permission reports less the owner-key payments it
 * cannot see, counted the same way on the bot and the site; a chat send sees
 * those payments too; a limit that cannot be read refuses; and both site
 * routes check before they write a row or send anything.
 *
 * Run: node --test test/passkeyCapPaths.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

const HASH = '0x' + 'ab'.repeat(32);
const ESCROW = '0x4444444444444444444444444444444444444444';
const RELAYER = '0x' + 'bb'.repeat(20);

// The owner executor, the escrow and the permission sender are recorders.
const calls = { owner: [], permission: [] };
let permissionAnswer = null;
const gatorPath = require.resolve('../lib/gatorExecute');
const realGator = require('../lib/gatorExecute');
require.cache[gatorPath].exports = {
  ...realGator,
  gatorGasReserveWei: async () => 0n,
  executeGatorCall: async (args) => {
    calls.owner.push(args);
    if (args.onBroadcast) await args.onBroadcast(HASH);
    return { txHash: HASH, receipt: { status: 1, blockNumber: 9 } };
  },
};
const escrowPath = require.resolve('../lib/escrowWallet');
require.cache[escrowPath] = {
  id: escrowPath,
  filename: escrowPath,
  loaded: true,
  exports: {
    getEscrowWallet: () => ({ address: ESCROW }),
    assertEscrowSolvent: async () => ({ ok: true, balanceEth: '1', liabilityEth: '0', pendingCount: 0 }),
  },
};
const redeem = require('../lib/custody/redeem');
// The real one, for the test of what a chat send sees.
const realTrySend = redeem.trySendWithPermission;
redeem.trySendWithPermission = async (args) => {
  calls.permission.push(args);
  if (typeof permissionAnswer === 'function') return permissionAnswer(args);
  return permissionAnswer;
};

const { predictGatorAddress } = require('../lib/gatorAccount');
const { executeClaimHold } = require('../lib/engine/executeClaim');
const { executeNativeSend } = require('../lib/engine/executeTransfer');
const CP = require('../lib/api/checkoutPay');

const ACCOUNT = 'acct-cap';
const USER = 'user-cap';
const GATOR = predictGatorAddress(ACCOUNT);
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', explorerBaseUrl: 'https://explorer.test' };

const ERC20 = new ethers.Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const provider = {
  async getNetwork() {
    return { chainId: 91342 };
  },
  async getBalance() {
    return 10n ** 18n;
  },
  async call({ data }) {
    const fn = ERC20.parseTransaction({ data });
    if (fn.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [18]);
    return ERC20.encodeFunctionResult('balanceOf', [10n ** 24n]);
  },
};

function seed() {
  calls.owner = [];
  calls.permission = [];
  permissionAnswer = null;
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, agent_wallet_address: GATOR, balance_eth: 1 }],
    users: [{ id: USER, phone: '2348000000000', balance_eth: 1, is_admin: false }],
    transfers: [],
    claims: [],
    claim_hold_attempts: [],
  });
}

const FLZ = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
const hold = (amountEth, asset = 'ETH', onSending) =>
  executeClaimHold({
    fromAccountId: ACCOUNT,
    fromWaSender: '2348000000000',
    toWaHint: '2348099999999',
    amountEth,
    asset,
    tokenAddress: asset === 'FLZ' ? FLZ : null,
    provider,
    chain,
    escrowWallet: { address: ESCROW },
    onSending,
  });

describe('chat claim hold and the daily passkey limit', () => {
  beforeEach(seed);

  it('over what is left today: refused, nothing sent, no claim, the attempt refused', async () => {
    permissionAnswer = { route: 'over_cap', available: 5n * 10n ** 16n, delegate: RELAYER };
    const r = await hold('0.06');
    assert.equal(r.ok, false);
    assert.equal(r.submitted, false);
    assert.match(r.error, /more than your passkey allows today \(0\.05 ETH left of 0\.1 ETH\), so it was not sent/);
    assert.match(r.error, /Send 0\.05 ETH or less/);
    assert.equal(calls.owner.length, 0);
    assert.equal(fake.db.tables.claims.length, 0);
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'refused');
    // The permission was asked about exactly this hold: ETH, to the escrow, from the gator.
    const asked = calls.permission[0];
    assert.equal(asked.symbol, 'ETH');
    assert.equal(asked.amount, 6n * 10n ** 16n);
    assert.equal(asked.to, ESCROW);
    assert.equal(asked.wallet, GATOR);
  });

  it('within what is left: the relayer sends it through the permission, never the owner key', async () => {
    permissionAnswer = async (args) => {
      await args.onBroadcast(HASH);
      return { route: 'permission', txHash: HASH, receipt: { status: 1, blockNumber: 9 } };
    };
    const r = await hold('0.01');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.owner.length, 0);
    assert.equal(fake.db.tables.claims.length, 1);
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'held');
    assert.equal(fake.db.tables.claim_hold_attempts[0].hold_tx_hash, HASH);
  });

  it('not a secured account (no permission route): the owner key, as before', async () => {
    permissionAnswer = null;
    const r = await hold('0.01');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.permission.length, 1);
    assert.equal(calls.owner.length, 1);
    assert.equal(calls.owner[0].target, ESCROW);
  });

  it('a limit that cannot be read: refused, nothing sent', async () => {
    permissionAnswer = { route: 'unchecked' };
    const r = await hold('0.01');
    assert.equal(r.ok, false);
    assert.equal(r.submitted, false);
    assert.match(r.error, /Could not check your passkey limit right now, so it was not sent/);
    assert.equal(calls.owner.length, 0);
    assert.equal(fake.db.tables.claim_hold_attempts[0].status, 'refused');
  });

  it('a FLZ hold is checked against the FLZ permission', async () => {
    permissionAnswer = { route: 'over_cap', available: 10n ** 18n, delegate: RELAYER };
    const r = await hold('5', 'FLZ');
    assert.equal(r.ok, false);
    assert.match(r.error, /\(1\.0 FLZ left of 1000\.0 FLZ\)/);
    assert.equal(calls.permission[0].symbol, 'FLZ');
    assert.equal(calls.permission[0].amount, 5n * 10n ** 18n);
    assert.equal(ethers.getAddress(calls.permission[0].to), ESCROW);
    assert.equal(calls.owner.length, 0);
  });
});

describe('the "money is moving" notice', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  beforeEach(seed);

  it('a claim hold says it only when the hold can move money', async () => {
    const said = [];
    permissionAnswer = { route: 'over_cap', available: 5n * 10n ** 16n, delegate: RELAYER };
    await hold('0.06', 'ETH', () => said.push('hold'));
    assert.deepEqual(said, [], 'a refused hold is never announced');
    permissionAnswer = null;
    const r = await hold('0.01', 'ETH', () => said.push('hold'));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(said, ['hold']);
  });

  it('chat says Holding funds and Paying through the engine, not before it', () => {
    const router = read('lib/router.js');
    const branch = (open, call) => {
      const i = router.indexOf(open);
      return router.slice(i, router.indexOf(call, i));
    };
    assert.ok(!branch("if (plan.intent === 'CLAIM_HOLD') {", 'await executeClaimHold({').includes('Holding funds'));
    assert.ok(router.includes("onSending: () => reply(ctx, 'Holding funds for claim...'),"));
    assert.ok(!branch("if (plan.intent === 'CHECKOUT') {", 'await checkoutPay.payCheckout({').includes('Paying'));
    assert.ok(router.includes("onSending: () => reply(ctx, 'Paying...'),"));
  });

  it('a checkout payment says Paying only after its last refusal', () => {
    const src = read('lib/api/checkoutPay.js');
    const body = src.slice(src.indexOf('async function payCheckout('));
    const said = body.indexOf('await announcer(onSending)()');
    const lastRefusal = body.lastIndexOf('return { ok: false', body.indexOf('let payBroadcast'));
    assert.ok(said > lastRefusal, 'after every check');
    assert.ok(said < body.indexOf('executeGatorCall('), 'before the send');
  });
});

describe('a chat send that cannot wait', () => {
  beforeEach(seed);
  const sendPlan = () => ({
    intent: 'SEND',
    expiresAt: Date.now() + 60000,
    input: { amount: '0.06', asset: 'ETH', recipientLabel: 'john' },
    route: { kind: 'native_transfer', toAddress: '0x1111111111111111111111111111111111111111', fromAddress: GATOR },
    actor: { accountId: ACCOUNT, userId: USER, waSenderId: '2348000000000' },
  });
  const send = () => executeNativeSend({ plan: sendPlan(), provider, chain, user: { id: USER, balance_eth: 1, is_admin: false }, supabase: fake.client });

  it('over the limit with no relayer to send an approval: refused with what is left', async () => {
    permissionAnswer = { route: 'over_cap', available: 5n * 10n ** 16n, delegate: RELAYER, approvable: false };
    const out = await send();
    assert.equal(out.ok, false);
    assert.equal(out.submitted, false);
    assert.equal(out.approvalPending, undefined);
    assert.ok(out.error.startsWith('This is more than your passkey allows today (0.05 ETH left of 0.1 ETH), so it was not sent. Larger payments cannot be approved right now. Send 0.05 ETH or less'), out.error);
    assert.equal(calls.owner.length, 0);
  });

  it('a limit that cannot be read: refused, nothing sent', async () => {
    permissionAnswer = { route: 'unchecked' };
    const out = await send();
    assert.equal(out.ok, false);
    assert.equal(out.submitted, false);
    assert.match(out.error, /Could not check your passkey limit right now, so it was not sent/);
    assert.equal(calls.owner.length, 0);
  });
});

describe('owner-key payments counted against the limit (bot and site)', () => {
  let web;
  before(async () => {
    web = await import('../web/lib/custody/allowanceLeft.ts');
  });

  const hourAgo = () => new Date(Date.now() - 3600e3).toISOString();
  const rows = () => [
    // Counted: a chat checkout, a pay-page payment, and a site checkout that is in both lists.
    { id: 't1', account_id: 'payer', note: 'Checkout', phone: '2348000000000', kind: 'transfer', asset: 'TUSD', status: 'confirmed', amount_eth: '10', created_at: hourAgo() },
    { id: 't2', account_id: 'payer', note: 'lunch', phone: 'site', kind: 'transfer', asset: 'TUSD', status: 'submitted', amount_eth: '7.5', created_at: hourAgo() },
    { id: 't3', account_id: 'payer', note: 'Checkout', phone: 'site', kind: 'transfer', asset: 'TUSD', status: 'pending', amount_eth: '2', created_at: hourAgo() },
    // Not counted: a chat send (it goes through the permission), a site swap,
    // failed, older than a day, another asset, another account.
    { id: 't4', account_id: 'payer', note: null, phone: '2348000000000', kind: 'transfer', asset: 'TUSD', status: 'confirmed', amount_eth: '9', created_at: hourAgo() },
    { id: 't5', account_id: 'payer', note: null, phone: 'site', kind: 'swap', asset: 'TUSD', status: 'confirmed', amount_eth: '9', created_at: hourAgo() },
    { id: 't6', account_id: 'payer', note: 'lunch', phone: 'site', kind: 'transfer', asset: 'TUSD', status: 'failed', amount_eth: '9', created_at: hourAgo() },
    { id: 't7', account_id: 'payer', note: 'lunch', phone: 'site', kind: 'transfer', asset: 'TUSD', status: 'confirmed', amount_eth: '9', created_at: new Date(Date.now() - 25 * 3600e3).toISOString() },
    { id: 't8', account_id: 'payer', note: 'lunch', phone: 'site', kind: 'transfer', asset: 'ETH', status: 'confirmed', amount_eth: '9', created_at: hourAgo() },
    { id: 't9', account_id: 'other', note: 'lunch', phone: 'site', kind: 'transfer', asset: 'TUSD', status: 'confirmed', amount_eth: '9', created_at: hourAgo() },
  ];

  it('counts the same rows on both sides, each once', async () => {
    const db = createFakeSupabase({ transfers: rows() }).client;
    assert.equal(await CP.ownerKeyUnitsToday(db, 'payer', 'TUSD', 6), 19_500_000n);
    assert.equal(await web.ownerKeyUnitsToday(db, 'payer', 'TUSD', 6), 19_500_000n);
  });

  it('a chat checkout after a pay-page payment sees the pay-page payment', async () => {
    const db = createFakeSupabase({ transfers: rows() }).client;
    const ask = (amount) =>
      CP.overPasskeyAllowance({ supabase: db, provider: null, accountId: 'payer', wallet: GATOR, asset: 'TUSD', amount, planSend: async () => ({ route: 'permission', available: 50_000_000n }) });
    assert.deepEqual(await ask(30_500_000n), { over: false });
    assert.deepEqual(await ask(30_500_001n), { over: true, available: 30_500_000n });
  });
});

describe('chat sends and holds see the owner-key payments too', () => {
  const C = require('../lib/custody/delegations');
  const relayer = ethers.Wallet.createRandom();
  const ENF = new ethers.Interface(['function getAvailableAmount(bytes32,address,bytes) view returns (uint256,bool,uint256)']);
  const signedAt = Math.floor(Date.now() / 1000) - 3600;

  function ethRow() {
    const [{ delegation }] = C.buildDelegations({ account: GATOR, delegate: relayer.address, signedAt, salts: { ETH: 7n, FLZ: 8n, TUSD: 9n } }).filter((d) => d.symbol === 'ETH');
    return {
      account_id: ACCOUNT,
      symbol: 'ETH',
      gator: delegation.delegator,
      delegate: delegation.delegate,
      salt: delegation.salt.toString(),
      caveats: delegation.caveats,
      digest: C.delegationDigest(delegation),
      signature: '0x' + '11'.repeat(100),
      status: 'active',
      expires_at: new Date((signedAt + C.EXPIRY_SECONDS) * 1000).toISOString(),
    };
  }

const decide = async ({ rows, available = 5n * 10n ** 16n, key, amount, transfers = [] }) => {
    const saved = process.env.CUSTODY_RELAYER_KEY;
    process.env.CUSTODY_RELAYER_KEY = key;
    const lines = [];
    try {
      const out = await realTrySend({
        supabase: createFakeSupabase({ custody_delegations: rows, transfers }).client,
        provider: {
          call: async ({ data }) => {
            if (available instanceof Error) throw available;
            ENF.decodeFunctionData('getAvailableAmount', data);
            return ENF.encodeFunctionResult('getAvailableAmount', [available, false, 1n]);
          },
        },
        accountId: ACCOUNT,
        wallet: GATOR,
        symbol: 'ETH',
        amount,
        to: ESCROW,
        log: { warn: (l) => lines.push(l), info: (l) => lines.push(l) },
      });
      return { out, lines };
    } finally {
      if (saved === undefined) delete process.env.CUSTODY_RELAYER_KEY;
      else process.env.CUSTODY_RELAYER_KEY = saved;
    }
  };

  it('no passkey on the account: the owner key, unchanged', async () => {
    const { out } = await decide({ rows: [], key: '', amount: 10n ** 18n });
    assert.equal(out, null);
  });

  it('relayer unavailable, within the limit: the owner key, no friction', async () => {
    for (const key of ['', 'not-a-key', ethers.Wallet.createRandom().privateKey]) {
      const { out, lines } = await decide({ rows: [ethRow()], key, amount: 10n ** 16n });
      assert.equal(out, null, key);
      assert.match(lines[0], /send on the owner key/);
    }
  });

  it('relayer unavailable, over the limit: refused, never the owner key', async () => {
    const { out, lines } = await decide({ rows: [ethRow()], key: '', amount: 6n * 10n ** 16n });
    assert.deepEqual(out, { route: 'over_cap', available: 5n * 10n ** 16n, delegate: relayer.address, approvable: false });
    assert.ok(lines[0].includes('cannot wait for an approval (relayer key unset): refused'), lines[0]);
  });

  it('a permission whose limit cannot be read: refused, never the owner key', async () => {
    const broken = { ...ethRow(), salt: '99' };
    assert.deepEqual((await decide({ rows: [broken], key: relayer.privateKey, amount: 1n })).out, { route: 'unchecked' });
    assert.deepEqual((await decide({ rows: [ethRow()], key: relayer.privateKey, amount: 1n, available: new Error('rpc down') })).out, { route: 'unchecked' });
  });

  it('a pay-page payment today leaves less for a chat send: over that, it waits for the passkey', async () => {
    const saved = process.env.CUSTODY_RELAYER_KEY;
    process.env.CUSTODY_RELAYER_KEY = relayer.privateKey;
    const lines = [];
    try {
      const db = createFakeSupabase({
        custody_delegations: [ethRow()],
        transfers: [{ id: 'p1', account_id: ACCOUNT, note: null, phone: 'site', kind: 'transfer', asset: 'ETH', status: 'confirmed', amount_eth: '0.04', created_at: new Date().toISOString() }],
      }).client;
      const chainReader = { call: async ({ data }) => (ENF.decodeFunctionData('getAvailableAmount', data), ENF.encodeFunctionResult('getAvailableAmount', [5n * 10n ** 16n, false, 1n])) };
      const out = await realTrySend({
        supabase: db,
        provider: chainReader,
        accountId: ACCOUNT,
        wallet: GATOR,
        symbol: 'ETH',
        amount: 2n * 10n ** 16n,
        to: ESCROW,
        log: { warn: (l) => lines.push(l), info: (l) => lines.push(l) },
      });
      // The period says 0.05 left; 0.04 went on the pay page: 0.01 is left.
      assert.deepEqual(out, { route: 'over_cap', available: 10n ** 16n, delegate: relayer.address });
      assert.match(lines[0], /waiting for a passkey approval/);
    } finally {
      if (saved === undefined) delete process.env.CUSTODY_RELAYER_KEY;
      else process.env.CUSTODY_RELAYER_KEY = saved;
    }
  });
});

describe('site: what is left of the passkey limit', () => {
  let web;
  let D;
  before(async () => {
    web = await import('../web/lib/custody/allowanceLeft.ts');
    D = await import('../web/lib/custody/delegations.ts');
  });

  const ENFORCER = new ethers.Interface([
    'function getAvailableAmount(bytes32 _delegationHash, address _delegationManager, bytes _terms) view returns (uint256 availableAmount_, bool isNewPeriod_, uint256 currentPeriod_)',
  ]);
  const signedAt = Math.floor(Date.now() / 1000) - 3600;

  function permissionRow(over = {}) {
    const delegation = {
      delegate: ethers.getAddress(RELAYER),
      delegator: GATOR,
      authority: D.ROOT_AUTHORITY,
      caveats: D.caveatsFor('TUSD', signedAt),
      salt: 7n,
      signature: '0x',
    };
    return {
      account_id: 'payer',
      symbol: 'TUSD',
      status: 'active',
      gator: GATOR,
      delegate: delegation.delegate,
      salt: '7',
      caveats: delegation.caveats,
      digest: D.delegationDigest(delegation),
      signature: '0x' + '11'.repeat(65),
      expires_at: new Date(Date.now() + 7 * 86400e3).toISOString(),
      ...over,
    };
  }

  /** A chain whose period enforcer reports `available` left, or fails. */
  const chainWith = (available, seen = []) => ({
    async call({ to, data }) {
      seen.push(to);
      if (available instanceof Error) throw available;
      ENFORCER.decodeFunctionData('getAvailableAmount', data);
      return ENFORCER.encodeFunctionResult('getAvailableAmount', [available, false, 1n]);
    },
  });

  const left = (db, chainReader, wallet = GATOR) =>
    web.passkeyAllowanceLeft(db, chainReader, { accountId: 'payer', wallet, symbol: 'TUSD', decimals: 6 });

  it('what the period reports, less the owner-key payments it cannot see', async () => {
    const seen = [];
    const db = createFakeSupabase({
      custody_delegations: [permissionRow()],
      transfers: [{ id: 'x', account_id: 'payer', note: 'lunch', phone: 'site', kind: 'transfer', asset: 'TUSD', status: 'confirmed', amount_eth: '12', created_at: new Date().toISOString() }],
    }).client;
    assert.equal(await left(db, chainWith(50_000_000n, seen)), 38_000_000n);
    // It asked the permission's own period enforcer.
    assert.deepEqual(seen, [D.CONTRACTS.erc20PeriodTransferEnforcer]);
    // Never below zero.
    assert.equal(await left(db, chainWith(5_000_000n)), 0n);
  });

  it('no limit applies without a live permission for this wallet and asset', async () => {
    const none = createFakeSupabase({ custody_delegations: [], transfers: [] }).client;
    assert.equal(await left(none, chainWith(1n)), null);
    const revoked = createFakeSupabase({ custody_delegations: [permissionRow({ status: 'revoked' })], transfers: [] }).client;
    assert.equal(await left(revoked, chainWith(1n)), null);
    const expiring = createFakeSupabase({ custody_delegations: [permissionRow({ expires_at: new Date(Date.now() + 60e3).toISOString() })], transfers: [] }).client;
    assert.equal(await left(expiring, chainWith(1n)), null);
    const live = createFakeSupabase({ custody_delegations: [permissionRow()], transfers: [] }).client;
    assert.equal(await left(live, chainWith(1n), '0x' + '77'.repeat(20)), null);
    assert.equal(await web.passkeyAllowanceLeft(live, chainWith(1n), { accountId: 'payer', wallet: GATOR, symbol: 'USDC', decimals: 6 }), null);
  });

  it('a permission that does not match its own digest throws', async () => {
    const db = createFakeSupabase({ custody_delegations: [permissionRow({ salt: '8' })], transfers: [] }).client;
    await assert.rejects(left(db, chainWith(1n)), /does not match its own digest/);
  });

  it('the refusal names what is left; a limit that cannot be read refuses too', async () => {
    const db = createFakeSupabase({ custody_delegations: [permissionRow()], transfers: [] }).client;
    const ask = (chainReader, amount) =>
      web.passkeyLimitRefusal(db, chainReader, {
        route: 'POST /test',
        accountId: 'payer',
        wallet: GATOR,
        symbol: 'TUSD',
        label: 'tUSD',
        amount,
        decimals: 6,
        next: (l) => `Pay ${l} or less.`,
      });
    assert.equal(await ask(chainWith(20_000_000n), 20_000_000n), null);
    assert.equal(
      await ask(chainWith(20_000_000n), 20_000_001n),
      'This is more than your passkey allows today (20.0 tUSD left), so it was not sent. Pay 20.0 tUSD or less.'
    );
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(String(line));
    try {
      assert.match(await ask(chainWith(new Error('rpc down')), 1n), /Could not check your passkey limit right now, so nothing was sent/);
    } finally {
      console.error = original;
    }
    assert.equal(errors.length, 1);
    assert.match(errors[0], /passkey limit/);
  });
});

describe('the site routes check the limit before writing or sending', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('pay page: both the ETH and the token branch, before the transfers row', () => {
    const src = read('web/app/api/pay/execute/route.ts');
    const ethBranch = src.slice(src.indexOf("if (asset === 'ETH') {"), src.indexOf('} else {', src.indexOf("if (asset === 'ETH') {")));
    const tokenBranch = src.slice(src.indexOf('const info = resolveReserveAsset(asset);'));
    for (const body of [ethBranch, tokenBranch]) {
      const check = body.indexOf('passkeyLimitRefusal(');
      assert.ok(check > 0, 'checks the limit');
      assert.ok(check < body.indexOf(".from('transfers')"), 'before the row');
      assert.ok(check < body.indexOf('executeGatorCall('), 'before the send');
    }
  });

  it('checkout: before the transfers row and the send', () => {
    const src = read('web/app/api/checkout/[id]/pay/route.ts');
    const check = src.indexOf('passkeyLimitRefusal(');
    assert.ok(check > 0);
    assert.ok(check < src.indexOf(".from('transfers')"));
    assert.ok(check < src.indexOf('executeGatorCall('));
  });
});
