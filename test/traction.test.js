/**
 * The traction metrics (web/lib/traction.ts) on a small fixture whose answers
 * were worked out by hand, both with and without the excluded accounts; the
 * loader, the snapshot job, the CSV, the admin gate and the migration.
 *
 * Fixture, weeks starting Monday 2026-11-09 (W1), 11-16 (W2) and 11-23 (W3,
 * still running at "now", Wednesday 11-25):
 *   A  owner, excluded. Every payment to A is a starter payment.
 *   B  verified, linked in W1, got faucet money in W1.
 *   C  verified, linked in W2, invited, wins a task in W3.
 *   D  not verified. E verified, never linked. F deleted. G has no email.
 *
 * Run: node --test test/traction.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const T = (day, hour = 12) => `2026-11-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const W = (c) => '0x' + c.repeat(40);

let M;
before(async () => {
  M = await import('../web/lib/traction.ts');
});

function fixture() {
  const acct = (id, day, extra = {}) => ({ id, createdAt: T(day), hasEmail: true, verified: true, deleted: false, wallet: W(id.toLowerCase()), ...extra });
  const tr = (id, from, toWallet, day, tag, extra = {}) => ({ id, accountId: from, toAddress: toWallet, status: 'confirmed', kind: 'transfer', at: T(day), tag, ...extra });
  return {
    now: Date.parse(T(25)),
    accounts: [
      acct('A', 9),
      acct('B', 10),
      acct('C', 12),
      acct('D', 17, { verified: false }),
      acct('E', 18),
      acct('F', 11, { deleted: true }),
      acct('9', 19, { hasEmail: false }),
    ],
    links: [
      { accountId: 'A', at: T(9) },
      { accountId: 'B', at: T(11) },
      { accountId: 'C', at: T(17) },
      { accountId: 'D', at: T(18) },
    ],
    transfers: [
      tr('t1', 'B', W('a'), 11, 'starter'),
      tr('t2', 'B', W('c'), 12, null),
      tr('t3', 'B', W('c'), 18, 'organic'),
      tr('t4', 'C', W('b'), 19, 'organic'),
      // An address no account in the fixture holds.
      tr('t5', 'B', W('7'), 19, 'organic'),
      tr('t6', 'B', W('b'), 19, 'organic'),
      tr('t7', 'C', W('d'), 19, 'organic', { kind: 'swap' }),
      tr('t8', 'B', W('d'), 24, 'organic'),
      tr('t9', 'B', W('c'), 24, 'organic', { status: 'failed' }),
      tr('t10', 'B', W('c'), 20, 'organic'),
      tr('t11', 'C', W('b'), 24, 'organic'),
    ],
    apiPayoutTransferIds: ['t10'],
    claims: [
      { fromAccountId: 'C', toAccountId: null, recipientKey: 'k1', status: 'pending', at: T(20), expiresAt: null, fromApi: false, tag: 'organic' },
      { fromAccountId: 'B', toAccountId: 'E', recipientKey: 'k2', status: 'claimed', at: T(13), expiresAt: null, fromApi: false, tag: null },
      { fromAccountId: 'B', toAccountId: null, recipientKey: 'k3', status: 'cancelled', at: T(18), expiresAt: null, fromApi: false, tag: 'organic' },
      { fromAccountId: 'D', toAccountId: null, recipientKey: 'k4', status: 'pending', at: T(17), expiresAt: T(21), fromApi: false, tag: 'organic' },
      { fromAccountId: 'B', toAccountId: null, recipientKey: 'k5', status: 'pending', at: T(19), expiresAt: null, fromApi: true, tag: 'organic' },
    ],
    incentives: [
      { accountId: 'B', at: T(10), kind: 'faucet' },
      { accountId: 'C', at: T(25, 6), kind: 'task' },
    ],
    invites: [{ invitee: 'C', at: T(12) }],
    apiRequests: [
      { platformAccountId: 'B', at: T(20), status: 200 },
      { platformAccountId: 'B', at: T(20), status: 404 },
      { platformAccountId: 'A', at: T(21), status: 200 },
    ],
    apiTransactions: [
      { platformAccountId: 'B', kind: 'payout', state: 'confirmed', at: T(20) },
      { platformAccountId: 'B', kind: 'payout', state: 'failed', at: T(20) },
      { platformAccountId: 'B', kind: 'payment', state: 'confirmed', at: T(21) },
      { platformAccountId: 'B', kind: 'payment', state: 'expired', at: T(21) },
      { platformAccountId: 'A', kind: 'payout', state: 'confirmed', at: T(21) },
    ],
    phones: [
      { accountId: 'A', dial: '44' },
      { accountId: 'B', dial: '234' },
      { accountId: 'C', dial: '1' },
      { accountId: 'D', dial: '' },
    ],
    excluded: ['A'],
  };
}

describe('weeks', () => {
  it('start on Monday 00:00 UTC, and the running week is marked partial', () => {
    assert.equal(new Date(M.weekStart(Date.parse(T(25)))).toISOString(), '2026-11-23T00:00:00.000Z');
    assert.equal(new Date(M.weekStart(Date.parse('2026-11-16T00:00:00.000Z'))).toISOString(), '2026-11-16T00:00:00.000Z');
    const r = M.computeTraction(fixture(), { exclude: true });
    assert.deepEqual(r.weeks.map((w) => [w.week_start, w.partial]), [['2026-11-09', false], ['2026-11-16', false], ['2026-11-23', true]]);
    assert.equal(r.definitionVersion, M.TRACTION_DEFINITION_VERSION);
  });
});

describe('every metric, without the team accounts', () => {
  let w1, w2, w3, r;
  before(() => {
    r = M.computeTraction(fixture(), { exclude: true });
    [w1, w2, w3] = r.weeks;
  });
  const pick = (w, keys) => Object.fromEntries(keys.map((k) => [k, w[k]]));

  it('1-2 registered and activated (email, not deleted; verified and a chat linked, dated by the link)', () => {
    const keys = ['registered_total', 'registered_new', 'activated_total', 'activated_new'];
    assert.deepEqual(pick(w1, keys), { registered_total: 2, registered_new: 2, activated_total: 1, activated_new: 1 });
    assert.deepEqual(pick(w2, keys), { registered_total: 4, registered_new: 2, activated_total: 2, activated_new: 1 });
    assert.deepEqual(pick(w3, keys), { registered_total: 4, registered_new: 0, activated_total: 2, activated_new: 0 });
  });

  it('3-6 first-time payers, active payers, repeat rate, payments per payer', () => {
    const keys = ['first_time_payers', 'active_payers', 'repeat_payers', 'repeat_payer_rate', 'payments', 'payments_per_active_payer'];
    assert.deepEqual(pick(w1, keys), { first_time_payers: 1, active_payers: 1, repeat_payers: 0, repeat_payer_rate: 0, payments: 2, payments_per_active_payer: 2 });
    assert.deepEqual(pick(w2, keys), { first_time_payers: 2, active_payers: 3, repeat_payers: 1, repeat_payer_rate: 0.3333, payments: 4, payments_per_active_payer: 1.33 });
    assert.deepEqual(pick(w3, keys), { first_time_payers: 0, active_payers: 2, repeat_payers: 2, repeat_payer_rate: 1, payments: 2, payments_per_active_payer: 1 });
  });

  it('swaps, self-sends, failed sends and API payouts are not payments; outside wallets are counted apart', () => {
    assert.deepEqual([w1.external_payments, w2.external_payments, w3.external_payments], [0, 1, 0]);
    const { payments } = M.paymentsFrom(fixture(), () => false);
    assert.equal(payments.length, 9);
    assert.equal(payments.some((p) => p.recipient === `a:${'B'}` && p.payer === 'B'), false);
  });

  it('7 repeat pairs so far, and a claim to someone not yet on Flizy keeps its own key', () => {
    assert.deepEqual([w1.repeat_pairs_total, w2.repeat_pairs_total, w3.repeat_pairs_total], [0, 1, 2]);
    const { payments } = M.paymentsFrom(fixture(), () => false);
    assert.ok(payments.some((p) => p.payer === 'C' && p.recipient === 'k:k1'));
    assert.ok(payments.some((p) => p.payer === 'B' && p.recipient === 'a:E'));
  });

  it('8 claims by status, with a pending claim past its expiry shown as expired', () => {
    const keys = ['claims_created', 'claims_claimed', 'claims_cancelled', 'claims_pending', 'claims_expired', 'claim_rate'];
    assert.deepEqual(pick(w1, keys), { claims_created: 1, claims_claimed: 1, claims_cancelled: 0, claims_pending: 0, claims_expired: 0, claim_rate: 1 });
    assert.deepEqual(pick(w2, keys), { claims_created: 3, claims_claimed: 0, claims_cancelled: 1, claims_pending: 1, claims_expired: 1, claim_rate: 0 });
    assert.deepEqual(pick(w3, keys), { claims_created: 0, claims_claimed: 0, claims_cancelled: 0, claims_pending: 0, claims_expired: 0, claim_rate: null });
  });

  it('9 organic, incentivised and untagged payments', () => {
    const keys = ['payments_organic', 'payments_incentivised', 'payments_untagged'];
    assert.deepEqual(pick(w1, keys), { payments_organic: 0, payments_incentivised: 0, payments_untagged: 2 });
    assert.deepEqual(pick(w2, keys), { payments_organic: 4, payments_incentivised: 0, payments_untagged: 0 });
    assert.deepEqual(pick(w3, keys), { payments_organic: 2, payments_incentivised: 0, payments_untagged: 0 });
  });

  it('10 API activity and success rates, per week the request or payout was made', () => {
    const keys = ['api_requests', 'api_request_errors', 'api_platforms_active', 'api_payouts_created', 'api_payouts_confirmed', 'api_payouts_failed', 'api_payout_success_rate', 'api_payments_created', 'api_payments_confirmed', 'api_payments_expired', 'api_payment_success_rate'];
    assert.deepEqual(pick(w2, keys), {
      api_requests: 2,
      api_request_errors: 1,
      api_platforms_active: 1,
      api_payouts_created: 2,
      api_payouts_confirmed: 1,
      api_payouts_failed: 1,
      api_payout_success_rate: 0.5,
      api_payments_created: 2,
      api_payments_confirmed: 1,
      api_payments_expired: 1,
      api_payment_success_rate: 0.5,
    });
    assert.equal(w1.api_requests, 0);
    assert.equal(w1.api_payout_success_rate, null);
  });

  it('11 registered accounts by verified-phone calling code, the rest unknown', () => {
    assert.deepEqual(r.countries, [
      { dial: '', accounts: 2 },
      { dial: '1', accounts: 1 },
      { dial: '234', accounts: 1 },
    ]);
  });

  it('12 repeat rate of payers given an incentive against the others', () => {
    const keys = ['payers_incentivised', 'payers_incentivised_repeat_rate', 'payers_not_incentivised', 'payers_not_incentivised_repeat_rate'];
    assert.deepEqual(pick(w1, keys), { payers_incentivised: 1, payers_incentivised_repeat_rate: 0, payers_not_incentivised: 0, payers_not_incentivised_repeat_rate: null });
    assert.deepEqual(pick(w2, keys), { payers_incentivised: 1, payers_incentivised_repeat_rate: 1, payers_not_incentivised: 2, payers_not_incentivised_repeat_rate: 0 });
    assert.deepEqual(pick(w3, keys), { payers_incentivised: 2, payers_incentivised_repeat_rate: 1, payers_not_incentivised: 0, payers_not_incentivised_repeat_rate: null });
  });

  it('a qualified referral: invited, chat linked, third organic payment', () => {
    assert.deepEqual(r.weeks.map((w) => [w.referrals_qualified_new, w.referrals_qualified_total]), [[0, 0], [0, 0], [1, 1]]);
  });
});

describe('with the team accounts', () => {
  it('the owner counts again, and so does the starter payment to them', () => {
    const [w1, w2] = M.computeTraction(fixture(), { exclude: false }).weeks;
    assert.equal(w1.registered_total, 3);
    assert.equal(w1.payments, 3);
    assert.equal(w1.payments_incentivised, 1);
    assert.equal(w2.api_requests, 3);
    assert.equal(w2.api_platforms_active, 2);
    assert.equal(w2.api_payout_success_rate, 0.6667);
  });

  it('excluding drops every row an excluded account is on, either side', () => {
    const r = M.computeTraction(fixture(), { exclude: true });
    assert.equal(r.weeks.reduce((n, w) => n + w.payments_incentivised, 0), 0);
    assert.equal(r.countries.some((c) => c.dial === '44'), false);
  });
});

describe('what leaves the module', () => {
  it('carries no id, key, address or phone: numbers, dates and flags only', () => {
    const json = JSON.stringify(M.computeTraction(fixture(), { exclude: false }));
    assert.doesNotMatch(json, /0x[0-9a-f]{40}|k1|"A"|"B"|"C"/);
    for (const w of M.computeTraction(fixture(), { exclude: true }).weeks) {
      for (const [k, v] of Object.entries(w)) {
        if (k === 'week_start') assert.match(v, /^\d{4}-\d{2}-\d{2}$/);
        else if (k === 'partial') assert.equal(typeof v, 'boolean');
        else assert.ok(v === null || typeof v === 'number', k);
      }
    }
  });

  it('the CSV is one row per week, every metric a column', () => {
    const r = M.computeTraction(fixture(), { exclude: true });
    const lines = M.tractionCsv(r).trim().split('\n');
    assert.equal(lines.length, 4);
    assert.ok(lines[0].startsWith('week_start,partial,registered_total,'));
    assert.equal(lines[0].split(',').length, Object.keys(r.weeks[0]).length);
    assert.ok(lines[1].startsWith('2026-11-09,false,2,2,'));
    assert.equal(M.tractionCsv({ ...r, weeks: [] }), '');
  });
});

describe('the loader and the snapshot job', () => {
  function db() {
    return createFakeSupabase({
      accounts: [
        { id: 'a1', created_at: T(10), email: 'x@y.co', email_verified_at: T(10), deleted_at: null, agent_wallet_address: W('1'), is_admin: true },
        { id: 'a2', created_at: T(10), email: 'z@y.co', email_verified_at: null, deleted_at: null, agent_wallet_address: W('2'), is_admin: false },
      ],
      identity_events: [
        { id: 'e1', account_id: 'a2', channel: 'telegram', event_type: 'LINKED', created_at: T(11) },
        { id: 'e2', account_id: 'a2', channel: 'discord', event_type: 'LINKED', created_at: T(11) },
        { id: 'e3', account_id: 'a2', channel: 'telegram', event_type: 'UNLINKED', created_at: T(12) },
      ],
      transfers: [
        { id: 'x1', account_id: 'a2', to_address: W('1'), status: 'confirmed', kind: 'transfer', created_at: T(12), incentive_tag: 'starter' },
        { id: 'x2', account_id: 'a2', to_address: W('1'), status: 'failed', kind: 'transfer', created_at: T(12), incentive_tag: 'organic' },
      ],
      api_transactions: [],
      claims: [{ id: 'c1', from_account_id: 'a2', to_account_id: null, status: 'pending', created_at: T(13), expires_at: null, api_transaction_id: null, to_wa_hint: '2348012345678', to_email: null, to_channel: null, to_external_id: null, incentive_tag: null }],
      faucet_claims: [{ id: 'f1', account_id: 'a2', status: 'sent', created_at: T(10) }, { id: 'f2', account_id: 'a2', status: 'failed', created_at: T(10) }],
      task_winners: [],
      invite_attributions: [],
      api_requests: [],
      api_platforms: [],
      channel_identities: [{ id: 'ci1', account_id: 'a2', phone_e164: '+2348012345678' }],
      metrics_excluded_accounts: [{ account_id: 'a1' }],
      metrics_weekly_snapshots: [],
    });
  }

  it('reads only what the metrics need, and turns phones and claim recipients into codes and keys', async () => {
    const { loadTractionInput } = await import('../web/lib/tractionData.ts');
    const input = await loadTractionInput(db().client, Date.parse(T(25)));
    assert.deepEqual(input.links, [{ accountId: 'a2', at: T(11) }]);
    assert.deepEqual(input.transfers.map((t) => t.id), ['x1']);
    assert.deepEqual(input.incentives, [{ accountId: 'a2', at: T(10), kind: 'faucet' }]);
    assert.deepEqual(input.phones, [{ accountId: 'a2', dial: '234' }]);
    assert.match(input.claims[0].recipientKey, /^[0-9a-f]{24}$/);
    assert.doesNotMatch(JSON.stringify(input.claims), /2348012345678/);
    assert.deepEqual(input.excluded, ['a1']);
  });

  it('keeps every completed week, with and without exclusions, and skips the running one', async () => {
    const { loadTractionInput } = await import('../web/lib/tractionData.ts');
    const { writeTractionSnapshots } = await import('../web/lib/tractionSnapshot.ts');
    const fake = db();
    const input = await loadTractionInput(fake.client, Date.parse(T(25)));
    const written = await writeTractionSnapshots(fake.client, input);
    // Weeks 11-09 and 11-16 are complete; 11-23 is still running. Twice each.
    assert.equal(written, 4);
    const rows = fake.db.tables.metrics_weekly_snapshots;
    assert.deepEqual(rows.map((r) => `${r.week_start}|${r.excluded}`).sort(), ['2026-11-09|false', '2026-11-09|true', '2026-11-16|false', '2026-11-16|true']);
    assert.ok(rows.every((r) => r.definition_version === M.TRACTION_DEFINITION_VERSION && r.metrics.partial === false));
    // Run again: replaced, not duplicated.
    await writeTractionSnapshots(fake.client, input);
    assert.equal(fake.db.tables.metrics_weekly_snapshots.length, 4);
  });
});

describe('who can see it', () => {
  it('the page and the CSV answer only an admin, checked on the server, and the page is noindex', () => {
    const page = read('web/app/dashboard/admin/traction/page.tsx');
    assert.match(page, /if \(!\(await isAdminAccount\(db, await getAccountIdFromCookie\(\)\)\)\) notFound\(\);/);
    assert.match(page, /noindex: true/);
    assert.doesNotMatch(page, /'use client'/);
    const csv = read('web/app/api/admin/traction/route.ts');
    assert.match(csv, /if \(!\(await isAdminAccount\(db, await getAccountIdFromCookie\(\)\)\)\) return NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\);/);
    assert.match(read('web/lib/admin.ts'), /return \(data as \{ is_admin\?: boolean \| null \}\)\.is_admin === true;/);
  });

  it('the snapshot job runs only with CRON_SECRET', () => {
    const job = read('web/app/api/cron/traction-snapshot/route.ts');
    assert.match(job, /if \(!bearerMatches\(req\.headers\.get\('authorization'\), process\.env\.CRON_SECRET\)\) \{/);
  });

  it('the page runs no query of its own: it hands the dashboard only what computeTraction returns', () => {
    const page = read('web/app/dashboard/admin/traction/page.tsx');
    assert.doesNotMatch(page, /\.from\(|\.rpc\(|phone_e164|display_name|agent_wallet/);
    assert.match(page, /const without = computeTraction\(input, \{ exclude: true \}\);\s*const everyone = computeTraction\(input, \{ exclude: false \}\);/);
    assert.match(page, /<TractionDashboard without=\{without\} everyone=\{everyone\} countryNames=\{countryNames\} definitions=\{DEFINITIONS\} \/>/);
    // The dashboard is a view: it never fetches, so nothing reaches the browser but those results.
    const view = read('web/components/TractionDashboard.tsx');
    assert.doesNotMatch(view, /fetch\(|getSupabase|loadTractionInput/);
  });

  it('the dashboard leads with total and new users, and its tables page, sort and summarise', () => {
    const view = read('web/components/TractionDashboard.tsx');
    assert.ok(view.indexOf('label="Total users"') > 0 && view.indexOf('label="Total users"') < view.indexOf('label="New users"'));
    assert.match(view, /value=\{latest \? latest\.registered_new : 0\}/);
    assert.match(view, /const PAGE = 5;/);
    assert.match(view, /aria-sort=\{active \? \(dir === 'asc' \? 'ascending' : 'descending'\) : 'none'\}/);
    assert.match(view, /if \(col\.kind === 'count'\) return String\(weeks\.reduce/);
    assert.match(view, /href=\{`\/api\/admin\/traction\$\{mode === 'without' \? '' : '\?exclude=0'\}`\}/);
  });
});

describe('the migration', () => {
  const sql = read('supabase/migrations/20261111120000_traction_metrics.sql');

  it('new tables have RLS on, no grants to anon or authenticated, and a post-condition', () => {
    for (const t of ['metrics_excluded_accounts', 'metrics_incentive_wallets', 'metrics_weekly_snapshots']) {
      assert.match(sql, new RegExp(`create table if not exists public\\.${t} \\(`));
      assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security;`));
      assert.match(sql, new RegExp(`revoke all on public\\.${t} from anon, authenticated;`));
    }
    assert.match(sql, /raise exception 'traction metrics: RLS is off on %'/);
  });

  it('tags go forward only: the column is added bare, then given its default', () => {
    for (const t of ['transfers', 'claims']) {
      const add = sql.indexOf(`alter table public.${t} add column if not exists incentive_tag text;`);
      const def = sql.indexOf(`alter table public.${t} alter column incentive_tag set default 'organic';`);
      assert.ok(add > 0 && def > add, t);
    }
    assert.doesNotMatch(sql, /update public\.(transfers|claims)/);
  });

  it('a payment to an incentive wallet is tagged with its kind; a tag set on purpose stands', () => {
    assert.match(sql, /if new\.incentive_tag is distinct from 'organic' or new\.to_address is null then\s*return new;/);
    assert.match(sql, /select kind into wallet_kind from public\.metrics_incentive_wallets where address = lower\(new\.to_address\);/);
    assert.match(sql, /before insert on public\.transfers/);
  });

  it('the exclusion list starts with the admins and the starter-pack host', () => {
    assert.match(sql, /select id, 'owner' from public\.accounts where is_admin = true or username = 'ludarep'/);
    assert.match(read('web/lib/starterHost.ts'), /export const STARTER_HOST = 'ludarep';/);
  });
});
