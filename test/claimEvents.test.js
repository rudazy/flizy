/**
 * Claim tracking for the sender (Slice 1): lib/claimEvents.js, the events
 * recorded on each change (lib/claims.js, the site payout and cancel, the
 * reconciler, the API worker), what the sender sees in chat and in History,
 * the site cancel, and migration 20261117140000_claim_events.sql.
 *
 * Covers: an event per change, recorded once and never throwing; meta keeps no
 * personal data; link_opened once, never the sender's own open; only the
 * sender sees a claim's status; claims from before events still show; a
 * recipient never sees the sender's phone; History reads email, NFT and expiry
 * columns; the site cancel only for the sender's own pending claim.
 *
 * Run: node --test test/claimEvents.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// The site's supabase module reads the real env files when it loads, so for
// the site cancel it is replaced with one that hands back this test's fake.
const WEB_LIB = pathToFileURL(path.join(__dirname, '..', 'web', 'lib') + path.sep).href;
const SUPABASE_STUB =
  'data:text/javascript,' +
  encodeURIComponent('export function getSupabase(){return globalThis.__claimEventsDb}export function getSiteConfig(){return {}}');
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || '';
    if (parent.startsWith(WEB_LIB) && /^\.\/supabase(\.ts)?$/.test(specifier)) return { url: SUPABASE_STUB, shortCircuit: true };
    if (parent.startsWith(WEB_LIB) && specifier.startsWith('.') && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, parent);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const E = require('../lib/claimEvents');

const SENDER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CLAIM = '33333333-3333-4333-8333-333333333333';
const quiet = { warn() {} };

/** A fake that enforces the migration's one-link_opened-per-claim index. */
function eventsDb(seed = {}) {
  const fake = createFakeSupabase({ claim_events: [], ...seed });
  const from = fake.client.from.bind(fake.client);
  fake.client.from = (table) => {
    const q = from(table);
    if (table !== 'claim_events') return q;
    const insert = q.insert.bind(q);
    q.insert = (row) => {
      if (row.event === 'link_opened' && fake.db.tables.claim_events.some((e) => e.claim_id === row.claim_id && e.event === 'link_opened')) {
        return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
      }
      return insert({ ...row, created_at: row.created_at || new Date().toISOString() });
    };
    return q;
  };
  return fake;
}
const events = (fake) => fake.db.tables.claim_events.map((e) => [e.claim_id, e.event, e.channel]);

describe('recording', () => {
  it('records an event, link_opened only once, and never throws', async () => {
    const fake = eventsDb();
    assert.equal(await E.recordClaimEvent(fake.client, CLAIM, 'created', { log: quiet }), 'recorded');
    assert.equal(await E.recordClaimEvent(fake.client, CLAIM, 'link_opened', { log: quiet }), 'recorded');
    assert.equal(await E.recordClaimEvent(fake.client, CLAIM, 'link_opened', { log: quiet }), 'duplicate');
    assert.equal(await E.recordClaimEvent(fake.client, CLAIM, 'notified', { channel: 'email', log: quiet }), 'recorded');
    assert.deepEqual(events(fake), [[CLAIM, 'created', null], [CLAIM, 'link_opened', null], [CLAIM, 'notified', 'email']]);
    const broken = { from: () => ({ insert: () => Promise.reject(new Error('down')) }) };
    assert.equal(await E.recordClaimEvent(broken, CLAIM, 'created', { log: quiet }), 'failed');
  });

  it('refuses an unknown event or channel, and keeps no personal data in meta', async () => {
    const fake = eventsDb();
    assert.equal(await E.recordClaimEvent(fake.client, CLAIM, 'deleted', { log: quiet }), 'failed');
    assert.equal(await E.recordClaimEvent(fake.client, CLAIM, 'notified', { channel: 'sms', log: quiet }), 'failed');
    assert.equal(await E.recordClaimEvent(fake.client, '', 'created', { log: quiet }), 'failed');
    await E.recordClaimEvent(fake.client, CLAIM, 'cancelled', { meta: { reason: 'sender', email: 'ada@example.com', phone: '+2348012345678', note: 'Ada Lovelace' }, log: quiet });
    assert.deepEqual(fake.db.tables.claim_events[0].meta, { reason: 'sender' });
  });

  it('the events and channels match the migration', () => {
    const sql = read('supabase/migrations/20261117140000_claim_events.sql');
    const list = (name, text = sql) => text.match(new RegExp(`${name} in \\(([^)]*)\\)`))[1].match(/'([a-z_]+)'/g).map((s) => s.slice(1, -1));
    // The event list was widened by a later migration (claim_refused); that one is current.
    assert.deepEqual(list('event', read('supabase/migrations/20261118120000_claim_refused_and_skipped.sql')), [...E.EVENTS]);
    assert.deepEqual(list('channel'), [...E.CHANNELS]);
    assert.match(sql, /create unique index if not exists claim_events_link_opened_once\s+on public\.claim_events \(claim_id\)\s+where event = 'link_opened';/);
    assert.match(sql, /alter table public\.claim_events enable row level security;\nrevoke all on table public\.claim_events from public, anon, authenticated;/);
  });
});

describe('what the sender sees', () => {
  const at = (h) => `2026-11-17T${String(h).padStart(2, '0')}:00:00.000Z`;

  it('a timeline in words, and a claim from before events shows only that it was sent', () => {
    const ev = [
      { event: 'created', channel: null, at: at(1) },
      { event: 'notified', channel: 'chat', at: at(2) },
      { event: 'notified', channel: 'email', at: at(3) },
      { event: 'link_shared', channel: 'whatsapp', at: at(4) },
      { event: 'link_opened', channel: null, at: at(5) },
      { event: 'claimed', channel: null, at: at(6) },
    ];
    assert.deepEqual(E.claimTimeline({ status: 'claimed' }, ev).map((s) => s.label), [
      'Sent',
      'Recipient notified on Flizy',
      'Recipient notified by email',
      'Claim link shared to WhatsApp',
      'Link opened',
      'Claimed',
    ]);
    assert.deepEqual(E.claimTimeline({ status: 'pending', created_at: at(1) }, []), [{ label: 'Sent', at: at(1) }]);
  });

  it('the status chip: the claims status, with the furthest step while it waits', () => {
    const s = (status, kinds) => E.claimStatusLabel({ status }, kinds.map((event) => ({ event })));
    assert.equal(s('pending', []), 'Waiting');
    assert.equal(s('pending', ['created', 'link_shared']), 'Link shared');
    assert.equal(s('pending', ['created', 'notified', 'link_shared']), 'Recipient notified');
    assert.equal(s('pending', ['created', 'notified', 'link_opened']), 'Link opened');
    assert.equal(s('processing', ['link_opened']), 'Processing');
    assert.equal(s('claimed', []), 'Claimed');
    assert.equal(s('cancelled', ['cancelled']), 'Cancelled');
    assert.equal(s('cancelled', ['expired']), 'Expired');
    assert.equal(s('cancelled', ['cancelled', 'refunded']), 'Refunded');
    assert.equal(s('cancelled', ['expired', 'refunded']), 'Refunded');
    assert.equal(E.claimAge('2026-11-17T10:00:00.000Z', Date.parse('2026-11-19T11:00:00.000Z')), '2d');
    assert.equal(E.claimAge('2026-11-17T10:00:00.000Z', Date.parse('2026-11-17T13:30:00.000Z')), '3h');
  });
});

describe('the claims module', () => {
  let C;
  let fake;
  before(() => {
    fake = eventsDb({ claims: [], accounts: [] });
    mockSupabaseModule(fake.client);
    delete require.cache[require.resolve('../lib/claims')];
    C = require('../lib/claims');
  });

  it('a new claim records created; claiming it records claimed', async () => {
    const { claim } = await C.createClaim({ fromAccountId: SENDER, toWaHint: '+2348012345678', amountEth: '0.01', chainId: 91342, holdTxHash: '0x' + 'ab'.repeat(32) });
    claim.status = 'processing';
    await C.markClaimed(claim.id, OTHER, '0x' + 'cd'.repeat(32));
    assert.deepEqual(events(fake).filter((e) => e[0] === claim.id).map((e) => e[1]), ['created', 'claimed']);
  });

  it('a cancel records cancelled and refunded; an API claim past its expiry records expired and refunded', async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    fake.db.tables.claims.push(
      { id: 'c-cancel', from_account_id: SENDER, status: 'processing', expires_at: null },
      { id: 'c-expired', from_account_id: SENDER, status: 'processing', expires_at: past }
    );
    assert.equal((await C.cancelClaim('c-cancel', SENDER, '0x' + 'ee'.repeat(32))).ok, true);
    assert.equal((await C.cancelClaim('c-expired', SENDER, '0x' + 'ff'.repeat(32))).ok, true);
    const of = (id) => events(fake).filter((e) => e[0] === id).map((e) => e[1]);
    assert.deepEqual(of('c-cancel'), ['cancelled', 'refunded']);
    assert.deepEqual(of('c-expired'), ['expired', 'refunded']);
    // Someone else cannot cancel it, and nothing is recorded.
    fake.db.tables.claims.push({ id: 'c-theirs', from_account_id: OTHER, status: 'processing' });
    assert.equal((await C.cancelClaim('c-theirs', SENDER)).reason, 'not_owner');
    assert.deepEqual(of('c-theirs'), []);
  });

  it('the recipient sees the sender by @username or display name, never their phone', async () => {
    fake.db.tables.accounts.push(
      { id: 'a-user', username: 'ada', display_name: 'Ada' },
      { id: 'a-name', username: null, display_name: 'Kemi\nAmount: 999 ETH' },
      { id: 'a-none', username: null, display_name: null }
    );
    const claims = [
      { id: '1', from_account_id: 'a-user', from_wa_sender: '2348012345678', amount_eth: '0.01', asset: 'ETH' },
      { id: '2', from_account_id: 'a-name', from_wa_sender: '2348012345678', amount_eth: '0.02', asset: 'ETH' },
      { id: '3', from_account_id: 'a-none', from_wa_sender: '2348012345678', amount_eth: '0.03', asset: 'ETH' },
    ];
    await C.attachSenderLabels(claims);
    const menu = C.formatClaimsMenu(claims, 'incoming');
    assert.match(menu, /1\. @ada /);
    // A display name is one line: it cannot forge a line of its own in the menu.
    assert.match(menu, /2\. Kemi Amount: 999 ETH  0\.02 ETH/);
    assert.match(menu, /3\. someone /);
    assert.doesNotMatch(menu, /2348012345678/);
  });

  it('chat lists each open claim with its status, age, expiry and what has happened', () => {
    const now = Date.parse('2026-11-19T12:00:00.000Z');
    const c = {
      created_at: '2026-11-17T12:00:00.000Z',
      status: 'pending',
      expires_at: '2026-11-30T00:00:00.000Z',
      events: [
        { event: 'created', at: '2026-11-17T12:00:00.000Z' },
        { event: 'notified', channel: 'chat', at: '2026-11-17T12:00:01.000Z' },
        { event: 'link_opened', at: '2026-11-18T09:00:00.000Z' },
      ],
    };
    assert.deepEqual(C.outgoingClaimDetail(c, now), ['   Link opened, sent 2d ago', '   Expires 2026-11-30', '   Sent > Recipient notified on Flizy > Link opened']);
    assert.deepEqual(C.outgoingClaimDetail({ created_at: '2026-11-19T11:00:00.000Z', status: 'pending' }, now), ['   Waiting, sent 1h ago']);
  });
});

describe('the site cancel', () => {
  let W;
  before(async () => {
    W = await import('../web/lib/claimPayout.ts');
  });

  it('only the sender, only while pending; anyone else is told there is no such claim', async () => {
    const fake = eventsDb({
      claims: [
        { id: 'p1', from_account_id: SENDER, status: 'pending' },
        { id: 'p2', from_account_id: SENDER, status: 'claimed' },
      ],
    });
    globalThis.__claimEventsDb = fake.client;
    assert.deepEqual(await W.executeWebClaimRefund({ claimId: 'p1', accountId: OTHER }), { ok: false, error: 'Claim not found.', status: 404 });
    assert.deepEqual(await W.executeWebClaimRefund({ claimId: 'nope', accountId: SENDER }), { ok: false, error: 'Claim not found.', status: 404 });
    assert.deepEqual(await W.executeWebClaimRefund({ claimId: 'p2', accountId: SENDER }), { ok: false, error: 'Claim is already claimed.', status: 409 });
    assert.equal(fake.db.tables.claims[0].status, 'pending');
    assert.deepEqual(events(fake), []);
  });

  it('the route: same-origin, signed in, a claim id; the money goes back through the same escrow send', () => {
    const route = read('web/app/api/claim/cancel/route.ts');
    assert.ok(route.indexOf('rejectIfCrossOrigin(req)') < route.indexOf('getAccountIdFromCookie()'));
    assert.match(route, /executeWebClaimRefund\(\{ claimId, accountId \}\)/);
    const src = read('web/lib/claimPayout.ts');
    const refund = src.slice(src.indexOf('export async function executeWebClaimRefund'));
    assert.ok(refund.indexOf(".eq('status', 'pending')") < refund.indexOf('sendFromEscrow('), 'locked before anything is sent');
    assert.match(refund, /sendFromEscrow\(held as ClaimRow, toAddress, /);
    assert.match(refund, /recordClaimEvent\(supabase, claimId, expired \? 'expired' : 'cancelled'\);\s*await recordClaimEvent\(supabase, claimId, 'refunded'\);/);
    assert.match(src, /await recordClaimEvent\(supabase, claimId, 'claimed'\);/);
  });
});

describe('wiring', () => {
  it('History reads the email, NFT and expiry columns, so an email claim names its recipient', () => {
    const history = read('lib/history.js');
    for (const col of ['to_email', 'nft_token_id', 'expires_at']) assert.match(history, new RegExp(`const CLAIM_SELECT =\\s+'[^']*\\b${col}\\b`), col);
    const { claimHistoryPeer } = require('../lib/claimHistoryLabel');
    assert.deepEqual(claimHistoryPeer({ to_email: 'ada@example.com' }), { rail: 'Email pay', peer: 'ada@example.com' });
  });

  it('only the sender sees a claim status in History, with events loaded for their claims only', () => {
    const route = read('web/app/api/history/route.ts');
    assert.match(route, /\.\.\.\(isSender\s+\? \{\s+claim: \{/);
    assert.match(route, /e\.source === 'claim' && e\.row\.from_account_id === accountId/);
    assert.match(route, /canCancel: status === 'pending'/);
  });

  it('a link open is recorded for anyone but the sender, and nothing about who opened it', () => {
    const route = read('web/app/api/claim/[token]/route.ts');
    assert.match(route, /const isSender = Boolean\(viewerId\) && viewerId === claim\.from_account_id;/);
    assert.match(route, /if \(claim\.status === 'pending' && !isSender\) \{\s+await recordClaimEvent\(db, String\(claim\.id\), 'link_opened'\);/);
    assert.doesNotMatch(route, /x-forwarded-for|user-agent|headers\.get/i);
  });

  it('notified is recorded wherever a recipient on Flizy is told', () => {
    assert.match(read('lib/router.js'), /if \(notified && result\.claim\?\.id\) await recordClaimEvent\(supabase, result\.claim\.id, 'notified', \{ channel: 'chat' \}\);/);
    assert.match(read('lib/reconcile.js'), /const told = await d\.notifyClaimRecipient\(a, claim\);\s+if \(told\) await recordClaimEvent\(d\.supabase, claim\.id, 'notified', \{ channel: 'chat' \}\);/);
    assert.match(read('lib/api/payoutWorker.js'), /if \(res && res\.delivered \+ res\.queued > 0\) await recordClaimEvent\(supabase, claimId, 'notified', \{ channel: 'chat' \}\);/);
  });

  it('the platform owner hears when an API claim expired and was refunded', () => {
    const worker = read('lib/api/payoutWorker.js');
    assert.equal((worker.match(/await tellOwnerIfExpired\(row, platform\);/g) || []).length, 2);
    assert.match(worker, /if \(!claim \|\| !claim\.expires_at \|\| Date\.parse\(claim\.expires_at\) > Date\.now\(\)\) return;/);
  });

  it('a sender label is never the phone', () => {
    const acct = read('lib/commands/account.js');
    const fn = acct.slice(acct.indexOf('async function senderLabel'), acct.indexOf('module.exports'));
    assert.doesNotMatch(fn, /phone|waPhone|resolveClaimIdentity/i);
    assert.match(fn, /return displaySafeLabel\(name\);/);
  });

  it('pending lists your open claims, like claims', () => {
    const { parseClaimsListCommand } = require('../lib/commands/parse');
    for (const t of ['pending', 'claims', 'outgoing claims']) assert.deepEqual(parseClaimsListCommand(t), { kind: 'outgoing' }, t);
  });
});
