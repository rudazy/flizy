/**
 * Invite codes, set-once attribution, and the counting gate.
 *
 * Run: node --test test/invite.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const {
  INVITE_COOKIE,
  INVITE_COOKIE_MAX_AGE_SEC,
  INVITE_SOURCE,
  INVITE_SOURCE_CLAIM,
  INVITE_EVENT,
  QUALIFYING_KINDS,
  normalizeInviteCode,
  extractInviteCode,
  resolveSignupInvite,
  isInviteCodeFormat,
  isQualifyingFirstTx,
  ensureInviteCode,
  attributeSignup,
  maybeMarkOnboarded,
  maybeMarkFirstTx,
  tryCountInviteLocal,
  inviteStatsFor,
  countedInvitesFor,
  inviteCodeIfAttachEnabled,
  collectCountablePhones,
} = require('../lib/invite');

const INVITER = 'acc-inviter';
const INVITEE = 'acc-invitee';
const OTHER = 'acc-other';

function seed(extra = {}) {
  return createFakeSupabase({
    accounts: [
      {
        id: INVITER,
        email: 'a@x.com',
        email_verified_at: '2026-01-01T00:00:00.000Z',
        username: 'alice',
      },
      {
        id: INVITEE,
        email: 'b@x.com',
        email_verified_at: null,
        username: null,
      },
      {
        id: OTHER,
        email: 'c@x.com',
        email_verified_at: '2026-01-01T00:00:00.000Z',
        username: 'carol',
      },
    ],
    invite_codes: [],
    invite_attributions: [],
    invite_phone_claims: [],
    invite_events: [],
    channel_identities: [],
    reserved_usernames: [{ normalized_name: 'suport', category: 'role' }],
    ...extra,
  });
}

async function issueFor(fake, accountId) {
  const issued = await ensureInviteCode(fake.client, accountId);
  assert.equal(issued.ok, true);
  return issued.code;
}

describe('invite refs are usernames', () => {
  it('accepts a Flizy username and rejects a random slug', () => {
    assert.equal(isInviteCodeFormat('ludarep'), true);
    assert.equal(isInviteCodeFormat('alice'), true);
    assert.equal(isInviteCodeFormat('2h2zmbbtbd'), false);
    assert.equal(isInviteCodeFormat('ab'), false);
  });

  it('normalizes @ and case', () => {
    assert.equal(normalizeInviteCode('  @Alice '), 'alice');
  });

  it('extracts a username from a slug, /i/ path, or claim path', () => {
    assert.equal(extractInviteCode('ludarep'), 'ludarep');
    assert.equal(extractInviteCode('@ludarep'), 'ludarep');
    assert.equal(extractInviteCode('https://flizy.app/i/ludarep'), 'ludarep');
    assert.equal(extractInviteCode('/i/ludarep'), 'ludarep');
    assert.equal(extractInviteCode('https://flizy.app/claim/tok/ludarep'), 'ludarep');
  });

  it('lets a typed signup username beat the cookie', () => {
    const typed = resolveSignupInvite('ludarep', 'alice', INVITE_SOURCE_CLAIM);
    assert.deepEqual(typed, { code: 'ludarep', source: INVITE_SOURCE });
    const cookie = resolveSignupInvite('', 'alice', INVITE_SOURCE_CLAIM);
    assert.deepEqual(cookie, { code: 'alice', source: INVITE_SOURCE_CLAIM });
    const empty = resolveSignupInvite('not-a-code', null);
    assert.equal(empty.code, null);
  });
});

describe('qualifying first tx', () => {
  it('accepts any confirmed on-chain Flizy receipt, including send', () => {
    const base = { accountId: INVITEE, amount: 0.01, ok: true };
    assert.equal(isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.CLAIM_PAYOUT }), true);
    assert.equal(isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.OUTBOUND_SEND }), true);
    assert.equal(isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.SWAP }), true);
    assert.equal(isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.BUY }), true);
    assert.equal(isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.SELL }), true);
    assert.equal(isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.ADD_LIQUIDITY }), true);
    assert.equal(isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.REMOVE_LIQUIDITY }), true);
    assert.equal(
      isQualifyingFirstTx({
        ...base,
        kind: QUALIFYING_KINDS.OUTBOUND_SEND,
        destinationIsOwnWallet: true,
      }),
      true
    );
    assert.equal(
      isQualifyingFirstTx({
        ...base,
        kind: QUALIFYING_KINDS.CLAIM_PAYOUT,
        counterpartyAccountId: INVITEE,
      }),
      true
    );
  });

  it('rejects only a failed receipt or a non-receipt', () => {
    const base = { accountId: INVITEE, amount: 0.01, ok: true };
    assert.equal(
      isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.OUTBOUND_SEND, ok: false }),
      false
    );
    assert.equal(isQualifyingFirstTx({ ...base, kind: QUALIFYING_KINDS.SWAP, ok: false }), false);
    assert.equal(isQualifyingFirstTx({ accountId: INVITEE, kind: 'claim_hold', amount: 1, ok: true }), false);
    assert.equal(isQualifyingFirstTx({ kind: QUALIFYING_KINDS.OUTBOUND_SEND, ok: true }), false);
  });
});

describe('ensureInviteCode', () => {
  it('issues one code per account and is idempotent', async () => {
    const fake = seed();
    const first = await ensureInviteCode(fake.client, INVITER);
    const second = await ensureInviteCode(fake.client, INVITER);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.code, second.code);
    assert.equal(fake.db.tables.invite_codes.length, 1);
  });
});

describe('attribution is set once', () => {
  it('records the inviter from the code and ignores a second write', async () => {
    const fake = seed();
    const code = await issueFor(fake, INVITER);
    const first = await attributeSignup(fake.client, { inviteeAccountId: INVITEE, code });
    assert.equal(first.attributed, true);
    const again = await attributeSignup(fake.client, { inviteeAccountId: INVITEE, code });
    assert.equal(again.reason, 'already');
    assert.equal(fake.db.tables.invite_attributions.length, 1);
    assert.equal(fake.db.tables.invite_attributions[0].inviter_account_id, INVITER);
    assert.equal(fake.db.tables.invite_attributions[0].source, INVITE_SOURCE);
    assert.ok(fake.db.tables.invite_events.some((e) => e.event_type === INVITE_EVENT.ATTRIBUTED));
    const stats = await inviteStatsFor(fake.client, INVITER);
    assert.equal(stats.attributed, 1);
    assert.equal(stats.counted, 0);
  });

  it('does not attribute a missing or unknown code', async () => {
    const fake = seed();
    const missing = await attributeSignup(fake.client, { inviteeAccountId: INVITEE, code: null });
    assert.equal(missing.attributed, false);
    const unknown = await attributeSignup(fake.client, {
      inviteeAccountId: INVITEE,
      code: 'abcdefghjk',
    });
    assert.equal(unknown.reason, 'unknown_code');
    assert.equal(fake.db.tables.invite_attributions.length, 0);
  });

  it('refuses self-attribution', async () => {
    const fake = seed();
    const code = await issueFor(fake, INVITER);
    const res = await attributeSignup(fake.client, { inviteeAccountId: INVITER, code });
    assert.equal(res.attributed, false);
    assert.equal(res.reason, 'self');
    assert.equal(fake.db.tables.invite_attributions.length, 0);
  });
});

describe('onboarding and first tx stamps', () => {
  it('does not stamp onboarding until email is verified and username is set', async () => {
    const fake = seed();
    const code = await issueFor(fake, INVITER);
    await attributeSignup(fake.client, { inviteeAccountId: INVITEE, code });

    let res = await maybeMarkOnboarded(fake.client, INVITEE);
    assert.equal(res.reason, 'not_ready');

    fake.db.tables.accounts.find((a) => a.id === INVITEE).email_verified_at = '2026-01-02T00:00:00.000Z';
    res = await maybeMarkOnboarded(fake.client, INVITEE);
    assert.equal(res.reason, 'not_ready');

    fake.db.tables.accounts.find((a) => a.id === INVITEE).username = 'bob';
    res = await maybeMarkOnboarded(fake.client, INVITEE);
    assert.equal(res.reason, 'not_ready');
    assert.ok(fake.db.tables.invite_attributions[0].onboarding_completed_at);
  });

  it('does not stamp first tx for an unattributed account', async () => {
    const fake = seed();
    const res = await maybeMarkFirstTx(fake.client, {
      accountId: INVITEE,
      kind: QUALIFYING_KINDS.OUTBOUND_SEND,
      amount: 0.01,
      ok: true,
    });
    assert.equal(res.reason, 'unattributed');
  });
});

async function readyToCount(fake, invitee, inviter, phone = '2348011111111') {
  const code = await issueFor(fake, inviter);
  await attributeSignup(fake.client, { inviteeAccountId: invitee, code });
  const acc = fake.db.tables.accounts.find((a) => a.id === invitee);
  acc.email_verified_at = '2026-01-02T00:00:00.000Z';
  acc.username = acc.username || 'bob';
  await maybeMarkOnboarded(fake.client, invitee);
  fake.db.tables.channel_identities.push({
    id: `ci-${invitee}`,
    account_id: invitee,
    channel: 'telegram',
    external_id: `${invitee}-ext`,
    phone_e164: phone,
  });
  return maybeMarkFirstTx(fake.client, {
    accountId: invitee,
    kind: QUALIFYING_KINDS.CLAIM_PAYOUT,
    amount: 0.01,
    ok: true,
    counterpartyAccountId: inviter,
  });
}

describe('counting gate', () => {
  it('counts once and ignores a second qualifying tx', async () => {
    const fake = seed();
    const first = await readyToCount(fake, INVITEE, INVITER);
    assert.equal(first.ok, true);
    const second = await maybeMarkFirstTx(fake.client, {
      accountId: INVITEE,
      kind: QUALIFYING_KINDS.OUTBOUND_SEND,
      amount: 0.05,
      ok: true,
    });
    assert.equal(second.reason, 'noop');
    assert.equal(await countedInvitesFor(fake.client, INVITER), 1);
    assert.equal(fake.db.tables.invite_phone_claims.length, 1);
    assert.equal(fake.db.tables.invite_phone_claims[0].phone_e164, '2348011111111');
  });

  it('does not count without a current phone', async () => {
    const fake = seed();
    const code = await issueFor(fake, INVITER);
    await attributeSignup(fake.client, { inviteeAccountId: INVITEE, code });
    fake.db.tables.accounts.find((a) => a.id === INVITEE).email_verified_at = '2026-01-02T00:00:00.000Z';
    fake.db.tables.accounts.find((a) => a.id === INVITEE).username = 'bob';
    await maybeMarkOnboarded(fake.client, INVITEE);
    const res = await maybeMarkFirstTx(fake.client, {
      accountId: INVITEE,
      kind: QUALIFYING_KINDS.OUTBOUND_SEND,
      amount: 0.01,
      ok: true,
    });
    assert.equal(res.reason, 'no_phone');
    assert.equal(await countedInvitesFor(fake.client, INVITER), 0);
  });

  it('counts after a later phone bind when first tx already landed', async () => {
    const fake = seed();
    const code = await issueFor(fake, INVITER);
    await attributeSignup(fake.client, { inviteeAccountId: INVITEE, code });
    fake.db.tables.accounts.find((a) => a.id === INVITEE).email_verified_at = '2026-01-02T00:00:00.000Z';
    fake.db.tables.accounts.find((a) => a.id === INVITEE).username = 'bob';
    await maybeMarkOnboarded(fake.client, INVITEE);
    await maybeMarkFirstTx(fake.client, {
      accountId: INVITEE,
      kind: QUALIFYING_KINDS.OUTBOUND_SEND,
      amount: 0.01,
      ok: true,
    });
    fake.db.tables.channel_identities.push({
      account_id: INVITEE,
      channel: 'telegram',
      external_id: '111',
      phone_e164: '2348011111111',
    });
    const res = await tryCountInviteLocal(fake.client, INVITEE);
    assert.equal(res.ok, true);
    assert.equal(await countedInvitesFor(fake.client, INVITER), 1);
  });

  it('refuses a second credit for a phone after unlink and rebind to a new account', async () => {
    const fake = seed();
    await readyToCount(fake, INVITEE, INVITER);
    assert.equal(await countedInvitesFor(fake.client, INVITER), 1);

    fake.db.tables.channel_identities = fake.db.tables.channel_identities.filter(
      (r) => r.account_id !== INVITEE
    );

    const fourth = 'acc-fourth';
    fake.db.tables.accounts.push({
      id: fourth,
      email: 'd@x.com',
      email_verified_at: '2026-01-03T00:00:00.000Z',
      username: 'dana',
    });
    const code = fake.db.tables.invite_codes.find((r) => r.account_id === INVITER).code;
    await attributeSignup(fake.client, { inviteeAccountId: fourth, code });
    await maybeMarkOnboarded(fake.client, fourth);
    fake.db.tables.channel_identities.push({
      account_id: fourth,
      channel: 'telegram',
      external_id: '222',
      phone_e164: '2348011111111',
    });
    const res = await maybeMarkFirstTx(fake.client, {
      accountId: fourth,
      kind: QUALIFYING_KINDS.OUTBOUND_SEND,
      amount: 0.01,
      ok: true,
    });
    assert.equal(res.reason, 'phone_spent');
    assert.equal(await countedInvitesFor(fake.client, INVITER), 1);
    assert.equal(fake.db.tables.channel_identities.some((r) => r.account_id === fourth), true);
  });

  it('allows a LID change on the same account without a second credit', async () => {
    const fake = seed();
    await readyToCount(fake, INVITEE, INVITER);
    fake.db.tables.channel_identities.push({
      account_id: INVITEE,
      channel: 'whatsapp',
      external_id: '999888777666555',
      phone_e164: '2348011111111',
    });
    const res = await tryCountInviteLocal(fake.client, INVITEE);
    assert.equal(res.reason, 'noop');
    assert.equal(await countedInvitesFor(fake.client, INVITER), 1);
  });

  it('does not treat a WhatsApp LID as a countable phone', () => {
    const phones = collectCountablePhones([
      { channel: 'whatsapp', external_id: '2348011111111', phone_e164: '2348011111111' },
    ]);
    assert.deepEqual(phones, []);
  });

  it('lets at most one side of a direct cycle count', async () => {
    const fake = seed();
    await readyToCount(fake, INVITEE, INVITER);
    const back = await readyToCount(fake, INVITER, INVITEE, '2348099999999');
    assert.equal(back.reason, 'circular');
    assert.equal(await countedInvitesFor(fake.client, INVITER), 1);
    assert.equal(await countedInvitesFor(fake.client, INVITEE), 0);
    assert.equal(
      fake.db.tables.invite_attributions.find((r) => r.invitee_account_id === INVITER)
        .count_blocked_reason,
      'circular'
    );
  });
});

describe('optional invite on claims', () => {
  it('does not attach a code when the sender toggle is off', async () => {
    const fake = seed();
    fake.db.tables.accounts.find((a) => a.id === INVITER).attach_invite_on_claims = false;
    assert.equal(await inviteCodeIfAttachEnabled(fake.client, INVITER), null);
  });

  it('attaches the sender code when the toggle is on', async () => {
    const fake = seed();
    fake.db.tables.accounts.find((a) => a.id === INVITER).attach_invite_on_claims = true;
    const code = await inviteCodeIfAttachEnabled(fake.client, INVITER);
    assert.ok(isInviteCodeFormat(code));
    assert.equal(fake.db.tables.invite_codes[0].account_id, INVITER);
  });

  it('records claim_link as the attribution source', async () => {
    const fake = seed();
    const code = await issueFor(fake, INVITER);
    const res = await attributeSignup(fake.client, {
      inviteeAccountId: INVITEE,
      code,
      source: INVITE_SOURCE_CLAIM,
    });
    assert.equal(res.attributed, true);
    assert.equal(fake.db.tables.invite_attributions[0].source, INVITE_SOURCE_CLAIM);
  });

  it('treats an unknown source as invite_link', async () => {
    const fake = seed();
    const code = await issueFor(fake, INVITER);
    await attributeSignup(fake.client, {
      inviteeAccountId: INVITEE,
      code,
      source: 'campaign',
    });
    assert.equal(fake.db.tables.invite_attributions[0].source, INVITE_SOURCE);
  });
});

describe('cookie constants', () => {
  it('uses a 14 day httpOnly cookie named flizy_invite', () => {
    assert.equal(INVITE_COOKIE, 'flizy_invite');
    assert.equal(INVITE_COOKIE_MAX_AGE_SEC, 14 * 24 * 60 * 60);
  });
});

describe('web mirror agrees on the predicates', () => {
  let web;
  before(async () => {
    web = await import('../web/lib/invite.ts');
  });

  it('shares username refs, cookie name and qualifying kinds', () => {
    assert.equal(web.INVITE_COOKIE, INVITE_COOKIE);
    assert.equal(web.INVITE_COOKIE_MAX_AGE_SEC, INVITE_COOKIE_MAX_AGE_SEC);
    assert.equal(web.INVITE_SOURCE, INVITE_SOURCE);
    assert.equal(web.INVITE_SOURCE_CLAIM, INVITE_SOURCE_CLAIM);
    assert.equal(web.INVITE_COOKIE_SRC, 'flizy_invite_src');
    assert.equal(
      web.extractInviteCode('https://flizy.app/i/ludarep'),
      extractInviteCode('https://flizy.app/i/ludarep')
    );
    assert.equal(
      web.extractInviteCode('https://flizy.app/claim/tok/ludarep'),
      extractInviteCode('https://flizy.app/claim/tok/ludarep')
    );
    assert.deepEqual(
      web.resolveSignupInvite('ludarep', 'alice', INVITE_SOURCE_CLAIM),
      resolveSignupInvite('ludarep', 'alice', INVITE_SOURCE_CLAIM)
    );
    assert.deepEqual({ ...web.QUALIFYING_KINDS }, { ...QUALIFYING_KINDS });
  });

  it('agrees on isQualifyingFirstTx', () => {
    const cases = [
      { accountId: 'a', kind: 'claim_payout', amount: 1, ok: true },
      { accountId: 'a', kind: 'outbound_send', amount: 1, ok: true, destinationIsOwnWallet: true },
      { accountId: 'a', kind: 'swap', amount: 1, ok: true },
      { accountId: 'a', kind: 'buy', amount: 1, ok: true },
      { accountId: 'a', kind: 'add_liquidity', amount: 1, ok: true },
      { accountId: 'a', kind: 'remove_liquidity', amount: 1, ok: true },
      { accountId: 'a', kind: 'claim_payout', amount: 0, ok: true },
      { accountId: 'a', kind: 'claim_hold', amount: 1, ok: true },
    ];
    for (const c of cases) {
      assert.equal(web.isQualifyingFirstTx(c), isQualifyingFirstTx(c));
    }
  });

  it('agrees on LID rejection', () => {
    const rows = [
      { channel: 'whatsapp', external_id: '2348011111111', phone_e164: '2348011111111' },
      { channel: 'telegram', external_id: '9', phone_e164: '2348022222222' },
    ];
    assert.deepEqual(web.collectCountablePhones(rows), collectCountablePhones(rows));
  });
});
