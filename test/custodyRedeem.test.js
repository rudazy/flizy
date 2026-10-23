/**
 * Chat sends through signed permissions (lib/custody/redeem.js).
 *
 * What is pinned: a send goes through a permission only when a live one exists
 * for that asset, names this relayer and this wallet, is not about to expire,
 * and today's allowance covers it; otherwise the owner path is chosen and
 * nothing is sent. The hash is recorded before broadcast. Anything that moved
 * nothing (refused estimate, out of gas, refused broadcast, mined revert) hands
 * back to the owner path; an unknown outcome never does, it raises the error
 * the engine already treats as submitted.
 *
 * The on-chain side runs against the real GIWA contracts in
 * scripts/custody-e2e/redeem-fork-check.cjs.
 *
 * Run: node --test test/custodyRedeem.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const C = require('../lib/custody/delegations');
const R = require('../lib/custody/redeem');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { outcomeUnknown } = require('../lib/gatorExecute');

const ACCOUNT = '0b8c3f2a-1111-4222-8333-444455556666';
const WALLET = ethers.getAddress('0x' + 'aa'.repeat(20));
const relayer = ethers.Wallet.createRandom();
const TO = '0x' + '33'.repeat(20);
const NOW = new Date('2026-10-24T10:00:00Z');
const SIGNED_AT = Math.floor(NOW.getTime() / 1000) - 3600;

function row(symbol, overrides = {}) {
  const [{ delegation }] = C.buildDelegations({
    account: WALLET,
    delegate: overrides.delegate || relayer.address,
    signedAt: SIGNED_AT,
    salts: { ETH: 7n, FLZ: 8n, TUSD: 9n },
  }).filter((d) => d.symbol === symbol);
  return {
    account_id: ACCOUNT,
    symbol,
    gator: delegation.delegator,
    delegate: delegation.delegate,
    salt: delegation.salt.toString(),
    caveats: delegation.caveats,
    digest: C.delegationDigest(delegation),
    signature: '0x' + '11'.repeat(100),
    status: 'active',
    expires_at: new Date((SIGNED_AT + C.EXPIRY_SECONDS) * 1000).toISOString(),
    ...overrides,
  };
}

const ENFORCER = new ethers.Interface([
  'function getAvailableAmount(bytes32,address,bytes) view returns (uint256,bool,uint256)',
]);

/** A provider whose allowance and send behaviour each test sets. */
function provider({ available = 10n ** 17n, estimate = 'ok', balance = 10n ** 18n, broadcast = 'ok', receipt = { status: 1 } } = {}) {
  const calls = [];
  return {
    calls,
    call: async ({ data }) => {
      calls.push('call');
      ENFORCER.decodeFunctionData('getAvailableAmount', data);
      return ENFORCER.encodeFunctionResult('getAvailableAmount', [available, false, 1n]);
    },
    estimateGas: async () => {
      calls.push('estimate');
      if (estimate !== 'ok') throw Object.assign(new Error(estimate), { shortMessage: estimate });
      return 100000n;
    },
    getFeeData: async () => ({ maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n }),
    getBalance: async () => balance,
    // What a real ethers Wallet asks before it can sign.
    getTransactionCount: async () => 0,
    getNetwork: async () => ({ chainId: 91342n }),
    broadcastTransaction: async () => {
      calls.push('broadcast');
      if (broadcast === 'rejected') throw Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' });
      if (broadcast === 'unknown') throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    },
    waitForTransaction: async () => {
      calls.push('wait');
      return receipt;
    },
  };
}

const fakeRelayer = (signedTx = '0x' + 'ab'.repeat(40)) => ({
  address: relayer.address,
  populateTransaction: async (tx) => tx,
  signTransaction: async () => signedTx,
});

const plan = (rows, p, extra = {}) =>
  R.planPermissionSend({
    supabase: createFakeSupabase({ custody_delegations: rows }).client,
    provider: p,
    accountId: ACCOUNT,
    wallet: WALLET,
    symbol: 'ETH',
    amount: 10n ** 16n,
    relayer,
    now: NOW,
    ...extra,
  });

describe('the relayer key and the assets', () => {
  it('reads no key as none, and refuses a malformed one', () => {
    assert.equal(R.relayerWallet(null, ''), null);
    assert.throws(() => R.relayerWallet(null, 'nope'), /32-byte private key/);
    assert.equal(R.relayerWallet(null, relayer.privateKey).address, relayer.address);
  });

  it('knows FLZ and tUSD by address, and nothing else', () => {
    assert.equal(R.symbolForToken(C.ASSETS.FLZ.token.toLowerCase()), 'FLZ');
    assert.equal(R.symbolForToken(C.ASSETS.TUSD.token), 'TUSD');
    assert.equal(R.symbolForToken('0x' + '44'.repeat(20)), null);
    assert.equal(R.symbolForToken('junk'), null);
  });

  it('refuses a stored row that does not match its own digest', () => {
    assert.throws(() => R.signedFromRow({ ...row('ETH'), salt: '99' }), /does not match its own digest/);
  });
});

describe('which way a send goes', () => {
  it('through the permission when today allows it', async () => {
    const out = await plan([row('ETH')], provider());
    assert.equal(out.route, 'permission');
    assert.equal(out.available, 10n ** 17n);
  });

  it('over_cap when the send is bigger than what is left today', async () => {
    const out = await plan([row('ETH')], provider({ available: 10n ** 15n }));
    assert.equal(out.route, 'over_cap');
  });

  it('the owner path for every case the permission cannot serve', async () => {
    const p = provider();
    assert.equal((await plan([row('ETH')], p, { relayer: null })).reason, 'relayer key unset');
    assert.equal((await plan([], p)).reason, 'no permission');
    assert.equal((await plan([row('ETH', { status: 'replaced' })], p)).reason, 'no permission');
    assert.equal((await plan([row('ETH', { signature: null })], p)).reason, 'no permission');
    const soon = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
    assert.equal((await plan([row('ETH', { expires_at: soon })], p)).reason, 'no permission', 'about to expire');
    const other = ethers.Wallet.createRandom().address;
    assert.equal((await plan([row('ETH', { delegate: other })], p)).reason, 'permission names another relayer');
    assert.equal((await plan([row('ETH')], p, { wallet: '0x' + 'bb'.repeat(20) })).reason, 'permission is for another wallet');
    assert.equal((await plan([row('ETH')], p, { symbol: 'DOGE' })).reason, 'asset has no permission');
    assert.equal((await plan([row('ETH')], p, { amount: 0n })).reason, 'amount');
    assert.equal(p.calls.includes('broadcast'), false, 'planning never sends');
  });

  it('reads the allowance for this permission from its own period enforcer', async () => {
    const p = provider();
    const seen = [];
    p.call = async ({ to, data }) => {
      seen.push({ to, args: ENFORCER.decodeFunctionData('getAvailableAmount', data) });
      return ENFORCER.encodeFunctionResult('getAvailableAmount', [1n, false, 1n]);
    };
    const r = row('TUSD');
    await plan([r], p, { symbol: 'TUSD', amount: 1n });
    const signed = R.signedFromRow(r);
    assert.equal(seen[0].to, C.CONTRACTS.erc20PeriodTransferEnforcer);
    assert.equal(seen[0].args[0], C.delegationStructHash(signed.delegation), 'keyed by the struct hash');
    assert.equal(seen[0].args[1], C.CONTRACTS.delegationManager);
    assert.equal(seen[0].args[2], r.caveats[0].terms);
  });
});

describe('sending through the permission', () => {
  const signed = { ...R.signedFromRow(row('ETH')), delegation: { ...R.signedFromRow(row('ETH')).delegation, signature: '0x1234' } };

  it('records the hash before broadcasting, then waits for the receipt', async () => {
    const p = provider();
    const order = [];
    const out = await R.sendWithPermission({
      provider: p,
      relayer: fakeRelayer(),
      signed,
      to: TO,
      amount: 5n,
      onBroadcast: async (hash) => order.push(`record ${hash}`),
    });
    assert.equal(out.txHash, ethers.keccak256('0x' + 'ab'.repeat(40)));
    assert.equal(order[0], `record ${out.txHash}`);
    assert.deepEqual(p.calls, ['estimate', 'broadcast', 'wait']);
  });

  it('hands back, having sent nothing, when the permission would refuse or the relayer has no gas', async () => {
    const refused = provider({ estimate: 'transfer-amount-exceeded' });
    await assert.rejects(() => R.sendWithPermission({ provider: refused, relayer: fakeRelayer(), signed, to: TO, amount: 5n }), R.PermissionNotUsed);
    assert.equal(refused.calls.includes('broadcast'), false);
    const broke = provider({ balance: 0n });
    await assert.rejects(() => R.sendWithPermission({ provider: broke, relayer: fakeRelayer(), signed, to: TO, amount: 5n }), /out of gas/);
    assert.equal(broke.calls.includes('broadcast'), false);
  });

  it('hands back when the record fails, the node refuses, or the transaction reverts', async () => {
    await assert.rejects(
      () => R.sendWithPermission({ provider: provider(), relayer: fakeRelayer(), signed, to: TO, amount: 5n, onBroadcast: async () => { throw new Error('db'); } }),
      /could not record/
    );
    await assert.rejects(() => R.sendWithPermission({ provider: provider({ broadcast: 'rejected' }), relayer: fakeRelayer(), signed, to: TO, amount: 5n }), R.PermissionNotUsed);
    await assert.rejects(() => R.sendWithPermission({ provider: provider({ receipt: { status: 0 } }), relayer: fakeRelayer(), signed, to: TO, amount: 5n }), /reverted/);
  });

  it('never hands back once the outcome is unknown: the engine sees a submitted send', async () => {
    for (const p of [provider({ broadcast: 'unknown' }), provider({ receipt: null })]) {
      const err = await R.sendWithPermission({ provider: p, relayer: fakeRelayer(), signed, to: TO, amount: 5n }).catch((e) => e);
      assert.equal(outcomeUnknown(err), true);
      assert.match(err.txHash, /^0x[0-9a-f]{64}$/);
    }
  });
});

describe('the decision as the engine calls it', () => {
  let lines = [];
  const call = (rows, p, env) => {
    const saved = process.env.CUSTODY_RELAYER_KEY;
    process.env.CUSTODY_RELAYER_KEY = env;
    lines = [];
    const quiet = { warn: (l) => lines.push(l), info: (l) => lines.push(l) };
    return R.trySendWithPermission({
      supabase: createFakeSupabase({ custody_delegations: rows }).client,
      provider: p,
      accountId: ACCOUNT,
      wallet: WALLET,
      symbol: 'ETH',
      amount: 10n ** 16n,
      to: TO,
      log: quiet,
    }).finally(() => {
      process.env.CUSTODY_RELAYER_KEY = saved;
    });
  };

  it('returns null (owner path) with no key, a bad key, or no permission', async () => {
    assert.equal(await call([row('ETH')], provider(), ''), null);
    assert.equal(await call([row('ETH')], provider(), 'not-a-key'), null);
    assert.equal(await call([], provider(), relayer.privateKey), null);
  });

  it('over the cap: sends nothing, never the owner path, and says so for an approval', async () => {
    const p = provider({ available: 1n });
    const out = await call([row('ETH')], p, relayer.privateKey);
    assert.deepEqual(out, { route: 'over_cap', available: 1n, delegate: relayer.address });
    assert.equal(p.calls.includes('broadcast'), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /waiting for a passkey approval/);
    assert.doesNotMatch(lines[0], /owner key/);
  });

  it('returns null when the relayer cannot send before broadcasting', async () => {
    assert.equal(await call([row('ETH')], provider({ estimate: 'nope' }), relayer.privateKey), null);
  });

  it('logs exactly one warning per owner-path send, with the reason and nothing identifying', async () => {
    const cases = [
      [[row('ETH')], provider(), '', /relayer key unset/],
      [[row('ETH')], provider(), 'not-a-key', /relayer key is malformed/],
      [[], provider(), relayer.privateKey, /no permission/],
      [[row('ETH')], provider({ balance: 0n }), relayer.privateKey, /relayer is out of gas/],
      [[row('ETH')], provider({ estimate: `refused at https://rpc.example/v2/SECRETKEY with ${'0x' + 'ab'.repeat(32)}` }), relayer.privateKey, /would refuse/],
    ];
    for (const [rows, p, env, reason] of cases) {
      assert.equal(await call(rows, p, env), null);
      assert.equal(lines.length, 1, `one line for ${reason}`);
      assert.match(lines[0], /^\[custody\] ETH send on the owner key: /);
      assert.match(lines[0], reason);
      for (const leak of [relayer.privateKey.slice(2), ACCOUNT, WALLET.slice(2).toLowerCase(), 'SECRETKEY', 'https://']) {
        assert.equal(lines[0].toLowerCase().includes(leak.toLowerCase()), false, `${leak} must not be logged`);
      }
    }
  });

  it('logs nothing when the permission takes the send', async () => {
    assert.equal((await call([row('ETH')], provider(), relayer.privateKey))?.route, 'permission');
    assert.deepEqual(lines, []);
  });
});
