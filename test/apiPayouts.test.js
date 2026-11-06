/**
 * Flizy Pay API, phase 2a: direct payouts.
 *
 * What is pinned:
 * - the site validates a payout strictly, answers the same `accepted` for any
 *   valid recipient, and never moves money; `accepted` is never completed;
 * - the VPS worker refuses before any money moves when the platform is paused,
 *   the key was revoked or lost payout, the asset is not enabled, the amount is
 *   over Flizy's per-payout or rolling-day limit, or the recipient is invalid or
 *   the platform itself; it waits, refusing nothing, while a payout switch is
 *   off or the account is busy;
 * - it pays only through the platform's allowance (ownerKey false), stores the
 *   hash before the broadcast, and confirms only on success; a refusal by the
 *   allowance fails with its reason; an unknown outcome is settled from the
 *   receipt later;
 * - the allowance sender uses its own relayer key, never one shared with
 *   another role, and only this platform's live allowance;
 * - the policy skips only the session check for an API payout;
 * - the migration, the allowance builder and the limits keep their rules.
 *
 * Run: node --test test/apiPayouts.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SQL = read('supabase/migrations/20261105120000_api_payouts.sql');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) });

// Replace what the worker calls in the engine and in the relayer, before it binds them.
const engine = require('../lib/engine');
const redeem = require('../lib/custody/redeem');
const reserves = require('../lib/reserves');
const agentWallet = require('../lib/agentWallet');
const gatorExecute = require('../lib/gatorExecute');
const accountTxLock = require('../lib/accountTxLock');
const dailyLimits = require('../lib/dailyLimits');
const payCode = require('../lib/payCode');

const PLATFORM = 'plat-1';
const ACCOUNT = 'acct-platform';
const WALLET = '0x' + 'ab'.repeat(20);
const ALICE_WALLET = '0x' + 'a1'.repeat(20);
const HASH = '0x' + 'cd'.repeat(32);

const seen = { executor: [], policy: [], locks: [], released: 0 };
let executorImpl;
let lockFree = true;
engine.evaluateSendPolicy = async (intent, opts) => {
  seen.policy.push(opts);
  return { decision: 'ALLOW', checks: {} };
};
engine.buildSendPlan = (args) => ({ intent: 'SEND', input: { amount: args.intent.amountEth }, route: { toAddress: args.intent.toAddress }, actor: args.intent.actor });
engine.assertPlanFunded = () => ({ ok: true });
engine.executeNativeSend = async (args) => {
  seen.executor.push(args);
  return executorImpl(args);
};
reserves.refusePlanSpend = async () => ({ ok: true });
agentWallet.ensureAgentWallet = async () => ({ agent_wallet_address: WALLET });
gatorExecute.planGasBufferEth = async () => '0.001';
accountTxLock.tryAccountTxLock = async (db, id, kind) => {
  seen.locks.push(kind);
  return lockFree ? { ok: true } : { ok: false, error: 'busy' };
};
accountTxLock.releaseAccountTxLock = async () => {
  seen.released += 1;
};
dailyLimits.checkDailySendLimitNow = async () => ({ ok: true });
payCode.resolveFlizyPayDestination = async (db, raw, payer) => {
  if (raw === 'alice') return { found: true, address: ALICE_WALLET, label: '@alice', accountId: 'acct-alice' };
  if (raw === 'naru') return { found: true, self: true };
  return { found: false };
};
let planImpl;
redeem.planPermissionSend = async (args) => planImpl(args);
const sendOk = async (args) => {
  await args.onBroadcast(HASH);
  return { txHash: HASH, receipt: { status: 1 } };
};
let sendImpl = sendOk;
redeem.sendWithPermission = (args) => sendImpl(args);

const W = require('../lib/api/payoutWorker');
const AS = require('../lib/api/allowanceSend');
const D = require('../lib/custody/delegations');
const P = require('../lib/engine/policy');

let L;
let WD;
before(async () => {
  L = await import('../web/lib/apiPayouts.ts');
  WD = await import('../web/lib/custody/delegations.ts');
});

/** The database's move list (api_transition), and the events it writes. */
const MOVES = {
  accepted: ['queued', 'submitted', 'expired', 'failed'],
  queued: ['submitted', 'failed'],
  submitted: ['confirmed', 'claim_pending', 'failed'],
  claim_pending: ['confirmed', 'expired', 'refund_pending'],
  expired: ['refund_pending'],
  refund_pending: ['refunded'],
};
let events;
function withTransitions(client) {
  return {
    from: (t) => client.from(t),
    async rpc(name, args) {
      if (name !== 'api_transition') return client.rpc(name, args);
      const row = fake.db.tables.api_transactions.find((r) => r.id === args.p_transaction_id);
      if (!row || !(MOVES[row.state] || []).includes(args.p_to_state)) {
        return { data: null, error: { message: `api transition ${row && row.state} -> ${args.p_to_state} is not allowed` } };
      }
      events.push(`${row.state}->${args.p_to_state}`);
      row.state = args.p_to_state;
      return { data: 'evt', error: null };
    },
  };
}

const notices = [];
const env = { API_PAYOUTS_ENABLED: 'true', API_RELAYER_KEY: ethers.Wallet.createRandom().privateKey };
const quiet = { warn() {}, info() {}, error() {} };
let receipt;
const provider = {
  getBalance: async () => 10n ** 18n,
  getTransactionReceipt: async () => receipt,
};
const chain = { id: 'giwa_sepolia', chainId: 91342, name: 'GIWA Sepolia', nativeSymbol: 'ETH' };

function payout(over = {}) {
  return {
    id: 'po-1',
    platform_id: PLATFORM,
    key_id: 'key-1',
    kind: 'payout',
    state: 'queued',
    amount: String(ethers.parseEther('0.01')),
    asset: 'ETH',
    recipient_kind: 'username',
    recipient_ref: 'alice',
    reference: null,
    tx_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

let worker;
beforeEach(() => {
  fake = createFakeSupabase({
    api_platforms: [{ id: PLATFORM, account_id: ACCOUNT, display_name: 'Acme\nInc', wallet_address: WALLET, enabled: true }],
    api_keys: [{ id: 'key-1', revoked_at: null, scopes: ['read', 'payout'] }],
    api_control: [{ id: true, payouts_enabled: true }],
    api_platform_limits: [{ platform_id: PLATFORM, symbol: 'ETH', max_payout: String(ethers.parseEther('0.05')), daily_max: String(ethers.parseEther('0.1')) }],
    accounts: [{ id: ACCOUNT, daily_send_limit_eth: null }, { id: 'acct-alice', agent_wallet_address: ALICE_WALLET }],
    api_transactions: [payout()],
    api_allowances: [],
  });
  events = [];
  notices.length = 0;
  Object.assign(seen, { executor: [], policy: [], locks: [], released: 0 });
  lockFree = true;
  receipt = null;
  // By default the executor runs the real allowance sender, which redeems.
  planImpl = async () => ({ route: 'permission', signed: {}, available: 10n ** 18n });
  sendImpl = sendOk;
  executorImpl = async (args) => {
    const sent = await args.permission.send({
      supabase: fake.client,
      provider,
      accountId: ACCOUNT,
      wallet: WALLET,
      symbol: 'ETH',
      amount: 1n,
      to: ALICE_WALLET,
      onBroadcast: async () => {},
    });
    return sent && sent.route === 'permission'
      ? { ok: true, submitted: true, txHash: sent.txHash, transferId: 'tr-1' }
      : { ok: false, submitted: false, reason: 'ALLOWANCE', transferId: 'tr-1' };
  };
  worker = W.makeWorker({
    supabase: withTransitions(fake.client),
    provider,
    chain,
    notifyAccount: async (id, body) => notices.push([id, body]),
    requestPaymentNotice: async () => 'sent',
    env,
    log: quiet,
  });
});
const row = () => fake.db.tables.api_transactions[0];
const run = () => worker.processPayout({ ...row() });

describe('the worker pays a username through the allowance', () => {
  it('records the hash before the broadcast, confirms, links the transfer, and tells the recipient', async () => {
    assert.equal(await run(), 'confirmed');
    assert.deepEqual(events, ['queued->submitted', 'submitted->confirmed']);
    assert.equal(row().tx_hash, HASH);
    assert.equal(row().transfer_id, 'tr-1');
    assert.equal(row().to_address, ALICE_WALLET.toLowerCase());
    assert.equal(seen.executor[0].permission.ownerKey, false, 'allowance only');
    assert.deepEqual(seen.locks, ['api']);
    assert.equal(seen.released, 1);
    assert.equal(seen.policy[0].apiPayout, true);
    assert.equal(seen.policy[0].enforceTrusted, false);
    assert.deepEqual(notices[0], ['acct-alice', 'Acme Inc (Flizy partner) sent you 0.01 ETH.\nIt is in your Flizy wallet: {{cmd:balance}}']);
  });

  it('pays a 0x address too', async () => {
    row().recipient_kind = 'address';
    row().recipient_ref = ALICE_WALLET;
    assert.equal(await run(), 'confirmed');
  });
});

describe('the worker refuses before any money moves', () => {
  const refused = async (code, mutate) => {
    mutate();
    assert.equal(await run(), 'failed');
    assert.equal(row().error_code, code);
    assert.equal(row().state, 'failed');
    assert.equal(seen.executor.length, 0, `${code}: nothing reached the executor`);
  };
  it('platform paused', () => refused('platform_disabled', () => (fake.db.tables.api_platforms[0].enabled = false)));
  it('key revoked', () => refused('key_revoked', () => (fake.db.tables.api_keys[0].revoked_at = new Date().toISOString())));
  it('payout taken off the key', () => refused('key_revoked', () => (fake.db.tables.api_keys[0].scopes = ['read'])));
  it('asset not enabled', () => refused('asset_not_enabled', () => (row().asset = 'FLZ')));
  it('over the per-payout limit', () => refused('over_max_payout', () => (row().amount = String(ethers.parseEther('0.06')))));
  it('over the rolling day, counting other payouts', () =>
    refused('over_daily_max', () =>
      fake.db.tables.api_transactions.push(payout({ id: 'po-0', state: 'confirmed', amount: String(ethers.parseEther('0.095')) }))
    ));
  it('a username that is not payable', () => refused('recipient_not_payable', () => (row().recipient_ref = 'nobody')));
  it('the platform paying itself', () => refused('recipient_is_platform', () => (row().recipient_ref = 'naru')));
  it('the platform wallet as an address', () => refused('recipient_is_platform', () => Object.assign(row(), { recipient_kind: 'address', recipient_ref: WALLET })));
  it('the zero address', () => refused('invalid_recipient', () => Object.assign(row(), { recipient_kind: 'address', recipient_ref: ethers.ZeroAddress })));

  it('a failed or refunded payout in the day does not count against the limit', async () => {
    fake.db.tables.api_transactions.push(payout({ id: 'po-0', state: 'failed', amount: String(ethers.parseEther('0.095')) }));
    assert.equal(await run(), 'confirmed');
  });
});

describe('the worker waits, refusing nothing, when it should not act now', () => {
  it('a payout switch off: handed back, not failed', async () => {
    fake.db.tables.api_control[0].payouts_enabled = false;
    assert.equal(await run(), 'later');
    assert.equal(row().state, 'queued');
    assert.equal(row().lease_until, null);
    assert.equal(await W.makeWorker({ supabase: fake.client, provider, chain, env: { ...env, API_PAYOUTS_ENABLED: 'false' }, log: quiet }).tick(), 0);
  });
  it('another payment from the account in progress', async () => {
    lockFree = false;
    assert.equal(await run(), 'later');
    assert.equal(row().state, 'queued');
    assert.equal(seen.executor.length, 0);
  });
});

describe('what the allowance decides', () => {
  it('over what is left today: failed as allowance_exceeded, and nothing else is tried', async () => {
    planImpl = async () => ({ route: 'over_cap', available: 5n });
    assert.equal(await run(), 'failed');
    assert.equal(row().error_code, 'allowance_exceeded');
    assert.deepEqual(events, ['queued->failed']);
  });
  it('a hash stored just before a broadcast that never happened is cleared, not shown', async () => {
    sendImpl = async (args) => {
      await args.onBroadcast(HASH);
      throw new redeem.PermissionNotUsed('the node refused the relayer transaction');
    };
    assert.equal(await run(), 'failed');
    assert.equal(row().error_code, 'relayer_unavailable');
    assert.equal(row().tx_hash, null);
  });

  it('no allowance signed: failed as no_allowance', async () => {
    planImpl = async () => ({ route: 'owner', reason: 'no permission' });
    assert.equal(await run(), 'failed');
    assert.equal(row().error_code, 'no_allowance');
  });
  it('an unknown outcome stays submitted with its hash, and the receipt settles it', async () => {
    executorImpl = async (args) => {
      await args.permission.send({ supabase: fake.client, provider, accountId: ACCOUNT, wallet: WALLET, symbol: 'ETH', amount: 1n, to: ALICE_WALLET });
      return { ok: false, submitted: true, transferId: 'tr-1' };
    };
    assert.equal(await run(), 'submitted');
    assert.equal(row().state, 'submitted');
    assert.equal(row().tx_hash, HASH);
    row().updated_at = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    await worker.reconcile();
    assert.equal(row().state, 'submitted', 'no receipt yet: left alone');
    receipt = { status: 1 };
    await worker.reconcile();
    assert.equal(row().state, 'confirmed');
  });
  it('a hash recorded but the state never moved (crash): the receipt settles it from queued', async () => {
    Object.assign(row(), { tx_hash: HASH, updated_at: new Date(Date.now() - 3 * 60 * 1000).toISOString() });
    receipt = { status: 0 };
    await worker.reconcile();
    assert.deepEqual(events, ['queued->submitted', 'submitted->failed']);
    assert.equal(row().error_code, 'reverted');
  });
});

describe('the allowance sender', () => {
  it('refuses a relayer key shared with another role, and needs one', () => {
    const k = ethers.Wallet.createRandom().privateKey;
    for (const other of ['PRIVATE_KEY', 'CUSTODY_RELAYER_KEY', 'ESCROW_PRIVATE_KEY']) {
      assert.throws(() => AS.apiRelayerWallet(null, { API_RELAYER_KEY: k, [other]: k }), new RegExp(other));
    }
    assert.equal(AS.apiRelayerWallet(null, {}), null);
    assert.throws(() => AS.apiRelayerWallet(null, { API_RELAYER_KEY: '0x1234' }), /32-byte/);
  });

  it('reads only this platform\'s live allowance, for this account, not near its expiry', async () => {
    const now = new Date();
    const base = { symbol: 'ETH', status: 'active', signature: '0x12', account_id: ACCOUNT, expires_at: new Date(now.getTime() + 86400e3).toISOString() };
    fake.db.tables.api_allowances = [{ ...base, platform_id: 'other' }];
    const load = AS.allowanceLoader(PLATFORM);
    assert.equal(await load(fake.client, ACCOUNT, 'ETH', now), null);
    fake.db.tables.api_allowances.push({ ...base, platform_id: PLATFORM });
    assert.ok(await load(fake.client, ACCOUNT, 'ETH', now));
    assert.equal(await load(fake.client, 'someone-else', 'ETH', now), null);
    fake.db.tables.api_allowances[1].expires_at = new Date(now.getTime() + 60e3).toISOString();
    assert.equal(await load(fake.client, ACCOUNT, 'ETH', now), null);
  });

  it('with no relayer key, sends nothing and says why', async () => {
    const s = AS.apiAllowanceSender({ platformId: PLATFORM, relayer: null, log: quiet });
    assert.equal(await s.send({ supabase: fake.client }), null);
    assert.equal(s.decision.code, 'relayer_unavailable');
  });
});

describe('payout requests on the site', () => {
  it('accept ETH, FLZ and tUSD amounts within the asset precision only', () => {
    assert.equal(L.parsePayoutAmount('0.01', 'ETH'), 10n ** 16n);
    assert.equal(L.parsePayoutAmount('10', 'TUSD'), 10n ** 7n);
    assert.equal(L.parsePayoutAmount('0.0000001', 'TUSD'), null, 'seven places for six decimals');
    for (const bad of ['0', '-1', '1e3', ' ', '01', '1.', 10]) assert.equal(L.parsePayoutAmount(bad, 'ETH'), null, String(bad));
    assert.equal(L.payoutSymbol('tusd'), 'TUSD');
    assert.equal(L.payoutSymbol('USDC'), null);
  });

  it('take usernames and addresses, and refuse 2b recipient types for now', () => {
    assert.deepEqual(L.parseRecipient({ type: 'username', value: '@Alice' }), { type: 'username', value: 'alice' });
    assert.deepEqual(L.parseRecipient({ type: 'address', value: ALICE_WALLET.toUpperCase().replace('0X', '0x') }), { type: 'address', value: ALICE_WALLET });
    assert.throws(() => L.parseRecipient({ type: 'address', value: ethers.ZeroAddress }), /zero address/);
    assert.throws(() => L.parseRecipient({ type: 'username', value: 'a b' }), /valid Flizy username/);
    assert.throws(() => L.parseRecipient({ type: 'phone', value: '+2348000000000' }), (e) => e.code === 'recipient_type_not_supported');
  });

  it('refuse unknown fields, long references and large metadata', () => {
    const ok = { amount: '1', asset: 'tUSD', recipient: { type: 'username', value: 'alice' } };
    assert.equal(L.parsePayoutRequest(ok).amount, 10n ** 6n);
    assert.throws(() => L.parsePayoutRequest({ ...ok, fee: '1' }), /Unknown field/);
    assert.throws(() => L.parsePayoutRequest({ ...ok, reference: 'x'.repeat(121) }), (e) => e.code === 'invalid_reference');
    assert.throws(() => L.parsePayoutRequest({ ...ok, reference: 'a\nb' }), (e) => e.code === 'invalid_reference');
    assert.throws(() => L.parsePayoutRequest({ ...ok, metadata: { x: 'y'.repeat(3000) } }), (e) => e.code === 'invalid_metadata');
    assert.throws(() => L.parsePayoutRequest([]), (e) => e.code === 'invalid_request');
  });

  it('show accepted as not completed, and amounts in the asset unit', () => {
    const base = { id: 'p', amount: '10000000', asset: 'TUSD', recipient_kind: 'username', recipient_ref: 'alice', reference: null, metadata: null, tx_hash: null, error_code: null, created_at: '', updated_at: '' };
    assert.deepEqual([L.payoutView({ ...base, state: 'accepted' }).completed, L.payoutView({ ...base, state: 'accepted' }).amount], [false, '10']);
    assert.equal(L.payoutView({ ...base, state: 'confirmed' }).completed, true);
    assert.equal(L.payoutView({ ...base, state: 'confirmed' }).asset, 'tUSD');
    assert.equal(L.payoutView({ ...base, state: 'confirmed', amount: '10500000' }).amount, '10.5');
    assert.equal(W.plainAmount(20n * 10n ** 6n, 6), '20');
    assert.equal(W.plainAmount(10n ** 15n, 18), '0.001');
  });

  it('use the same assets and decimals as the worker, and tUSD as listed', () => {
    const { listedBySymbol } = require('../lib/listedTokens');
    for (const [k, v] of Object.entries(L.PAYOUT_ASSETS)) {
      assert.deepEqual({ ...v }, { ...W.ASSETS[k] }, k);
    }
    assert.equal(L.PAYOUT_ASSETS.TUSD.decimals, listedBySymbol('TUSD').decimals);
  });

  it('the routes: payout permission, both switches, Idempotency-Key, and a release on a failed insert', () => {
    const post = read('web/app/api/v1/payouts/route.ts');
    assert.match(post, /authenticateApiRequest\(req, db, 'payout'\)/);
    assert.ok(post.indexOf('payoutsEnabled(db)') < post.indexOf('beginIdempotent('));
    assert.match(post, /idempotency_key_required/);
    assert.match(post, /await abandonIdempotent\(db, caller\.keyId, idemKey\);/);
    assert.match(post, /apiJson\(body, caller\.requestId, 202\)/);
    assert.match(post, /insErr\?\.code === '23505'[\s\S]{0,400}idempotency_key_reused/);
    assert.match(post, /authenticateApiRequest\(req, db, 'read'\)/);
    const one = read('web/app/api/v1/payouts/[id]/route.ts');
    assert.match(one, /\.eq\('platform_id', caller\.platformId\)/);
  });
});

describe('the engine policy for an API payout', () => {
  it('skips only the session check, and still refuses an unlinked actor', async () => {
    const intent = { kind: 'send', actor: { accountId: ACCOUNT, channel: 'api', externalId: 'platform:p' }, amountEth: '0.01', toAddress: ALICE_WALLET, asset: 'native' };
    const chat = await P.evaluateSendPolicy(intent, { enforceTrusted: false, skipDailyLimit: true });
    assert.equal(chat.decision, 'DENY', 'without the option, an api actor has no session');
    const api = await P.evaluateSendPolicy(intent, { enforceTrusted: false, skipDailyLimit: true, apiPayout: true });
    assert.notEqual(api.reason, 'no_context');
    const none = await P.evaluateSendPolicy({ ...intent, actor: {} }, { apiPayout: true });
    assert.equal(none.reason, 'not_linked');
  });
});

describe('the allowance itself', () => {
  it('is built for the enabled assets only, at the daily maximum, the same in the bot and the site', () => {
    const args = { account: WALLET, delegate: '0x' + '0d'.repeat(20), signedAt: 1_800_000_000, salts: { TUSD: 7n }, periodAmounts: { TUSD: 500n * 10n ** 6n } };
    const bot = D.buildDelegations(args);
    const site = WD.buildDelegations(args);
    assert.deepEqual(bot.map((d) => d.symbol), ['TUSD']);
    assert.deepEqual(site.map((d) => D.delegationDigest(d.delegation)), bot.map((d) => D.delegationDigest(d.delegation)));
    assert.ok(bot[0].delegation.caveats[0].terms.includes(ethers.toBeHex(500n * 10n ** 6n, 32).slice(2)));
  });
  it('leaves the account\'s own daily permissions exactly as before', () => {
    const args = { account: WALLET, delegate: '0x' + '0d'.repeat(20), signedAt: 1_800_000_000, salts: { ETH: 1n, FLZ: 2n, TUSD: 3n } };
    assert.deepEqual(D.buildDelegations(args).map((d) => d.symbol), ['ETH', 'FLZ', 'TUSD']);
    assert.ok(D.caveatsFor('ETH', 1_800_000_000)[0].terms.startsWith(ethers.toBeHex(10n ** 17n, 32)));
    assert.throws(() => D.caveatsFor('ETH', 1_800_000_000, 0n), /positive bigint/);
  });
});

describe('the migration', () => {
  it('refuses an asset with no limits row, keeps one live allowance per asset, and the worker lease is safe', () => {
    assert.match(SQL, /max_payout::numeric <= daily_max::numeric/);
    assert.match(SQL, /create unique index if not exists api_allowances_one_active\s+on public\.api_allowances \(platform_id, symbol\) where status = 'active';/);
    assert.match(SQL, /state = 'queued' and tx_hash is null and \(lease_until is null or lease_until < now\(\)\)/);
    assert.match(SQL, /for update skip locked;/);
    assert.match(SQL, /perform public\.api_transition\(picked\.id, 'queued', '\{\}'::jsonb\);/);
    for (const t of ['api_platform_limits', 'api_allowances']) assert.match(SQL, new RegExp(`alter table public\\.${t} enable row level security;`));
    assert.match(SQL, /revoke all on function public\.api_claim_payout\(integer\) from public, anon, authenticated;/);
  });
});
