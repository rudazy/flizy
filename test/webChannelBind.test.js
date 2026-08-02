/**
 * The drift guard for the bind mirror.
 *
 * web/lib/channelBind.ts is a hand-kept copy of lib/channelBind.js, because the
 * Vercel Root Directory is web so ../lib never reaches the deploy. Two copies of
 * the code that decides who owns an identity is exactly the kind of duplication
 * that rots quietly: the web side keeps binding after the bot side learns to
 * refuse, and nobody notices until an identity ends up on the wrong account.
 *
 * This is stronger than a pinned vector. Both implementations take an injected
 * client, so every scenario below runs twice against identical fake databases
 * and the results are compared whole: the outcome or error code, the identity
 * rows that survived, the audit events in order, and the lockout counters. Any
 * behavioural difference fails here.
 *
 * Run: node --test test/webChannelBind.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const bot = require('../lib/channelBind');

let web;

before(async () => {
  web = await import('../web/lib/channelBind.ts');
});

const ACC_A = 'acc-a';
const ACC_B = 'acc-b';
const GH_ID = '583231';
const GH_OTHER = '999111';
const WA_LID = '216123456789017';
const WA_LID_NEW = '216999888777666';

function freshDb() {
  return createFakeSupabase({
    accounts: [
      { id: ACC_A, display_name: 'A' },
      { id: ACC_B, display_name: 'B' },
    ],
    channel_identities: [],
    identity_events: [],
    identity_bind_attempts: [],
  });
}

/** Generated ids differ between runs, so compare everything except those. */
function snapshot(fake) {
  const strip = (rows, keys) =>
    (rows || []).map((r) => {
      const out = {};
      for (const k of keys) out[k] = r[k] === undefined ? null : r[k];
      return out;
    });

  return {
    identities: strip(fake.db.tables.channel_identities, [
      'account_id',
      'channel',
      'external_id',
      'display_handle',
      'phone_e164',
    ]),
    events: strip(fake.db.tables.identity_events, [
      'account_id',
      'channel',
      'external_id',
      'display_handle',
      'event_type',
    ]),
    attempts: strip(fake.db.tables.identity_bind_attempts, ['account_id', 'failed_attempts']),
  };
}

/**
 * Run one scenario against an implementation and capture everything observable.
 * @param {object} impl bot or web module
 * @param {Array<object>} steps
 */
async function run(impl, steps) {
  const fake = freshDb();
  const results = [];

  for (const step of steps) {
    try {
      if (step.unlink) {
        const res = await impl.unlinkChannelIdentity(fake.client, step.unlink);
        results.push({ ok: true, outcome: `UNLINKED:${res.removed}` });
      } else {
        const res = await impl.bindChannelIdentity(fake.client, step);
        results.push({ ok: true, outcome: res.outcome });
      }
    } catch (err) {
      results.push({ ok: false, code: err.code || 'THROWN', message: err.message });
    }
  }

  return { results, state: snapshot(fake) };
}

/** Assert both implementations behave identically for a scenario. */
async function assertNoDrift(name, steps) {
  const fromBot = await run(bot, steps);
  const fromWeb = await run(web, steps);
  assert.deepEqual(fromWeb.results, fromBot.results, `${name}: outcomes differ`);
  assert.deepEqual(fromWeb.state.identities, fromBot.state.identities, `${name}: identity rows differ`);
  assert.deepEqual(fromWeb.state.events, fromBot.state.events, `${name}: audit events differ`);
  assert.deepEqual(fromWeb.state.attempts, fromBot.state.attempts, `${name}: lockout counters differ`);
  return fromBot;
}

const REJECT = 'reject';
const MOVE = 'move';

describe('the bind mirror does not drift', () => {
  it('agrees on a new bind', async () => {
    const out = await assertNoDrift('new bind', [
      { accountId: ACC_A, channel: 'github', externalId: GH_ID, displayHandle: 'jack', rebindPolicy: REJECT },
    ]);
    assert.equal(out.results[0].outcome, 'LINKED');
  });

  it('agrees on an idempotent relink', async () => {
    const step = {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      displayHandle: 'jack',
      rebindPolicy: REJECT,
    };
    const out = await assertNoDrift('idempotent', [step, step]);
    assert.equal(out.results[1].outcome, 'ALREADY_LINKED');
  });

  it('agrees on a handle refresh', async () => {
    const out = await assertNoDrift('handle refresh', [
      { accountId: ACC_A, channel: 'github', externalId: GH_ID, displayHandle: 'jack', rebindPolicy: REJECT },
      { accountId: ACC_A, channel: 'github', externalId: GH_ID, displayHandle: 'renamed', rebindPolicy: REJECT },
    ]);
    assert.equal(out.results[1].outcome, 'HANDLE_REFRESHED');
  });

  it('agrees on rejecting an identity owned by another account', async () => {
    const out = await assertNoDrift('cross account reject', [
      { accountId: ACC_B, channel: 'github', externalId: GH_ID, rebindPolicy: REJECT },
      { accountId: ACC_A, channel: 'github', externalId: GH_ID, rebindPolicy: REJECT },
    ]);
    assert.equal(out.results[1].code, 'IDENTITY_TAKEN');
  });

  it('agrees on moving under the link-code policy', async () => {
    const out = await assertNoDrift('cross account move', [
      { accountId: ACC_B, channel: 'github', externalId: GH_ID, rebindPolicy: REJECT },
      { accountId: ACC_A, channel: 'github', externalId: GH_ID, rebindPolicy: MOVE },
    ]);
    assert.equal(out.results[1].outcome, 'MOVED');
  });

  it('agrees on refusing a second identity on one platform channel', async () => {
    const out = await assertNoDrift('already linked', [
      { accountId: ACC_A, channel: 'github', externalId: GH_ID, rebindPolicy: REJECT },
      { accountId: ACC_A, channel: 'github', externalId: GH_OTHER, rebindPolicy: REJECT },
    ]);
    assert.equal(out.results[1].code, 'ALREADY_LINKED_DIFFERENT');
  });

  it('agrees that chat channels may hold two identities', async () => {
    const out = await assertNoDrift('whatsapp second LID', [
      { accountId: ACC_A, channel: 'whatsapp', externalId: WA_LID, rebindPolicy: MOVE },
      { accountId: ACC_A, channel: 'whatsapp', externalId: WA_LID_NEW, rebindPolicy: MOVE },
    ]);
    assert.equal(out.results[1].outcome, 'LINKED');
    assert.equal(out.state.identities.length, 2);
  });

  it('agrees on the lockout ladder', async () => {
    const taken = { accountId: ACC_B, channel: 'github', externalId: GH_ID, rebindPolicy: REJECT };
    const attempt = { accountId: ACC_A, channel: 'github', externalId: GH_ID, rebindPolicy: REJECT };
    const out = await assertNoDrift('lockout', [
      taken,
      attempt,
      attempt,
      attempt,
      attempt,
      attempt,
      attempt,
    ]);
    assert.equal(out.results[5].code, 'IDENTITY_TAKEN', 'the 5th reject still reports the reason');
    assert.equal(out.results[6].code, 'LOCKED', 'the 6th is refused by the ladder');
  });

  it('agrees on unlink', async () => {
    const out = await assertNoDrift('unlink', [
      { accountId: ACC_A, channel: 'github', externalId: GH_ID, displayHandle: 'jack', rebindPolicy: REJECT },
      { unlink: { accountId: ACC_A, channel: 'github' } },
      { accountId: ACC_B, channel: 'github', externalId: GH_ID, rebindPolicy: REJECT },
    ]);
    assert.equal(out.results[2].outcome, 'LINKED', 'the identity is free after unlink');
  });

  it('agrees on refusing to unlink a chat channel', async () => {
    await assertNoDrift('unlink chat refused', [{ unlink: { accountId: ACC_A, channel: 'whatsapp' } }]);
  });

  it('agrees on refusing an unknown channel', async () => {
    await assertNoDrift('unknown channel', [
      { accountId: ACC_A, channel: 'signal', externalId: '123', rebindPolicy: REJECT },
    ]);
  });
});

describe('the mirrored constants match', () => {
  it('pins the same index names on both sides', () => {
    assert.equal(web.IDENTITY_UNIQUE_INDEX, bot.IDENTITY_UNIQUE_INDEX);
    assert.equal(web.ACCOUNT_PLATFORM_UNIQUE_INDEX, bot.ACCOUNT_PLATFORM_UNIQUE_INDEX);
  });

  it('agrees on outcomes, events and policies', () => {
    assert.deepEqual({ ...web.BIND_OUTCOME }, { ...bot.BIND_OUTCOME });
    assert.deepEqual({ ...web.IDENTITY_EVENT }, { ...bot.IDENTITY_EVENT });
    assert.deepEqual({ ...web.REBIND_POLICY }, { ...bot.REBIND_POLICY });
  });

  it('agrees on which channels are platform channels', () => {
    const { isPlatformChannel } = require('../lib/channelKey');
    for (const ch of ['whatsapp', 'telegram', 'x', 'github', 'discord', 'signal']) {
      assert.equal(web.isPlatformChannel(ch), isPlatformChannel(ch), `${ch} differs`);
    }
  });

  it('agrees on the lockout ladder math', () => {
    const { lockoutMsForAttempts, formatWait } = require('../lib/lockoutLadder');
    for (let n = 0; n <= 12; n += 1) {
      assert.equal(web.lockoutMsForAttempts(n), lockoutMsForAttempts(n), `attempt ${n} differs`);
    }
    for (const ms of [1000, 59000, 60000, 3600000, 86400000]) {
      assert.equal(web.formatWait(ms), formatWait(ms), `${ms} formats differently`);
    }
  });

  it('agrees on handle normalization', () => {
    for (const raw of ['@jack', 'jack', '  ', null, 'jack\nAmount: 99', 'x'.repeat(60)]) {
      assert.equal(
        web.normalizeDisplayHandle(raw),
        bot.normalizeDisplayHandle(raw),
        `${JSON.stringify(raw)} differs`
      );
    }
  });
});
