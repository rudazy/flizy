/**
 * The building blocks for charging a payment fee (Phase 0d, part 1), none of
 * them wired into a payment yet: the quote (lib/feeQuote.js), the fee ledger
 * row, the gas Flizy paid, the batch UserOp encoding (lib/gatorExecute.js) and
 * the two-transfer redeem (lib/custody/delegations.js).
 *
 * Covers: prices for ETH, tUSD and FLZ (from pool reserves); the tier fee on a
 * calm network, the gap absorbed on a busy one, gas plus margin once today's
 * absorbed total would pass the cap, and the log line for every gas-over-tier
 * case; only today's absorbed rows counting; a ledger row written once per
 * source; gas paid on the relayer and wallet paths; and the batch and redeem
 * encodings and their limits.
 *
 * Run: node --test test/feeQuote.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

// The FLZ pool, scripted: 1,000 FLZ against 1 WETH, so FLZ is $3 at $3,000 ETH.
const dex = require('../lib/dex');
dex.getPairReserves = async () => ({ reserveIn: 1000n * 10n ** 18n, reserveOut: 10n ** 18n });
const Q = require('../lib/feeQuote');
const fees = require('../lib/fees');
const G = require('../lib/gatorExecute');
const C = require('../lib/custody/delegations');

const cfg = fees.feeConfig({});
const usd = (t) => fees.parseUsdMicro(t);
const quiet = { warn() {}, info() {} };
/** A provider whose max fee per gas is maxFee (wei). */
const providerAt = (maxFee) => ({ getFeeData: async () => ({ maxFeePerGas: maxFee, gasPrice: maxFee }) });

describe('prices', () => {
  it('ETH at the configured rate, tUSD at $1, FLZ from the pool', async () => {
    assert.deepEqual(await Q.priceMicroFor('ETH', { cfg }), { priceMicro: usd('3000'), source: 'FEE_ETH_USD_RATE' });
    assert.deepEqual(await Q.priceMicroFor('TUSD', { cfg }), { priceMicro: usd('1'), source: 'tUSD at $1' });
    assert.deepEqual(await Q.priceMicroFor('FLZ', { cfg, chainKey: 'giwa_sepolia' }), { priceMicro: usd('3'), source: 'Flizy FLZ/WETH pool' });
    await assert.rejects(Q.priceMicroFor('USDC', { cfg }), /no fee price/);
  });
});

describe('a person-to-person quote', () => {
  const quote = (supabase, maxFee, extra = {}) =>
    Q.quoteP2pFee({ supabase, provider: providerAt(maxFee), asset: 'TUSD', amountUnits: 150n * 10n ** 6n, chainKey: 'giwa_sepolia', cfg, log: quiet, ...extra });

  it('calm network: the tier fee for $150 is $0.03, in tUSD units', async () => {
    // 0.01 gwei x 300,000 gas = 3e12 wei = $0.009.
    const q = await quote(createFakeSupabase({ fee_ledger: [] }).client, 10n ** 7n);
    assert.deepEqual(
      [q.kind, q.asset, q.feeUnits, q.feeMicro, q.tierMicro, q.gasEstMicro, q.absorbMicro, q.gasOverTier, q.feeText],
      ['p2p', 'TUSD', '30000', '30000', '30000', '9000', '0', false, '$0.03']
    );
    // A plan can store it as it is.
    assert.doesNotThrow(() => JSON.stringify(q));
  });

  it('busy network within 2x: the tier fee, the gap absorbed, and logged', async () => {
    // 0.1 gwei: $0.09 of gas, over 2 x $0.03, so this one is charged gas plus margin.
    const lines = [];
    const log = { warn: (l) => lines.push(l), info() {} };
    const far = await quote(createFakeSupabase({ fee_ledger: [] }).client, 10n ** 8n, { log });
    assert.equal(far.feeMicro, '108000');
    assert.equal(far.gasOverTier, true);
    // 0.04 gwei: $0.036 of gas, $0.0432 with margin, within 2 x $0.03: absorbed.
    const near = await quote(createFakeSupabase({ fee_ledger: [] }).client, 4n * 10n ** 7n, { log });
    assert.deepEqual([near.feeMicro, near.absorbMicro, near.gasOverTier], ['30000', '6000', true]);
    assert.equal(lines.length, 2, 'every gas-over-tier case is logged');
  });

  it('once today\'s absorbed total would pass the cap, gas plus margin; yesterday does not count', async () => {
    const today = new Date().toISOString();
    const yesterday = new Date(Date.now() - 2 * 86400e3).toISOString();
    const full = createFakeSupabase({ fee_ledger: [{ absorbed_usd_micro: '4998000', created_at: today }] }).client;
    assert.equal((await quote(full, 4n * 10n ** 7n)).feeMicro, '43200');
    const old = createFakeSupabase({ fee_ledger: [{ absorbed_usd_micro: '4998000', created_at: yesterday }] }).client;
    assert.equal((await quote(old, 4n * 10n ** 7n)).feeMicro, '30000');
    assert.equal(await Q.absorbedTodayMicro(full), 4_998_000n);
    assert.equal(await Q.absorbedTodayMicro(old), 0n);
  });
});

describe('the fee ledger', () => {
  it('one row per source and kind, with the gas Flizy paid and the net fee', async () => {
    const fake = createFakeSupabase({ fee_ledger: [] });
    const q = await Q.quoteP2pFee({ supabase: fake.client, provider: providerAt(10n ** 7n), asset: 'ETH', amountUnits: 10n ** 16n, cfg, log: quiet });
    const args = { supabase: fake.client, sourceKind: 'transfer', sourceId: '11111111-1111-4111-8111-111111111111', accountId: 'acc-1', txHash: '0x' + 'AB'.repeat(32), quote: q, gasPaid: 10n ** 12n, cfg };
    assert.equal(await Q.recordFee(args), 'recorded');
    assert.equal(await Q.recordFee(args), 'duplicate');
    const rows = fake.db.tables.fee_ledger;
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.deepEqual(
      [r.kind, r.asset, r.fee_units, r.fee_usd_micro, r.gas_paid_wei, r.gas_paid_usd_micro, r.net_usd_micro, r.tx_hash, r.price_source],
      ['p2p', 'ETH', q.feeUnits, '20000', String(10n ** 12n), '3000', '17000', '0x' + 'ab'.repeat(32), 'FEE_ETH_USD_RATE']
    );
  });
});

describe('the gas Flizy paid', () => {
  const EP = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
  const GATOR = '0x' + 'cd'.repeat(20);
  const iface = new ethers.Interface(['event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)']);
  const enc = iface.encodeEventLog('UserOperationEvent', [ethers.ZeroHash, GATOR, ethers.ZeroAddress, 1n, true, 777n, 100n]);
  const receipt = { gasUsed: 200n, gasPrice: 3n, l1Fee: '0x05', logs: [{ address: EP, topics: enc.topics, data: enc.data }] };

  it('relayer: the whole transaction; wallet: the UserOp cost only when the top-up paid it', () => {
    assert.equal(Q.gasPaidWei({ path: 'relayer', receipt }), 605n);
    assert.equal(Q.gasPaidWei({ path: 'wallet', toppedUp: true, receipt, entryPoint: EP, gator: GATOR }), 777n);
    assert.equal(Q.gasPaidWei({ path: 'wallet', toppedUp: false, receipt, entryPoint: EP, gator: GATOR }), 0n);
    assert.equal(Q.gasPaidWei({ path: 'wallet', toppedUp: true, receipt: null }), null);
  });
});

describe('a payment and its fee in one operation', () => {
  const TO = '0x' + '11'.repeat(20);
  const TREASURY = '0x' + '22'.repeat(20);

  it('the batch is the ERC-7579 batch mode with every call, in order', () => {
    const data = G.encodeBatchExecuteCall([
      { target: TO, value: 5n, data: '0x' },
      { target: TREASURY, value: 1n },
    ]);
    const iface = new ethers.Interface(['function execute(bytes32 _mode, bytes _executionCalldata) payable']);
    const [mode, encoded] = iface.decodeFunctionData('execute', data);
    assert.equal(mode, G.BATCH_MODE);
    assert.equal(G.BATCH_MODE, '0x01' + '00'.repeat(31));
    const [calls] = ethers.AbiCoder.defaultAbiCoder().decode(['tuple(address target, uint256 value, bytes callData)[]'], encoded);
    assert.deepEqual(calls.map((c) => [c.target, c.value, c.callData]), [[ethers.getAddress(TO), 5n, '0x'], [ethers.getAddress(TREASURY), 1n, '0x']]);
  });

  it('a batch of one, or of more than four, is refused before anything is read', async () => {
    for (const calls of [[{ target: TO, value: 1n }], Array.from({ length: 5 }, () => ({ target: TO, value: 1n })), [{ target: 'nope', value: 1n }, { target: TO, value: 1n }]]) {
      await assert.rejects(G.executeGatorCall({ accountId: 'acct', provider: {}, calls }), (err) => err.code === 'BAD_BATCH');
    }
  });

  it('the two-transfer redeem uses the same signed permission for each transfer', () => {
    const owner = ethers.Wallet.createRandom();
    const [eth] = C.buildDelegations({ account: '0x' + 'aa'.repeat(20), delegate: '0x' + 'bb'.repeat(20), signedAt: 1_800_000_000, salts: { ETH: 1n, FLZ: 2n, TUSD: 3n } })
      .filter((s) => s.symbol === 'ETH')
      .map((s) => ({ ...s, delegation: { ...s.delegation, signature: owner.signingKey.sign(C.delegationDigest(s.delegation)).serialized } }));
    const DM = new ethers.Interface(['function redeemDelegations(bytes[], bytes32[], bytes[])']);
    const [contexts, modes, executions] = DM.decodeFunctionData('redeemDelegations', C.redeemCalldataMany(eth, [{ to: TO, amount: 10n }, { to: TREASURY, amount: 1n }]));
    const single = DM.decodeFunctionData('redeemDelegations', C.redeemCalldata(eth, { to: TO, amount: 10n }));
    assert.equal(contexts.length, 2);
    assert.equal(contexts[0], single[0][0]);
    assert.equal(contexts[1], single[0][0]);
    assert.deepEqual([...modes], [ethers.ZeroHash, ethers.ZeroHash]);
    assert.equal(executions[0], single[2][0]);
    assert.throws(() => C.redeemCalldataMany(eth, []), /one to four/);
  });
});
