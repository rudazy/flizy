/**
 * Tier 0 (a plain confirm) versus Tier 1 (the PIN): the rule, the known
 * recipient read, the site's approval gate, and the migration behind them.
 *
 * The chat flow is driven in test/chatHardening.test.js; the mirror is pinned
 * in test/tiersDrift.test.js; which routes may skip the PIN is held by
 * test/routeGuards.test.js.
 *
 * Run: node --test test/tiers.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const T = require('../lib/tiers');

const E15 = 10n ** 15n;
const Q = 5n * E15;
const ADDR = '0x5555555555555555555555555555555555555555';
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

describe('evaluateTier', () => {
  const send = (extra) => T.evaluateTier({ action: 'send', native: true, amountWei: Q, quickSendWei: Q, known: true, ...extra });

  it('a known recipient, ETH, at the quick-send amount: Tier 0', () => {
    assert.deepEqual(send({}), { tier: 0, reason: 'quick_send' });
  });

  it('one wei over: the PIN', () => {
    assert.deepEqual(send({ amountWei: Q + 1n }), { tier: 1, reason: 'over_quick_send' });
  });

  it('a new recipient: the PIN', () => {
    assert.deepEqual(send({ known: false }), { tier: 1, reason: 'new_recipient' });
    assert.equal(send({ known: undefined }).tier, 1);
  });

  it('a token or NFT: the PIN, since there is no price to hold it to', () => {
    assert.deepEqual(send({ native: false, amountWei: 1n }), { tier: 1, reason: 'unpriced' });
  });

  it('quick send off, or a zero or missing amount: the PIN', () => {
    assert.deepEqual(send({ quickSendWei: 0n }), { tier: 1, reason: 'quick_send_off' });
    assert.deepEqual(send({ amountWei: 0n }), { tier: 1, reason: 'bad_amount' });
    assert.equal(send({ amountWei: undefined }).tier, 1);
  });

  it('trades are not tiered: the module decides payments only', () => {
    // A swap or liquidity change takes no PIN on testnet and never asks here.
    for (const name of ['swapTier', 'liquidityTier', 'swapsInLastHour']) assert.equal(T[name], undefined, name);
  });

  it('anything else is always the PIN', () => {
    assert.deepEqual(T.evaluateTier({ action: 'other', native: true, amountWei: 1n, quickSendWei: Q, known: true }), {
      tier: 1,
      reason: 'always_pin',
    });
  });
});

describe('quick-send amount', () => {
  it('defaults to the app value and is never above it', () => {
    assert.equal(T.quickSendWei(null, 0.005), Q);
    assert.equal(T.quickSendWei({ quick_send_eth: null }, 0.005), Q);
    assert.equal(T.quickSendWei({ quick_send_eth: '0.002' }, 0.005), 2n * E15);
    assert.equal(T.quickSendWei({ quick_send_eth: '0' }, 0.005), 0n);
    assert.equal(T.quickSendWei({ quick_send_eth: '9' }, 0.005), Q);
    assert.equal(T.quickSendWei({ quick_send_eth: 'junk' }, 0.005), Q);
  });

  it('is 0.005 ETH when nothing is configured', () => {
    assert.equal(require('../lib/config').config.defaultQuickSendEth, 0.005);
  });
});

describe('isKnownRecipient and sendTier', () => {
  function db(tables) {
    return createFakeSupabase({ accounts: [{ id: 'me' }], trusted_addresses: [], known_recipients: [], ...tables });
  }

  it('knows a trusted address past its hold, and not one still held or cancelled', async () => {
    const fake = db({
      trusted_addresses: [{ account_id: 'me', address: ADDR, status: 'active', active_at: hoursAgo(25) }],
    });
    assert.equal(await T.isKnownRecipient(fake.client, 'me', ADDR), true);
    fake.db.tables.trusted_addresses[0].active_at = hoursAgo(-1);
    assert.equal(await T.isKnownRecipient(fake.client, 'me', ADDR), false);
    fake.db.tables.trusted_addresses[0].active_at = hoursAgo(25);
    fake.db.tables.trusted_addresses[0].status = 'cancelled';
    assert.equal(await T.isKnownRecipient(fake.client, 'me', ADDR), false);
  });

  it('knows a paid address after an hour and for 180 days, for that account only', async () => {
    const fake = db({
      known_recipients: [{ account_id: 'me', address: ADDR.toLowerCase(), first_paid_at: hoursAgo(2), last_paid_at: hoursAgo(2) }],
    });
    assert.equal(await T.isKnownRecipient(fake.client, 'me', ADDR), true);
    assert.equal(await T.isKnownRecipient(fake.client, 'someone-else', ADDR), false);
    fake.db.tables.known_recipients[0].first_paid_at = hoursAgo(0.5);
    assert.equal(await T.isKnownRecipient(fake.client, 'me', ADDR), false);
    fake.db.tables.known_recipients[0].first_paid_at = hoursAgo(24 * 300);
    fake.db.tables.known_recipients[0].last_paid_at = hoursAgo(24 * 181);
    assert.equal(await T.isKnownRecipient(fake.client, 'me', ADDR), false);
  });

  it('refuses to call a non-address known', async () => {
    const fake = db({});
    assert.equal(await T.isKnownRecipient(fake.client, 'me', 'not-an-address'), false);
  });

  it('asks for the PIN when the reads fail', async () => {
    const broken = {
      rpc: async () => ({ data: null, error: { message: 'down' } }),
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }),
    };
    assert.equal((await T.sendTier(broken, 'me', ADDR, true, E15)).tier, 1);
    assert.equal(await T.accountQuickSendWei(broken, 'me'), 0n);
  });
});

describe("the site's approval gate", () => {
  let stepUp;
  before(async () => {
    stepUp = await import('../web/lib/stepUp.ts');
  });

  it('Tier 0 goes without a PIN, even on an account that has none', async () => {
    const fake = createFakeSupabase({ accounts: [{ id: 'me', unlock_pin_hash: null }], login_attempts: [] });
    assert.deepEqual(await stepUp.requireApproval(fake.client, 'me', '', 'pay', { tier: 0, reason: 'quick_send' }), { ok: true });
  });

  it('Tier 1 asks for the PIN', async () => {
    const fake = createFakeSupabase({ accounts: [{ id: 'me', unlock_pin_hash: 'x' }], login_attempts: [] });
    const r = await stepUp.requireApproval(fake.client, 'me', '', 'pay', { tier: 1, reason: 'new_recipient' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PIN_REQUIRED');
  });
});

describe('the page decides only what to show', () => {
  let quickSend;
  before(async () => {
    quickSend = await import('../web/lib/quickSend.ts');
  });

  it('compares decimal ETH exactly', () => {
    assert.equal(quickSend.withinQuickSend('0.005', '0.005'), true);
    assert.equal(quickSend.withinQuickSend('0.0050000000000000001', '0.005'), false);
    assert.equal(quickSend.withinQuickSend('0.006', '0.005'), false);
    assert.equal(quickSend.withinQuickSend('0', '0.005'), false);
    assert.equal(quickSend.withinQuickSend('0.001', '0.0'), false);
    assert.equal(quickSend.withinQuickSend('abc', '0.005'), false);
  });
});

describe('migration 20261018100000_known_recipients', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20261018100000_known_recipients.sql'),
    'utf8'
  );

  it('records only confirmed outgoing payments of kind transfer', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.record_known_recipient'));
    assert.match(fn, /new\.status <> 'confirmed'/);
    assert.match(fn, /coalesce\(new\.kind, 'transfer'\) <> 'transfer'/);
    assert.match(fn, /coalesce\(new\.direction, 'out'\) <> 'out'/);
    assert.match(fn, /tg_op = 'UPDATE' and old\.status = 'confirmed'/);
  });

  it('backfills before the trigger exists, so nothing is counted twice', () => {
    assert.ok(sql.indexOf('insert into public.known_recipients') < sql.indexOf('create trigger transfers_record_known_recipient'));
  });

  it('defines known as trusted past its hold, or first paid an hour ago and last within 180 days', () => {
    const fn = sql.slice(sql.indexOf('create or replace function public.is_known_recipient'));
    assert.match(fn, /ta\.status = 'active'\s+and ta\.active_at <= now\(\)/);
    assert.match(fn, /kr\.first_paid_at <= now\(\) - interval '1 hour'/);
    assert.match(fn, /kr\.last_paid_at >= now\(\) - interval '180 days'/);
  });

  it('keeps the table and function away from anon and authenticated, and checks itself', () => {
    assert.match(sql, /revoke all on table public\.known_recipients from public, anon, authenticated;/);
    assert.match(sql, /revoke all on function public\.is_known_recipient\(uuid, text\) from public, anon, authenticated;/);
    assert.match(sql, /alter table public\.known_recipients enable row level security;/);
    assert.match(sql, /raise exception 'transfers_record_known_recipient trigger is missing'/);
  });
});

describe('POST /api/limits', () => {
  // The handler reads a Next request cookie and cannot be imported here, so its
  // source is checked.
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'api', 'limits', 'route.ts'), 'utf8');

  it('answers 400, not 500, to a body that is not an object', () => {
    assert.match(src, /if \(!body \|\| typeof body !== 'object' \|\| Array\.isArray\(body\)\) \{/);
    assert.ok(src.indexOf("Array.isArray(body)") < src.indexOf("'daily_send_limit_eth' in body"));
  });

  it('holds quick send to the default and takes the password', () => {
    assert.match(src, /if \(wei > quickSendCeilingWei\(\)\) \{/);
    assert.match(src, /requirePassword\(\s*supabase,\s*accountId,\s*String\(body\.password \|\| ''\)/);
  });
});

describe('the handover reset forgets who the account paid', () => {
  it('deletes the known recipients with the trusted list', async () => {
    const { resetForNewOwner } = await import('../web/lib/accountReset.ts');
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'accountReset.ts'), 'utf8');
    assert.equal(typeof resetForNewOwner, 'function');
    assert.match(src, /from\('known_recipients'\)\.delete\(\)\.eq\('account_id', accountId\)/);
  });
});
