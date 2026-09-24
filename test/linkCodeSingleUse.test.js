/**
 * A link code is single use, and the burn is what enforces it.
 *
 * A code binds a chat identity to an account, which is ongoing control of that
 * account through chat. "Single use" is the whole of the protection, so it has
 * to hold when two redemptions arrive together, not only when they arrive in
 * turn.
 *
 * The bug these cover: the burn used to run after the bind, as bookkeeping. Two
 * concurrent redemptions both read the code as unused, both bound, and one then
 * marked it spent. One code, two identities, and both callers told ok, so the
 * owner saw their own link succeed with no sign of the other. Confirmed against
 * a real database before the fix and refused after it.
 *
 * The burn is now a compare-and-swap that runs first and decides the winner, so
 * the loser has no authority to grant. Everything after it that can fail has to
 * release the code, or a failed bind leaves the owner with a dead code and no
 * link.
 *
 * Run: node --test test/linkCodeSingleUse.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();
/** Lets a test intercept a table between the read and the write. */
let intercept = null;
mockSupabaseModule({
  from: (table) => {
    if (intercept) intercept(table);
    return fake.client.from(table);
  },
});

const { consumeLinkCode, createLinkCode } = require('../lib/identity');

const TG_ID = '778899123';
const OTHER_TG = '778899999';
const CODE = 'ABCDEFGHJK';

function seed(codeRow = {}) {
  intercept = null;
  fake = createFakeSupabase({
    accounts: [{ id: 'acc-a', email: 'a@example.com', display_name: 'A', balance_eth: 0 }],
    channel_identities: [],
    identity_bind_attempts: [],
    identity_events: [],
    users: [],
    link_codes: [
      {
        id: 'lc-1',
        account_id: 'acc-a',
        code: CODE,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        used_at: null,
        used_by_channel: null,
        used_by_external_id: null,
        ...codeRow,
      },
    ],
  });
}

const identities = () => fake.db.tables.channel_identities || [];
const codeRow = () => (fake.db.tables.link_codes || [])[0];

describe('one code, one identity', () => {
  beforeEach(() => seed());

  it('the happy path binds and spends the code', async () => {
    const res = await consumeLinkCode('telegram', TG_ID, CODE, null);

    assert.equal(res.ok, true);
    assert.equal(identities().length, 1);
    assert.equal(identities()[0].external_id, TG_ID);
    assert.ok(codeRow().used_at, 'the code is spent');
    assert.equal(codeRow().used_by_external_id, TG_ID);
  });

  it('a second redemption after the first is refused and binds nothing', async () => {
    await consumeLinkCode('telegram', TG_ID, CODE, null);
    const res = await consumeLinkCode('telegram', OTHER_TG, CODE, null);

    assert.equal(res.ok, false);
    assert.equal(res.reason, 'used');
    assert.equal(identities().length, 1, 'the second identity must not be bound');
    assert.equal(identities()[0].external_id, TG_ID, 'and the first one is untouched');
  });

  it('losing the race to spend the code grants nothing', async () => {
    // The concurrent case, made deterministic: the row reads as unused, then
    // another redemption spends it before this one reaches its own burn.
    //
    // Counted, not guarded on state. consumeLinkCode touches link_codes twice:
    // once to read, once to burn. Firing on the first would set used_at before
    // the read and the early "already used" check would answer, leaving the
    // compare-and-swap untested. Firing on the second puts the write squarely
    // inside the window the old ordering left open.
    let hits = 0;
    intercept = (table) => {
      if (table !== 'link_codes') return;
      hits += 1;
      if (hits !== 2) return;
      codeRow().used_at = new Date().toISOString();
      codeRow().used_by_channel = 'whatsapp';
      codeRow().used_by_external_id = OTHER_TG;
    };

    const res = await consumeLinkCode('telegram', TG_ID, CODE, null);

    assert.equal(hits, 2, 'the read happened, then the burn: the window was real');
    assert.equal(res.ok, false, 'the loser must not be told it linked');
    assert.equal(res.reason, 'used');
    assert.equal(identities().length, 0, 'the loser must bind nothing at all');
    assert.equal(codeRow().used_by_external_id, OTHER_TG, "the winner's burn stands");
  });
});

describe('a failed bind hands the code back', () => {
  beforeEach(() => seed());

  it('a locked-out account leaves the code spendable again', async () => {
    // Reachable in production: enough rejected binds locks the account, and
    // that check throws before anything is written. Since the code is now spent
    // before the bind runs, an exit here has to release it or the owner holds a
    // dead code and has to work out why a fresh one is needed.
    fake.db.tables.identity_bind_attempts.push({
      account_id: 'acc-a',
      failed_attempts: 99,
      locked_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    await assert.rejects(() => consumeLinkCode('telegram', TG_ID, CODE, null));

    assert.equal(identities().length, 0, 'nothing was bound');
    assert.equal(codeRow().used_at, null, 'and the code was handed back');
    assert.equal(codeRow().used_by_channel, null);
    assert.equal(codeRow().used_by_external_id, null);
  });

  it('the released code still works once the lockout clears', async () => {
    fake.db.tables.identity_bind_attempts.push({
      account_id: 'acc-a',
      failed_attempts: 99,
      locked_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await assert.rejects(() => consumeLinkCode('telegram', TG_ID, CODE, null));

    // Lockout expires; the same code must still be good.
    fake.db.tables.identity_bind_attempts[0].locked_until = new Date(
      Date.now() - 1000
    ).toISOString();

    const res = await consumeLinkCode('telegram', TG_ID, CODE, null);
    assert.equal(res.ok, true, 'the code survived the failed attempt');
    assert.equal(identities().length, 1);
  });
});

describe('a fresh code retires the one before it', () => {
  beforeEach(() => seed());

  it('minting expires whatever this account still had outstanding', async () => {
    // Nothing rate limits the mint route, so without this every press of the
    // button left another live credential for its full ten minutes. The
    // product's own copy says to generate a new one, which reads as the old one
    // being finished.
    const before = codeRow();
    assert.ok(new Date(before.expires_at).getTime() > Date.now(), 'starts live');

    await createLinkCode('acc-a');

    const rows = fake.db.tables.link_codes;
    assert.equal(rows.length, 2, 'the old row is kept, not deleted');
    const old = rows.find((r) => r.code === CODE);
    assert.ok(
      new Date(old.expires_at).getTime() <= Date.now(),
      'the previous code is no longer live'
    );
    assert.equal(old.used_at, null, 'and it reads as expired, not as used');
  });

  it('the retired code is refused, and the new one works', async () => {
    const fresh = await createLinkCode('acc-a');

    const stale = await consumeLinkCode('telegram', TG_ID, CODE, null);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'expired', 'expired is the honest reason');
    assert.equal(identities().length, 0);

    const good = await consumeLinkCode('telegram', TG_ID, fresh.code, null);
    assert.equal(good.ok, true);
    assert.equal(identities().length, 1);
  });

  it("it never touches a different account's codes", async () => {
    fake.db.tables.accounts.push({ id: 'acc-b', email: 'b@example.com' });
    fake.db.tables.link_codes.push({
      id: 'lc-b',
      account_id: 'acc-b',
      code: 'ZZZZZZZZZZ',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      used_at: null,
    });

    await createLinkCode('acc-a');

    const other = fake.db.tables.link_codes.find((r) => r.code === 'ZZZZZZZZZZ');
    assert.ok(new Date(other.expires_at).getTime() > Date.now(), 'acc-b keeps its code');
  });
});
