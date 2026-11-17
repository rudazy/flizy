/**
 * Emailing a claim's recipient who is not on Flizy (Slice 3): the site side
 * (web/lib/claimEmail.ts, /api/internal/claim-notice, the stop link), the bot
 * side (lib/claimEmailNotice.js), and migration 20261117150000.
 *
 * Covers: only after the hold, only a pending claim to an email; never to an
 * address on a Flizy account or a suppressed one; once, and one reminder after
 * the delay; the per-sender and per-address limits and the minimum; notified
 * recorded only when the provider accepted it; no code, password or other
 * request for credentials in the email; suppression blocks emails, not
 * payments; the bot names only the claim; a blocked email still leaves the
 * claim held and tells the sender to share the link.
 *
 * Run: node --test test/claimEmail.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex');

let M;
before(async () => {
  M = await import('../web/lib/claimEmail.ts');
});

const SENDER = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const TOKEN = 'ab'.repeat(16);
const ON = {};

function claim(over = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'pending',
    to_email: 'Ada@Example.com',
    from_account_id: SENDER,
    amount_eth: '5',
    asset: 'TUSD',
    nft_token_id: null,
    claim_token: TOKEN,
    hold_tx_hash: '0x' + 'ab'.repeat(32),
    expires_at: null,
    created_at: '2026-11-20T11:00:00.000Z',
    ...over,
  };
}

/** The fake, with the migration's one-notice-per-claim-and-kind rule. */
function world(seed = {}) {
  const fake = createFakeSupabase({
    claims: [claim()],
    accounts: [{ id: SENDER, username: 'kemi', display_name: 'Kemi', email: 'kemi@example.com' }],
    account_emails: [],
    email_suppressions: [],
    claim_email_notices: [],
    claim_events: [],
    ...seed,
  });
  const from = fake.client.from.bind(fake.client);
  fake.client.from = (table) => {
    const q = from(table);
    if (table !== 'claim_email_notices') return q;
    const insert = q.insert.bind(q);
    q.insert = (row) => {
      if (fake.db.tables.claim_email_notices.some((n) => n.claim_id === row.claim_id && n.kind === row.kind)) {
        return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate' } });
      }
      return insert({ created_at: new Date(NOW).toISOString(), ...row });
    };
    return q;
  };
  const mails = [];
  const send = async (m) => {
    mails.push(m);
    return { ok: true, id: 'm1' };
  };
  return { fake, mails, send, db: fake.client };
}
const go = (w, kind = 'first', over = {}) => M.sendClaimEmail({ db: w.db, claimId: claim().id, kind, env: ON, now: NOW, send: w.send, ...over });

describe('the email', () => {
  it('plain, ASCII, the payment and one link to the claim page; no code, password or request for credentials', () => {
    const m = M.formatClaimEmail({
      sender: '@kemi',
      amount: '5 tUSD',
      sentAt: '2026-11-20T11:00:00.000Z',
      expiresAt: '2026-12-01T00:00:00.000Z',
      claimUrl: `https://flizy.app/claim/${TOKEN}`,
      stopUrl: `https://flizy.app/email/stop?c=${TOKEN}`,
      reference: 'FLZ-33333333',
      origin: 'https://flizy.app',
      reminder: false,
    });
    assert.equal(m.subject, '@kemi sent you 5 tUSD on Flizy (testnet)');
    assert.match(m.text, /^@kemi sent you 5 tUSD on Flizy\.\n\nSent: Fri, 20 Nov 2026 11:00:00 UTC\nCan be claimed until: Tue, 01 Dec 2026 00:00:00 UTC\nThese are test funds on a test network \(testnet\), not real money\./);
    assert.match(m.text, /Open the payment: https:\/\/flizy\.app\/claim\/abab/);
    assert.match(m.text, /Payment reference: FLZ-33333333/);
    assert.match(m.text, /Flizy will never ask for your password or a code by email\. Only open links that start with https:\/\/flizy\.app\./);
    assert.match(m.text, /Don't want emails like this\? Stop these emails: https:\/\/flizy\.app\/email\/stop\?c=abab/);
    for (const t of [m.subject, m.text, m.html]) {
      assert.doesNotMatch(t, /[^\x00-\x7F]/);
      assert.doesNotMatch(t, /<input|<form|type="password"|your code is|login code|verification code/i);
    }
    assert.match(M.formatClaimEmail({ sender: '@kemi', amount: '5 tUSD', sentAt: NOW, expiresAt: null, claimUrl: 'u', stopUrl: 's', reference: 'r', origin: 'o', reminder: true }).subject, /^Reminder: @kemi sent you/);
  });

  it('a sender name is escaped in the HTML', () => {
    const m = M.formatClaimEmail({ sender: '<b>x</b>', amount: '1 ETH', sentAt: NOW, expiresAt: null, claimUrl: 'https://flizy.app/claim/t', stopUrl: 's', reference: 'r', origin: 'o', reminder: false });
    assert.doesNotMatch(m.html, /<b>x<\/b>/);
    assert.match(m.html, /&lt;b&gt;x&lt;\/b&gt;/);
  });
});

describe('when it is sent', () => {
  it('once, to the normalised address, after the hold; notified recorded only then', async () => {
    const w = world();
    assert.equal(await go(w), 'sent');
    assert.equal(w.mails.length, 1);
    assert.equal(w.mails[0].to, 'ada@example.com');
    assert.equal(await go(w), 'already');
    assert.equal(w.mails.length, 1);
    const notice = w.fake.db.tables.claim_email_notices[0];
    assert.deepEqual([notice.kind, notice.state, notice.recipient_hash], ['first', 'sent', sha('ada@example.com')]);
    assert.ok(!JSON.stringify(notice).includes('example.com'), 'the address is not stored');
    assert.deepEqual(w.fake.db.tables.claim_events.map((e) => [e.event, e.channel]), [['notified', 'email']]);
  });

  it('never before the hold landed, for a claim that is not pending, or not to an email', async () => {
    for (const [over, out] of [
      [{ hold_tx_hash: null }, 'not_pending'],
      [{ status: 'claimed' }, 'not_pending'],
      [{ to_email: null }, 'not_email'],
    ]) {
      const w = world({ claims: [claim(over)] });
      assert.equal(await go(w), out);
      assert.equal(w.mails.length, 0);
    }
  });

  it('never to an address on a Flizy account: registration or verified secondary email', async () => {
    let w = world({ accounts: [{ id: SENDER, username: 'kemi' }, { id: 'a2', email: 'ada@example.com' }] });
    assert.equal(await go(w), 'on_flizy');
    w = world({ account_emails: [{ id: 'e1', account_id: 'a2', email: 'ada@example.com', verified_at: '2026-01-01' }] });
    assert.equal(await go(w), 'on_flizy');
    // An unverified secondary row proves nothing: the email goes out.
    w = world({ account_emails: [{ id: 'e1', account_id: 'a2', email: 'ada@example.com', verified_at: null }] });
    assert.equal(await go(w), 'sent');
  });

  it('a stopped address gets no email, and the payment is untouched', async () => {
    const w = world();
    assert.equal(await M.suppressClaimAddress(w.db, TOKEN), 'stopped');
    assert.deepEqual(w.fake.db.tables.email_suppressions.map((s) => s.email_hash), [sha('ada@example.com')]);
    assert.equal(await go(w), 'suppressed');
    assert.equal(w.mails.length, 0);
    assert.equal(w.fake.db.tables.claims[0].status, 'pending');
    assert.equal(await M.suppressClaimAddress(w.db, 'not-a-token'), 'not_found');
  });

  it('exactly one reminder, only after the delay and only after the first went out', async () => {
    const w = world();
    assert.equal(await go(w, 'reminder'), 'too_early');
    const late = NOW + 73 * 3600 * 1000;
    assert.equal(await go(w, 'reminder', { now: late }), 'not_first');
    assert.equal(await go(w), 'sent');
    assert.equal(await go(w, 'reminder', { now: late }), 'sent');
    assert.equal(await go(w, 'reminder', { now: late }), 'already');
    assert.equal(w.mails.length, 2);
    assert.match(w.mails[1].subject, /^Reminder: /);
  });

  it('a failed send is not recorded as notified, and is not sent again', async () => {
    const w = world();
    assert.equal(await go(w, 'first', { send: async () => ({ ok: false, error: 'down' }) }), 'failed');
    assert.equal(w.fake.db.tables.claim_email_notices[0].state, 'failed');
    assert.deepEqual(w.fake.db.tables.claim_events, []);
    assert.equal(await go(w), 'already');
    // A first email that failed is no basis for a reminder.
    assert.equal(await go(w, 'reminder', { now: NOW + 73 * 3600 * 1000 }), 'not_first');
  });

  it('an address is hashed in its normalised form, so case and spaces do not slip past a stop', () => {
    assert.equal(M.emailHash(' Ada@Example.COM '), sha('ada@example.com'));
  });
});

describe('the limits', () => {
  const others = (n, over) =>
    Array.from({ length: n }, (_, i) => ({ id: `n${i}`, claim_id: `c${i}`, kind: 'first', sender_account_id: SENDER, recipient_hash: sha(`x${i}@example.com`), state: 'sent', created_at: '2026-11-20T06:00:00.000Z', ...over }));

  it('at most 10 new addresses a sender emails a day', async () => {
    let w = world({ claim_email_notices: others(10) });
    assert.equal(await go(w), 'limited');
    // Failed ones and yesterday's do not count.
    w = world({ claim_email_notices: [...others(9), ...others(3, { id: 'f', state: 'failed' }).map((n, i) => ({ ...n, id: `f${i}` }))] });
    assert.equal(await go(w), 'sent');
    w = world({ claim_email_notices: others(10, { created_at: '2026-11-19T06:00:00.000Z' }) });
    assert.equal(await go(w), 'sent');
  });

  it('at most 3 emails an address gets a day, from all senders', async () => {
    const w = world({ claim_email_notices: others(3, { sender_account_id: 'someone-else', recipient_hash: sha('ada@example.com') }) });
    assert.equal(await go(w), 'limited');
    assert.equal(w.mails.length, 0);
  });

  it('a minimum when one is set, off by default; settings that are malformed throw', async () => {
    assert.equal(await go(world(), 'first', { env: { CLAIM_EMAIL_MIN_USD: '10' } }), 'below_minimum');
    assert.equal(await go(world(), 'first', { env: { CLAIM_EMAIL_MIN_USD: '5' } }), 'sent');
    assert.equal(await go(world({ claims: [claim({ asset: 'FLZ' })] }), 'first', { env: { CLAIM_EMAIL_MIN_USD: '1' } }), 'below_minimum');
    assert.deepEqual(M.claimEmailConfig({}), { perSenderDay: 10, perAddressDay: 3, reminderHours: 72, minMicro: null });
    for (const env of [{ CLAIM_EMAIL_PER_SENDER_DAY: '1.5' }, { CLAIM_EMAIL_PER_ADDRESS_DAY: '-1' }, { CLAIM_EMAIL_MIN_USD: 'ten' }]) {
      assert.throws(() => M.claimEmailConfig(env), Error, JSON.stringify(env));
    }
  });
});

describe('the bot', () => {
  const E = require('../lib/claimEmailNotice');

  it('names only the claim and the kind, with the secret, and reads back the outcome', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, result: 'limited' }) };
    };
    assert.equal(await E.requestClaimEmail('c1', 'first', { fetch, secret: 's3cret', siteUrl: 'https://flizy.app' }), 'limited');
    assert.equal(calls[0].url, 'https://flizy.app/api/internal/claim-notice');
    assert.deepEqual(JSON.parse(calls[0].init.body), { claimId: 'c1', kind: 'first' });
    assert.equal(calls[0].init.headers.authorization, 'Bearer s3cret');
    assert.equal(await E.requestClaimEmail('c1', 'first', { fetch, secret: '', siteUrl: 'https://flizy.app' }), 'unconfigured');
    assert.equal(await E.requestClaimEmail('c1', 'first', { fetch, secret: 's', siteUrl: 'http://flizy.app' }), 'unconfigured');
  });

  it('reminders go only to pending email claims past the delay whose first email went out and that have none yet', async () => {
    const old = '2026-11-16T12:00:00.000Z';
    const fake = createFakeSupabase({
      claims: [
        { id: 'due', status: 'pending', to_email: 'a@x.co', created_at: old },
        { id: 'young', status: 'pending', to_email: 'b@x.co', created_at: '2026-11-20T10:00:00.000Z' },
        { id: 'unsent', status: 'pending', to_email: 'c@x.co', created_at: old },
        { id: 'reminded', status: 'pending', to_email: 'd@x.co', created_at: old },
        { id: 'claimed', status: 'claimed', to_email: 'e@x.co', created_at: old },
        { id: 'phone', status: 'pending', to_email: null, created_at: old },
      ],
      claim_email_notices: [
        { claim_id: 'due', kind: 'first', state: 'sent' },
        { claim_id: 'unsent', kind: 'first', state: 'failed' },
        { claim_id: 'reminded', kind: 'first', state: 'sent' },
        { claim_id: 'reminded', kind: 'reminder', state: 'sent' },
        { claim_id: 'claimed', kind: 'first', state: 'sent' },
      ],
    });
    const asked = [];
    const sent = await E.sendDueReminders({ supabase: fake.client, env: {}, now: NOW, request: async (id, kind) => (asked.push([id, kind]), 'sent') });
    assert.deepEqual(asked, [['due', 'reminder']]);
    assert.equal(sent, 1);
    assert.equal(E.startClaimReminderWorker({ supabase: fake.client, env: {} }), null, 'nothing runs while email is off');
  });

  it('both bots register the email sender; reminders run from the WhatsApp process only', () => {
    assert.match(read('index.js'), /registerClaimEmailSender\(\);\s+startClaimReminderWorker\(\{ supabase \}\);/);
    const tg = read('telegram.js');
    assert.match(tg, /registerClaimEmailSender\(\);/);
    assert.doesNotMatch(tg, /startClaimReminderWorker/);
  });

  it('a blocked email leaves the claim held and tells the sender to share the link', () => {
    const router = read('lib/router.js');
    assert.match(router, /!notified && !toldOn && isEmailClaim && canReach\('email'\) \? "We couldn't email them this time\. Share the claim link instead\." : null,/);
  });
});

describe('the routes and the migration', () => {
  it('the internal route takes only a claim id and a kind, behind the secret', () => {
    const route = read('web/app/api/internal/claim-notice/route.ts');
    assert.ok(route.indexOf("bearerMatches(req.headers.get('authorization'), process.env.SECURITY_MAIL_SECRET)") < route.indexOf('req.json()'));
    assert.match(route, /sendClaimEmail\(\{ db: getSupabase\(\), claimId, kind \}\)/);
    assert.doesNotMatch(route, /body\?\.email|body\.to|body\?\.to/);
  });

  it('the stop link: a button, never a GET; the same answer for real and unknown links; never indexed', () => {
    const route = read('web/app/api/email/stop/route.ts');
    assert.doesNotMatch(route, /export async function GET/);
    assert.match(route, /return NextResponse\.json\(\{ ok: out === 'stopped' \|\| out === 'not_found' \}\);/);
    assert.match(read('web/app/email/layout.tsx'), /noindex: true/);
    assert.match(read('web/app/robots.ts'), /'\/email\/'/);
  });

  it('one notice per claim and kind, hashes only, service role only', () => {
    const sql = read('supabase/migrations/20261117150000_claim_email_notices.sql');
    assert.match(sql, /constraint claim_email_notices_once unique \(claim_id, kind\)/);
    assert.match(sql, /constraint claim_email_notices_hash_check check \(recipient_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    assert.match(sql, /revoke all on table public\.email_suppressions from public, anon, authenticated;/);
    assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\bemail text\b|to_email/);
  });

  it('the claim page lets a signed-in visitor add and verify the email there', () => {
    const page = read('web/app/claim/[token]/page.tsx');
    assert.match(page, /\{data\.recipient_kind === 'email' \? \(\s+<ClaimEmailVerify onVerified=\{\(\) => void load\(\)\} \/>/);
    const c = read('web/components/ClaimEmailVerify.tsx');
    assert.match(c, /post\('\/api\/account\/emails', \{ email \}\)/);
    assert.match(c, /post\('\/api\/auth\/email\/verify', \{ purpose: 'secondary', email, code \}\)/);
  });
});
