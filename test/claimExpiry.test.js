/**
 * Chat claims nobody receives come back to the sender (lib/claimExpiry.js).
 *
 * Covers: the deadline (CLAIM_EXPIRY_DAYS, default 90) and how it reads in
 * chat; a claim from before deadlines gets one from when it was sent; a claim
 * past it is locked before it is refunded, and one the recipient got first is
 * left alone; the refund's hash is stored before the broadcast; nothing moved
 * releases the lock for the next pass; an unknown outcome keeps the lock and
 * the hash; a stored hash is settled from its receipt, never sent twice; the
 * sender is told; Flizy Pay API claims are never touched; past its deadline a
 * claim cannot be received on the site or in chat.
 *
 * Run: node --test test/claimExpiry.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const X = require('../lib/claimExpiry');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const NOW = Date.parse('2027-03-01T12:00:00.000Z');
const SENDER = '11111111-1111-4111-8111-111111111111';
const HASH = '0x' + 'ab'.repeat(32);
const quiet = { warn() {}, error() {} };

function claim(over = {}) {
  return {
    id: 'c1',
    status: 'pending',
    from_account_id: SENDER,
    to_email: 'ada@example.com',
    amount_eth: '5',
    asset: 'TUSD',
    nft_token_id: null,
    api_transaction_id: null,
    refund_tx_hash: null,
    created_at: '2026-11-18T10:00:00.000Z',
    expires_at: '2027-02-16T10:00:00.000Z',
    ...over,
  };
}

/** The fake database, the claims locks on it, a refund that does what it is told, and a chain. */
function world(rows, { refundOut = { ok: true, outcome: 'moved', refundTxHash: HASH }, receipt = null, broadcast = true } = {}) {
  const fake = createFakeSupabase({ claims: rows });
  const table = () => fake.db.tables.claims;
  const byId = (id) => table().find((c) => c.id === id);
  const claims = {
    async beginClaimProcessing(id) {
      const c = byId(id);
      if (!c || c.status !== 'pending') return null;
      c.status = 'processing';
      return { ...c };
    },
    async releaseClaimProcessing(id) {
      const c = byId(id);
      if (c && c.status === 'processing') c.status = 'pending';
    },
    cancelled: [],
    async cancelClaim(id, from, hash) {
      const c = byId(id);
      if (!c || c.status !== 'processing' || c.from_account_id !== from) return { ok: false };
      c.status = 'cancelled';
      c.refund_tx_hash = hash;
      claims.cancelled.push([id, hash]);
      return { ok: true, claim: c };
    },
  };
  const refunds = [];
  const refund = async (args) => {
    refunds.push(args);
    assert.equal(args.held, true, 'the worker always holds the claim first');
    assert.equal(byId(args.claimId).status, 'processing', 'locked before anything moves');
    if (broadcast) await args.onBroadcast(HASH);
    if (refundOut.ok) {
      byId(args.claimId).status = 'cancelled';
    }
    return refundOut;
  };
  const told = [];
  const worker = X.makeClaimExpiryWorker({
    supabase: fake.client,
    provider: { getTransactionReceipt: async () => receipt },
    chain: {},
    notifyAccount: async (id, text) => told.push([id, text]),
    env: {},
    now: () => NOW,
    log: quiet,
    refund,
    claims,
  });
  return { fake, worker, refunds, told, claims, byId };
}

describe('the deadline', () => {
  it('90 days by default, set by CLAIM_EXPIRY_DAYS, and a malformed setting throws', () => {
    assert.equal(X.claimExpiryDays({}), 90);
    assert.equal(X.claimExpiryDays({ CLAIM_EXPIRY_DAYS: ' 30 ' }), 30);
    for (const bad of ['0', '-1', '1.5', 'ninety', '3651']) assert.throws(() => X.claimExpiryDays({ CLAIM_EXPIRY_DAYS: bad }), /CLAIM_EXPIRY_DAYS/, bad);
    assert.equal(X.claimDeadline('2026-11-18T10:43:41.000Z', {}), '2027-02-16T10:43:41.000Z');
    assert.equal(X.claimDeadline('2026-11-18T10:43:41.000Z', { CLAIM_EXPIRY_DAYS: '7' }), '2026-11-25T10:43:41.000Z');
    assert.equal(X.deadlineDay('2027-02-16T10:43:41.000Z'), '16 Feb 2027');
    assert.equal(X.deadlineDay('nope'), '');
  });

  it('a new chat claim gets its deadline when it is created; an API claim keeps its own', () => {
    const src = read('lib/claims.js');
    assert.match(src, /row\.expires_at = p\.expiresAt \|\| null;\s+\} else \{\s+\/\/[^\n]*\n\s+row\.expires_at = claimDeadline\(new Date\(\)\.toISOString\(\)\);/);
  });

  it('chat tells the sender when it comes back', () => {
    assert.match(read('lib/router.js'), /result\.claim\?\.expires_at \? `Not received by \$\{deadlineDay\(result\.claim\.expires_at\)\}\? It comes back to you by itself\.` : null,/);
  });

  it('a claim from before deadlines gets one from when it was sent; nothing else is touched', async () => {
    const w = world([
      claim({ id: 'old', expires_at: null }),
      claim({ id: 'api', expires_at: null, api_transaction_id: 'tx-1' }),
      claim({ id: 'done', expires_at: null, status: 'claimed' }),
      claim({ id: 'set', expires_at: '2027-06-01T00:00:00.000Z' }),
    ]);
    assert.equal(await w.worker.fillDeadlines(), 1);
    assert.equal(w.byId('old').expires_at, '2027-02-16T10:00:00.000Z');
    assert.equal(w.byId('api').expires_at, null);
    assert.equal(w.byId('done').expires_at, null);
    assert.equal(w.byId('set').expires_at, '2027-06-01T00:00:00.000Z');
  });
});

describe('past the deadline', () => {
  it('locked, refunded to the sender with the hash stored first, and the sender is told', async () => {
    const w = world([claim(), claim({ id: 'young', expires_at: '2027-04-01T00:00:00.000Z' }), claim({ id: 'api', api_transaction_id: 'tx-1' })]);
    assert.equal(await w.worker.expireDue(), 1);
    assert.deepEqual(w.refunds.map((r) => [r.claimId, r.fromAccountId]), [['c1', SENDER]]);
    assert.equal(w.byId('c1').refund_tx_hash, HASH);
    assert.equal(w.byId('young').status, 'pending');
    assert.equal(w.byId('api').status, 'pending', 'an API claim is the payout worker\'s');
    assert.equal(w.told.length, 1);
    assert.equal(w.told[0][0], SENDER);
    assert.equal(w.told[0][1], 'A payment you sent was not received within 90 days, so it came back to you.\n5 tUSD for ada@example.com is back in your Flizy wallet.');
  });

  it('a claim the recipient locked first is theirs: no refund', async () => {
    const w = world([claim({ status: 'processing' })]);
    assert.equal(await w.worker.expireDue(), 0);
    assert.equal(w.refunds.length, 0);
  });

  it('nothing moved: the hash is forgotten and the lock released, so the next pass tries again', async () => {
    for (const out of [{ ok: false, outcome: 'not_sent' }, { ok: false, outcome: 'reverted' }, { ok: false, error: 'Escrow cannot refund right now (insufficient gas). Try later.' }]) {
      const w = world([claim()], { refundOut: out, broadcast: out.outcome === 'reverted' });
      assert.equal(await w.worker.expireDue(), 0);
      assert.equal(w.byId('c1').status, 'pending', JSON.stringify(out));
      assert.equal(w.byId('c1').refund_tx_hash, null, JSON.stringify(out));
      assert.equal(w.told.length, 0);
    }
  });

  it('an outcome nobody knows keeps the lock and the hash: never a second refund', async () => {
    const w = world([claim()], { refundOut: { ok: false, outcome: 'unknown' } });
    await w.worker.expireDue();
    assert.equal(w.byId('c1').status, 'processing');
    assert.equal(w.byId('c1').refund_tx_hash, HASH);
    assert.equal(await w.worker.expireDue(), 0, 'a held claim is not picked up again');
    assert.equal(w.refunds.length, 1);
  });

  it('money moved but the claim was not closed (an NFT records no hash first): the hash is kept for the receipt check', async () => {
    const w = world([claim({ nft_token_id: '7' })], { refundOut: { ok: false, outcome: 'moved', refundTxHash: HASH }, broadcast: false });
    await w.worker.expireDue();
    assert.equal(w.byId('c1').status, 'processing');
    assert.equal(w.byId('c1').refund_tx_hash, HASH);
  });
});

describe('a refund already broadcast', () => {
  it('confirmed: the claim is closed and the sender told, with no second send', async () => {
    const w = world([claim({ status: 'processing', refund_tx_hash: HASH })], { receipt: { status: 1 } });
    assert.equal(await w.worker.settleRecorded(), 1);
    assert.deepEqual(w.claims.cancelled, [['c1', HASH]]);
    assert.equal(w.refunds.length, 0);
    assert.equal(w.told.length, 1);
  });

  it('no receipt yet: it waits', async () => {
    const w = world([claim({ status: 'processing', refund_tx_hash: HASH })], { receipt: null });
    assert.equal(await w.worker.settleRecorded(), 0);
    assert.equal(w.byId('c1').status, 'processing');
    assert.equal(w.refunds.length, 0);
  });

  it('reverted: nothing moved, so it is sent again', async () => {
    const w = world([claim({ status: 'processing', refund_tx_hash: HASH })], { receipt: { status: 0 } });
    assert.equal(await w.worker.settleRecorded(), 1);
    assert.equal(w.refunds.length, 1);
  });

  it('only a refund this worker recorded: a processing claim with no hash, or an API claim, is left alone', async () => {
    const w = world([claim({ status: 'processing' }), claim({ id: 'api', status: 'processing', refund_tx_hash: HASH, api_transaction_id: 'tx-1' })], { receipt: { status: 1 } });
    assert.equal(await w.worker.settleRecorded(), 0);
    assert.deepEqual(w.claims.cancelled, []);
  });
});

describe('the worker', () => {
  it('one pass fills deadlines, settles, then refunds, and never throws', async () => {
    // The old claim's new deadline (sent 18 Nov, so 16 Feb) has passed too: both come back in the same pass.
    const w = world([claim({ id: 'old', expires_at: null }), claim(), claim({ id: 'young', created_at: '2027-02-20T00:00:00.000Z', expires_at: null })]);
    assert.deepEqual(await w.worker.tick(), { filled: 2, settled: 0, refunded: 2 });
    assert.equal(w.byId('young').status, 'pending');
    const broken = X.makeClaimExpiryWorker({ supabase: { from() { throw new Error('down'); } }, provider: {}, chain: {}, notifyAccount: async () => {}, log: quiet, refund: async () => ({}), claims: {} });
    assert.deepEqual(await broken.tick(), { filled: 0, settled: 0, refunded: 0 });
  });

  it('runs from the WhatsApp process only, and a malformed setting stops it at startup', () => {
    assert.match(read('index.js'), /startClaimExpiryWorker\(\{ supabase, provider, chain, notifyAccount \}\);/);
    assert.doesNotMatch(read('telegram.js'), /startClaimExpiryWorker/);
    // The Telegram bot makes claims too: it checks the setting before it starts.
    assert.match(read('telegram.js'), /claimExpiryDays\(\);\s+await bot\.start\(\);/);
    assert.throws(() => X.startClaimExpiryWorker({ env: { CLAIM_EXPIRY_DAYS: 'x' } }), /CLAIM_EXPIRY_DAYS/);
  });
});

describe('past its deadline a claim cannot be received', () => {
  it('on the site', () => {
    assert.match(read('web/lib/claimPayout.ts'), /if \(claim\.expires_at && Date\.parse\(String\(claim\.expires_at\)\) <= Date\.now\(\)\) \{\s+await refused\('expired'\);\s+return \{ ok: false, error: 'This payment expired and is going back to the sender\.', status: 410 \};/);
  });

  it('in chat', () => {
    const src = read('lib/engine/executeClaim.js');
    const payout = src.slice(src.indexOf('async function executeClaimPayout'));
    assert.match(payout, /if \(claim\.expires_at && Date\.parse\(claim\.expires_at\) <= Date\.now\(\)\) \{\s+await recordClaimEvent\(getSupabase\(\), claimId, 'claim_refused', \{ meta: \{ reason: 'expired' \} \}\);\s+return \{ ok: false, error: 'This payment expired and is going back to the sender\.' \};/);
    assert.ok(payout.indexOf("reason: 'expired'") < payout.indexOf('recipientFromRow(claim)'), 'before anything else');
  });
});
