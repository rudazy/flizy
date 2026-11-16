/**
 * "send all" (lib/router.js handleSendAll): everything the wallet can spend of
 * one asset, through the ordinary send.
 *
 * Covers: the phrasings it reads, and that "send all to john" is no longer an
 * NFT ticker called "all"; ETH leaves Savings and the gas reserve behind, a
 * token leaves its Savings; the preview says it is everything; with fees on
 * the fee comes out of the amount; nothing to send, or all of it in Savings,
 * is said plainly; over the per-send maximum or the daily limit it is refused
 * with what is allowed, never sent short; a phone, email or social handle (a
 * claim hold) is refused; an unlisted asset is refused.
 *
 * Run: node --test test/sendAll.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');
const { PIN_HASH_PRESENT, unlockedSession } = require('./helpers/unlockedChat');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

/** The wallet's balances on chain. Set per test. */
let ethWei = 0n;
let tokenUnits = 0n;
/** The gas reserve the plan keeps back, in ETH. */
let gasReserveEth = '0';

const TUSD = '0x4F28C18600c312Bfa8e8281D882e0EC306F82446';
const ERC20 = new ethers.Interface(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
const runtimePath = require.resolve('../lib/runtime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    chain: { id: 'giwa_sepolia', name: 'GIWA Sepolia', chainId: 91342, nativeSymbol: 'ETH', rpcUrl: 'http://localhost:0' },
    supabase: { from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) },
    provider: {
      getBalance: async () => ethWei,
      getNetwork: async () => ({ chainId: 91342n }),
      getFeeData: async () => ({ maxFeePerGas: 10n ** 7n, gasPrice: 10n ** 7n }),
      call: async ({ data }) => {
        const fn = ERC20.parseTransaction({ data });
        if (fn.name === 'decimals') return ERC20.encodeFunctionResult('decimals', [6]);
        return ERC20.encodeFunctionResult('balanceOf', [tokenUnits]);
      },
    },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};
const gatorPath = require.resolve('../lib/gatorExecute');
const realGator = require('../lib/gatorExecute');
require.cache[gatorPath].exports = {
  ...realGator,
  planGasBufferEth: async () => gasReserveEth,
  gatorGasReserveWei: async () => ethers.parseEther(gasReserveEth),
};
const trustedPath = require.resolve('../lib/trusted');
require.cache[trustedPath] = {
  id: trustedPath,
  filename: trustedPath,
  loaded: true,
  exports: { ...require('../lib/trusted'), isTrustedAddress: async () => true },
};

const router = require('../lib/router');
const { parseSendAllCommand, parseSendNamedAssetCommand } = require('../lib/commands/parse');
const { predictGatorAddress } = require('../lib/gatorAccount');

const ACCOUNT = 'acc-all';
const TG = '778899126';
const KEY = `telegram:${TG}`;
const GATOR = predictGatorAddress(ACCOUNT);
const TO = '0x1111111111111111111111111111111111111111';
const saved = { ...process.env };

function seed(extra = {}) {
  fake = createFakeSupabase({
    accounts: [
      { id: ACCOUNT, email: 'all@example.com', username: 'allsender', balance_eth: 0, is_admin: false, agent_wallet_address: GATOR, unlock_pin_hash: PIN_HASH_PRESENT },
    ],
    channel_identities: [{ id: 'i1', account_id: ACCOUNT, channel: 'telegram', external_id: TG, phone_e164: null }],
    sessions: [unlockedSession(ACCOUNT, 'telegram', TG)],
    users: [],
    link_codes: [],
    trusted_addresses: [],
    transfers: [],
    account_reserves: [],
    fee_ledger: [],
    ...extra,
  });
}

function ctx() {
  const sent = [];
  return {
    sent,
    ctx: {
      channel: 'telegram',
      externalId: TG,
      key: KEY,
      raw: {},
      reply: async (text) => {
        sent.push(text);
      },
      resolveVerifiedPhone: async () => null,
      requestPhone: async () => {},
    },
  };
}
const last = (sent) => sent[sent.length - 1];

beforeEach(() => {
  seed();
  router.discardPendingFlows(KEY);
  ethWei = 0n;
  tokenUnits = 0n;
  gasReserveEth = '0';
  process.env = { ...saved };
  delete process.env.FEES_ENABLED;
});

describe('reading send all', () => {
  it('ETH when no asset is named, the asset when one is, and every recipient shape', () => {
    assert.deepEqual(
      [parseSendAllCommand('send all to john').asset, parseSendAllCommand('Send all FLZ to @bob').asset, parseSendAllCommand(`send all eth to ${TO}`).isAddress],
      ['ETH', 'FLZ', true]
    );
    assert.equal(parseSendAllCommand('send all to 123456789').toRaw, '123456789');
    for (const t of ['send all', 'send all to', 'send allflz to john', 'send 1 to john']) assert.equal(parseSendAllCommand(t), null, t);
  });

  it('"send all to john" reaches send all, not an NFT called "all"', async () => {
    // The named-asset parser still reads it; send all is checked first.
    assert.ok(parseSendNamedAssetCommand('send all to john'));
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'router.js'), 'utf8');
    const at = src.indexOf('const sendAllCmd = parseSendAllCommand(text);');
    for (const later of ['const mintCmd = parseMintCommand(text);', 'const nftSend = parseNftSendCommand(text);', 'const namedSend = parseSendNamedAssetCommand(text);']) {
      assert.ok(at > 0 && at < src.indexOf(later), later);
    }
    ethWei = 5n * 10n ** 16n;
    const { sent, ctx: c } = ctx();
    await router.handle(c, `send all to ${TO}`);
    assert.match(last(sent), /Transfer plan/);
  });
});

describe('send all', () => {
  it('ETH: everything but Savings and the gas reserve, and the preview says so', async () => {
    ethWei = 5n * 10n ** 16n;
    gasReserveEth = '0.001';
    fake.db.tables.account_reserves.push({ account_id: ACCOUNT, asset: 'ETH', amount: String(10n ** 16n) });
    const { sent, ctx: c } = ctx();
    await router.handle(c, `send all to ${TO}`);
    const preview = last(sent);
    assert.match(preview, /^Amount: {2}0\.039 ETH$/m);
    assert.match(preview, /Everything you can send\. Savings stay where they are\./);
    assert.equal(router.pendingFlowFor(KEY).send, true);
  });

  it('a token: everything but its Savings', async () => {
    tokenUnits = 25_500_000n;
    fake.db.tables.account_reserves.push({ account_id: ACCOUNT, asset: 'TUSD', amount: '500000' });
    const { sent, ctx: c } = ctx();
    await router.handle(c, `send all tusd to ${TO}`);
    assert.match(last(sent), /^Amount: {2}25 tUSD$/im);
  });

  it('fees on: the fee comes out of the amount, and the preview shows what arrives', async () => {
    process.env.FEES_ENABLED = 'true';
    process.env.FEE_TREASURY_ADDRESS = '0x' + '7e'.repeat(20);
    ethWei = 10n ** 16n;
    const { sent, ctx: c } = ctx();
    await router.handle(c, `send all to ${TO}`);
    const preview = last(sent);
    assert.match(preview, /taken from the 0\.01 ETH you asked to send/);
    assert.match(preview, /They get: 0\.009993333333333333 ETH/);
  });

  it('nothing to send: said plainly, with why', async () => {
    const cases = [
      [0n, null, 'Your Flizy wallet has no ETH. There is nothing to send.'],
      [10n ** 17n, String(10n ** 17n), 'All your ETH is in Savings. There is nothing to send.'],
      [10n ** 15n, null, 'What is left is in Savings or kept for gas. There is nothing to send.'],
    ];
    for (const [bal, savedAmount, text] of cases) {
      seed();
      ethWei = bal;
      gasReserveEth = '0.001';
      if (savedAmount) fake.db.tables.account_reserves.push({ account_id: ACCOUNT, asset: 'ETH', amount: savedAmount });
      const { sent, ctx: c } = ctx();
      await router.handle(c, `send all to ${TO}`);
      assert.equal(last(sent), text);
      assert.equal(router.pendingFlowFor(KEY).send, false);
    }
  });

  it('over the daily limit: refused with what is left today, never sent short', async () => {
    ethWei = 5n * 10n ** 16n;
    fake.db.tables.accounts[0].daily_send_limit_eth = '0.02';
    const { sent, ctx: c } = ctx();
    await router.handle(c, `send all to ${TO}`);
    assert.match(last(sent), /Daily send limit reached\./);
    assert.match(last(sent), /Remaining: 0\.02 ETH/);
    assert.equal(router.pendingFlowFor(KEY).send, false);
  });

  it('over the per-send maximum: refused, saying what all came to and how to send part', async () => {
    ethWei = 10n ** 18n;
    const { sent, ctx: c } = ctx();
    await router.handle(c, `send all to ${TO}`);
    assert.equal(
      last(sent),
      `All you can send is 1 ETH, more than the 0.1 ETH one send can be, so nothing was sent.\nSend part of it: /send 0.1 to ${TO}`
    );
    assert.equal(router.pendingFlowFor(KEY).send, false);
  });

  it('a phone number, email or social handle: refused, nothing read or held', async () => {
    ethWei = 10n ** 18n;
    for (const target of ['+2348012345678', 'bob@example.com', '@bob on github']) {
      const { sent, ctx: c } = ctx();
      await router.handle(c, `send all to ${target}`);
      assert.match(last(sent), /^Send all goes to a Flizy username, a pay code, a saved name or a wallet address\./, target);
      assert.equal(router.pendingFlowFor(KEY).send, false, target);
    }
  });

  it('an asset that cannot be sent from chat is refused', async () => {
    const { sent, ctx: c } = ctx();
    await router.handle(c, `send all maki to ${TO}`);
    assert.doesNotMatch(last(sent), /Transfer plan/);
    assert.equal(router.pendingFlowFor(KEY).send, false);
  });
});
