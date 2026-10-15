/**
 * The PIN is typed on flizy.app, never in chat.
 *
 * - The ladder: the same steps every secret climbs, steep enough that a 4
 *   digit PIN is hopeless to guess.
 * - web/lib/pinGate.ts: one counter per account, a paused account is refused
 *   before the PIN is compared, a right PIN clears the counter.
 * - lib/chatApprovals.js: the link token is random, stored only as a hash,
 *   lives 5 minutes, and an approval is acted on once.
 * - web/app/api/approvals/[token]: the route the page talks to.
 *
 * Run: node --test test/pinPage.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { lockoutMsForAttempts, FREE_ATTEMPTS } = require('../lib/lockoutLadder');

const ROOT = path.join(__dirname, '..');
const ROUTE = fs.readFileSync(path.join(ROOT, 'web/app/api/approvals/[token]/route.ts'), 'utf8');

describe('the ladder', () => {
  it('gives the first few attempts away, then escalates', () => {
    for (let n = 1; n <= FREE_ATTEMPTS; n += 1) assert.equal(lockoutMsForAttempts(n), 0, `attempt ${n}`);
    assert.equal(lockoutMsForAttempts(5), 60_000);
    assert.equal(lockoutMsForAttempts(6), 5 * 60_000);
    assert.equal(lockoutMsForAttempts(7), 15 * 60_000);
    assert.equal(lockoutMsForAttempts(8), 60 * 60_000);
    assert.equal(lockoutMsForAttempts(9), 24 * 60 * 60_000);
  });

  it('never comes back down, and tops out at a day', () => {
    let previous = 0;
    for (let n = 1; n <= 40; n += 1) {
      const wait = lockoutMsForAttempts(n);
      assert.ok(wait >= previous, `attempt ${n} went backwards`);
      previous = wait;
    }
    assert.equal(lockoutMsForAttempts(500), 24 * 60 * 60_000);
  });

  it('makes the whole 4 digit keyspace hopeless', () => {
    let total = 0;
    for (let n = 1; n <= 10_000; n += 1) total += lockoutMsForAttempts(n);
    const years = total / (365 * 24 * 60 * 60_000);
    assert.ok(years > 25, `10,000 guesses should cost decades, got ${years} years`);
  });
});

describe('checkPin', () => {
  const PIN = '482915';
  let pins;
  let webCrypto;
  let fake;

  before(async () => {
    pins = await import('../web/lib/pinGate.ts');
    webCrypto = await import('../web/lib/cryptoPin.ts');
  });

  beforeEach(() => {
    fake = createFakeSupabase({
      accounts: [
        { id: 'acc-1', unlock_pin_hash: webCrypto.hashPin(PIN) },
        { id: 'acc-2', unlock_pin_hash: webCrypto.hashPin(PIN) },
        { id: 'acc-none', unlock_pin_hash: null },
      ],
      login_attempts: [],
    });
  });

  it('accepts the right PIN', async () => {
    assert.deepEqual(await pins.checkPin(fake.client, 'acc-1', PIN), { ok: true });
  });

  it('counts wrong PINs per account and pauses on the fifth', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const r = await pins.checkPin(fake.client, 'acc-1', '000000');
      assert.equal(r.reason, 'wrong', `miss ${i}`);
      assert.equal(r.attemptsLeft, 5 - i);
    }
    const fifth = await pins.checkPin(fake.client, 'acc-1', '000000');
    assert.equal(fifth.reason, 'locked');
    assert.equal(fifth.status, 429);
    // Another account is not touched.
    assert.deepEqual(await pins.checkPin(fake.client, 'acc-2', PIN), { ok: true });
  });

  it('refuses the right PIN while paused, before comparing it', async () => {
    for (let i = 0; i < 5; i += 1) await pins.checkPin(fake.client, 'acc-1', '000000');
    // Remove the hash: if the paused path compared, this would now say no_pin.
    fake.db.tables.accounts[0].unlock_pin_hash = null;
    assert.equal((await pins.checkPin(fake.client, 'acc-1', PIN)).reason, 'locked');
  });

  it('a right PIN clears the counter', async () => {
    await pins.checkPin(fake.client, 'acc-1', '000000');
    await pins.checkPin(fake.client, 'acc-1', PIN);
    assert.equal(fake.db.tables.login_attempts.length, 0);
  });

  it('a malformed entry is not counted, and no PIN is said plainly', async () => {
    assert.equal((await pins.checkPin(fake.client, 'acc-1', '12a')).reason, 'bad_format');
    assert.equal(fake.db.tables.login_attempts.length, 0);
    assert.equal((await pins.checkPin(fake.client, 'acc-none', PIN)).reason, 'no_pin');
  });
});

describe('approval links (lib/chatApprovals.js)', () => {
  let fake = createFakeSupabase();
  mockSupabaseModule({ from: (table) => fake.client.from(table) });
  delete require.cache[require.resolve('../lib/chatApprovals')];
  const approvals = require('../lib/chatApprovals');
  const ctx = { channel: 'whatsapp', externalId: '2348011112222', key: 'whatsapp:2348011112222' };

  beforeEach(async () => {
    fake = createFakeSupabase({ chat_approvals: [] });
    // Approvals are tracked per process. Ones left from an earlier case point
    // at rows this fresh database does not have; one pass drops them.
    approvals.setApprovalHandler(async () => {});
    await approvals.pollApprovals();
  });

  it('stores only the hash of a 128-bit token, and expires in 5 minutes', async () => {
    const before = Date.now();
    const { url } = await approvals.createApproval({ accountId: 'acc-1', ctx, kind: 'unlock', summary: { title: 'Unlock' } });
    const token = url.split('/a/')[1];
    assert.ok(Buffer.from(token, 'base64url').length >= 16);
    const row = fake.db.tables.chat_approvals[0];
    assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(row).includes(token));
    const ttl = new Date(row.expires_at).getTime() - before;
    assert.ok(ttl > 4.9 * 60_000 && ttl <= 5 * 60_000 + 1000, `ttl ${ttl}`);
  });

  it('labels the chat without giving its number away', () => {
    assert.equal(approvals.chatLabelFor(ctx), 'WhatsApp ending 2222');
    assert.equal(approvals.chatLabelFor({ channel: 'telegram', externalId: '5566778899', displayHandle: '@ada_o' }), 'Telegram @ada_o');
  });

  it('acts on an approval once, even if two passes see it', async () => {
    const events = [];
    approvals.setApprovalHandler(async (e) => events.push(e.type));
    await approvals.createApproval({ accountId: 'acc-1', ctx, kind: 'unlock', summary: { title: 'Unlock' } });
    fake.db.tables.chat_approvals[0].approved_at = new Date().toISOString();
    await Promise.all([approvals.pollApprovals(), approvals.pollApprovals()]);
    await approvals.pollApprovals();
    assert.deepEqual(events, ['approved']);
    assert.ok(fake.db.tables.chat_approvals[0].consumed_at);
  });

  it('a withdrawn approval is never acted on', async () => {
    const events = [];
    approvals.setApprovalHandler(async (e) => events.push(e.type));
    const { id } = await approvals.createApproval({ accountId: 'acc-1', ctx, kind: 'plan', summary: { title: 'Pay' } });
    await approvals.cancelApproval(id);
    fake.db.tables.chat_approvals[0].approved_at = new Date().toISOString();
    await approvals.pollApprovals();
    assert.deepEqual(events, []);
    assert.ok(fake.db.tables.chat_approvals[0].cancelled_at);
  });
});

describe('the approval route', () => {
  const handler = (method) => ROUTE.slice(ROUTE.indexOf(`export async function ${method}`));

  it('needs no session cookie: the token and the PIN are the proof', () => {
    assert.doesNotMatch(ROUTE, /getAccountIdFromCookie/);
  });

  it('GET reads and never writes', () => {
    const get = ROUTE.slice(ROUTE.indexOf('export async function GET'), ROUTE.indexOf('export async function POST'));
    assert.doesNotMatch(get, /\.update\(|\.insert\(|\.delete\(/);
  });

  it('POST checks the Origin, then the PIN on the account counter, then approves with a compare-and-swap', () => {
    const post = handler('POST');
    const origin = post.indexOf('rejectIfCrossOrigin(req)');
    const pin = post.indexOf('checkPin(supabase, row.account_id, pin)');
    const approve = post.indexOf(".update({ approved_at: new Date().toISOString() })");
    assert.ok(origin > 0 && pin > origin && approve > pin);
    const cas = post.slice(approve, post.indexOf(".select('id')", approve));
    for (const guard of [".is('approved_at', null)", ".is('consumed_at', null)", ".is('cancelled_at', null)", ".gt('expires_at',"]) {
      assert.ok(cas.includes(guard), guard);
    }
  });

  it('a pause burns the link', () => {
    const post = handler('POST');
    const locked = post.indexOf("if (check.reason === 'locked') {");
    assert.ok(post.indexOf(".update({ cancelled_at: new Date().toISOString() })", locked) > locked);
  });

  it('the token is only ever looked up by its hash', () => {
    assert.match(ROUTE, /createHash\('sha256'\)\.update\(token\)\.digest\('hex'\)/);
    assert.match(ROUTE, /\.eq\('token_hash', tokenHash\)/);
  });

  it('the page is not indexed and its title says nothing about the request', () => {
    const page = fs.readFileSync(path.join(ROOT, 'web/app/a/[token]/page.tsx'), 'utf8');
    assert.match(page, /robots: \{ index: false, follow: false \}/);
    assert.match(page, /title: 'Approve on Flizy'/);
    assert.match(fs.readFileSync(path.join(ROOT, 'web/app/robots.ts'), 'utf8'), /'\/a\/'/);
  });
});
