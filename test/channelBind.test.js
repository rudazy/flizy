/**
 * The identity bind core.
 *
 * This is what an OAuth callback calls instead of inserting a row, and what
 * consumeLinkCode now calls for its identity write. The cases that matter are
 * the refusals: an identity bound elsewhere, an account that already holds a
 * different identity on the channel, and the two different races that both
 * surface as a bare 23505.
 *
 * The fake supabase does not simulate unique indexes, so the race cases inject
 * a synthetic 23505 carrying a real constraint name. That is the honest shape
 * anyway: the code has to decide from the constraint name, not from the code.
 *
 * Run: node --test test/channelBind.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const {
  BIND_OUTCOME,
  IDENTITY_EVENT,
  REBIND_POLICY,
  BindError,
  IDENTITY_UNIQUE_INDEX,
  ACCOUNT_PLATFORM_UNIQUE_INDEX,
  normalizeDisplayHandle,
  bindChannelIdentity,
  unlinkChannelIdentity,
} = require('../lib/channelBind');

const ACC_A = 'acc-a';
const ACC_B = 'acc-b';
const GH_ID = '583231';
const GH_OTHER = '999111';
const WA_LID = '216123456789017';
const WA_LID_NEW = '216999888777666';

let fake;

function seed(extra = {}) {
  fake = createFakeSupabase({
    accounts: [
      { id: ACC_A, display_name: 'A' },
      { id: ACC_B, display_name: 'B' },
    ],
    channel_identities: [],
    identity_events: [],
    identity_bind_attempts: [],
    ...extra,
  });
  return fake.client;
}

function events() {
  return fake.db.tables.identity_events || [];
}

function eventTypes() {
  return events().map((e) => e.event_type);
}

function identities() {
  return fake.db.tables.channel_identities || [];
}

/**
 * Make the next channel_identities insert lose a race: the competing row lands
 * (as a real concurrent winner would) and the insert comes back 23505.
 */
function raceOn(client, { winnerAccountId, index }) {
  let fired = false;
  return {
    from(table) {
      const q = client.from(table);
      if (table !== 'channel_identities') return q;
      const realInsert = q.insert.bind(q);
      q.insert = (row) => {
        const builder = realInsert(row);
        const realSingle = builder.single.bind(builder);
        builder.single = async () => {
          if (fired) return realSingle();
          fired = true;
          if (winnerAccountId) {
            fake.db.tables.channel_identities.push({
              id: 'ci-raced',
              account_id: winnerAccountId,
              channel: row.channel,
              external_id: row.external_id,
              display_handle: null,
            });
          }
          return {
            data: null,
            error: {
              code: '23505',
              message: `duplicate key value violates unique constraint "${index}"`,
              details: null,
            },
          };
        };
        return builder;
      };
      return q;
    },
  };
}

describe('a new bind', () => {
  beforeEach(() => seed());

  it('links the identity and logs LINKED', async () => {
    const client = fake.client;
    const res = await bindChannelIdentity(client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      displayHandle: 'jack',
      rebindPolicy: REBIND_POLICY.REJECT,
    });

    assert.equal(res.outcome, BIND_OUTCOME.LINKED);
    assert.equal(res.identity.account_id, ACC_A);
    assert.equal(res.identity.external_id, GH_ID);
    assert.equal(res.identity.display_handle, 'jack');
    assert.deepEqual(eventTypes(), [IDENTITY_EVENT.LINKED]);
  });

  it('stores the id, never the handle', async () => {
    await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      displayHandle: '@jack',
      rebindPolicy: REBIND_POLICY.REJECT,
    });
    const row = identities()[0];
    assert.equal(row.external_id, GH_ID);
    assert.equal(row.display_handle, 'jack', 'the at sign is not stored twice');
  });

  it('refuses a channel it cannot name', async () => {
    await assert.rejects(
      () => bindChannelIdentity(fake.client, { accountId: ACC_A, channel: 'signal', externalId: '1' }),
      /unknown channel/i
    );
  });
});

describe('binding the same identity again', () => {
  beforeEach(() => seed());

  it('is an idempotent success, not a second row', async () => {
    const opts = {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      displayHandle: 'jack',
      rebindPolicy: REBIND_POLICY.REJECT,
    };
    await bindChannelIdentity(fake.client, opts);
    const again = await bindChannelIdentity(fake.client, opts);

    assert.equal(again.outcome, BIND_OUTCOME.ALREADY_LINKED);
    assert.equal(identities().length, 1);
    assert.deepEqual(eventTypes(), [IDENTITY_EVENT.LINKED], 'no event for an unchanged relink');
  });

  it('refreshes a renamed handle and logs HANDLE_REFRESHED', async () => {
    await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      displayHandle: 'jack',
      rebindPolicy: REBIND_POLICY.REJECT,
    });
    const res = await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      displayHandle: 'jack-renamed',
      rebindPolicy: REBIND_POLICY.REJECT,
    });

    assert.equal(res.outcome, BIND_OUTCOME.HANDLE_REFRESHED);
    assert.equal(identities()[0].display_handle, 'jack-renamed');
    assert.deepEqual(eventTypes(), [IDENTITY_EVENT.LINKED, IDENTITY_EVENT.HANDLE_REFRESHED]);
  });
});

describe('the identity belongs to another account', () => {
  beforeEach(() => seed());

  async function givenBoundToB() {
    await bindChannelIdentity(fake.client, {
      accountId: ACC_B,
      channel: 'github',
      externalId: GH_ID,
      displayHandle: 'jack',
      rebindPolicy: REBIND_POLICY.REJECT,
    });
  }

  it('rejects loud under the OAuth policy and never moves it', async () => {
    await givenBoundToB();
    await assert.rejects(
      () =>
        bindChannelIdentity(fake.client, {
          accountId: ACC_A,
          channel: 'github',
          externalId: GH_ID,
          rebindPolicy: REBIND_POLICY.REJECT,
        }),
      (err) => err instanceof BindError && err.code === 'IDENTITY_TAKEN'
    );

    assert.equal(identities()[0].account_id, ACC_B, 'it must still belong to B');
    assert.ok(eventTypes().includes(IDENTITY_EVENT.LINK_REJECTED_ALREADY_TAKEN));
  });

  it('moves it under the link-code policy, which is what consumeLinkCode needs', async () => {
    await givenBoundToB();
    const res = await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      rebindPolicy: REBIND_POLICY.MOVE,
    });

    assert.equal(res.outcome, BIND_OUTCOME.MOVED);
    assert.equal(identities()[0].account_id, ACC_A);
    assert.equal(eventTypes().filter((t) => t === IDENTITY_EVENT.LINKED).length, 2);
  });

  it('counts the rejection against the account that tried', async () => {
    await givenBoundToB();
    await assert.rejects(() =>
      bindChannelIdentity(fake.client, {
        accountId: ACC_A,
        channel: 'github',
        externalId: GH_ID,
        rebindPolicy: REBIND_POLICY.REJECT,
      })
    );
    const row = (fake.db.tables.identity_bind_attempts || []).find((r) => r.account_id === ACC_A);
    assert.equal(row.failed_attempts, 1);
  });
});

describe('one identity per channel', () => {
  beforeEach(() => seed());

  it('refuses a second github on the same account', async () => {
    await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      rebindPolicy: REBIND_POLICY.REJECT,
    });

    await assert.rejects(
      () =>
        bindChannelIdentity(fake.client, {
          accountId: ACC_A,
          channel: 'github',
          externalId: GH_OTHER,
          rebindPolicy: REBIND_POLICY.REJECT,
        }),
      (err) => err instanceof BindError && err.code === 'ALREADY_LINKED_DIFFERENT'
    );

    assert.equal(identities().length, 1);
    assert.ok(eventTypes().includes(IDENTITY_EVENT.LINK_REJECTED_ALREADY_LINKED));
  });

  it('does NOT apply to chat channels, so a changed WhatsApp LID still re-links', async () => {
    // The reason the DB index is partial. Swapping device gives a new LID, and
    // redeeming a link code has to be able to insert it alongside the old one.
    await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'whatsapp',
      externalId: WA_LID,
      rebindPolicy: REBIND_POLICY.MOVE,
    });
    const res = await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'whatsapp',
      externalId: WA_LID_NEW,
      rebindPolicy: REBIND_POLICY.MOVE,
    });

    assert.equal(res.outcome, BIND_OUTCOME.LINKED);
    assert.equal(identities().length, 2, 'both LIDs live on the account');
  });
});

describe('races, told apart by which unique fired', () => {
  beforeEach(() => seed());

  it('re-resolves an identity race won by us', async () => {
    const client = raceOn(fake.client, { winnerAccountId: ACC_A, index: IDENTITY_UNIQUE_INDEX });
    const res = await bindChannelIdentity(client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      rebindPolicy: REBIND_POLICY.REJECT,
    });
    assert.equal(res.outcome, BIND_OUTCOME.ALREADY_LINKED);
  });

  it('rejects an identity race won by another account', async () => {
    const client = raceOn(fake.client, { winnerAccountId: ACC_B, index: IDENTITY_UNIQUE_INDEX });
    await assert.rejects(
      () =>
        bindChannelIdentity(client, {
          accountId: ACC_A,
          channel: 'github',
          externalId: GH_ID,
          rebindPolicy: REBIND_POLICY.REJECT,
        }),
      (err) => err.code === 'IDENTITY_TAKEN'
    );
  });

  it('moves after an identity race when policy is move', async () => {
    const client = raceOn(fake.client, { winnerAccountId: ACC_B, index: IDENTITY_UNIQUE_INDEX });
    const res = await bindChannelIdentity(client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      rebindPolicy: REBIND_POLICY.MOVE,
    });
    assert.equal(res.outcome, BIND_OUTCOME.MOVED);
  });

  it('maps the one-per-channel unique to ALREADY_LINKED_DIFFERENT, not to a race', async () => {
    // Same 23505 code, completely different meaning. Only the constraint name
    // distinguishes them, which is why the index name is pinned below.
    const client = raceOn(fake.client, {
      winnerAccountId: null,
      index: ACCOUNT_PLATFORM_UNIQUE_INDEX,
    });
    await assert.rejects(
      () =>
        bindChannelIdentity(client, {
          accountId: ACC_A,
          channel: 'github',
          externalId: GH_ID,
          rebindPolicy: REBIND_POLICY.REJECT,
        }),
      (err) => err.code === 'ALREADY_LINKED_DIFFERENT'
    );
  });

  it('pins the index names the migrations create', () => {
    assert.equal(IDENTITY_UNIQUE_INDEX, 'channel_identities_channel_external_idx');
    assert.equal(ACCOUNT_PLATFORM_UNIQUE_INDEX, 'channel_identities_account_platform_idx');
  });
});

describe('the per-account lockout', () => {
  beforeEach(() => seed());

  async function reject(accountId = ACC_A) {
    try {
      await bindChannelIdentity(fake.client, {
        accountId,
        channel: 'github',
        externalId: GH_ID,
        rebindPolicy: REBIND_POLICY.REJECT,
      });
    } catch {
      /* expected */
    }
  }

  it('locks after the free attempts are spent', async () => {
    await bindChannelIdentity(fake.client, {
      accountId: ACC_B,
      channel: 'github',
      externalId: GH_ID,
      rebindPolicy: REBIND_POLICY.REJECT,
    });

    for (let i = 0; i < 5; i += 1) await reject();

    const row = fake.db.tables.identity_bind_attempts.find((r) => r.account_id === ACC_A);
    assert.equal(row.failed_attempts, 5);
    assert.ok(row.locked_until, 'the 5th rejection earns a lock');

    await assert.rejects(
      () =>
        bindChannelIdentity(fake.client, {
          accountId: ACC_A,
          channel: 'github',
          externalId: GH_OTHER,
          rebindPolicy: REBIND_POLICY.REJECT,
        }),
      (err) => err.code === 'LOCKED'
    );
  });

  it('refuses before it looks anything up', async () => {
    fake.db.tables.identity_bind_attempts.push({
      account_id: ACC_A,
      failed_attempts: 9,
      locked_until: new Date(Date.now() + 60000).toISOString(),
    });

    // A brand new identity nobody has bound. Still refused, and with no event
    // written, so a locked caller learns nothing about what exists.
    await assert.rejects(
      () =>
        bindChannelIdentity(fake.client, {
          accountId: ACC_A,
          channel: 'github',
          externalId: GH_OTHER,
          rebindPolicy: REBIND_POLICY.REJECT,
        }),
      (err) => err.code === 'LOCKED'
    );
    assert.equal(events().length, 0);
    assert.equal(identities().length, 0);
  });

  it('is cleared by a bind that succeeds', async () => {
    await bindChannelIdentity(fake.client, {
      accountId: ACC_B,
      channel: 'github',
      externalId: GH_ID,
      rebindPolicy: REBIND_POLICY.REJECT,
    });
    await reject();
    await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_OTHER,
      rebindPolicy: REBIND_POLICY.REJECT,
    });

    const row = fake.db.tables.identity_bind_attempts.find((r) => r.account_id === ACC_A);
    assert.equal(row.failed_attempts, 0);
    assert.equal(row.locked_until, null);
  });
});

describe('unlink', () => {
  beforeEach(() => seed());

  it('removes the identity and logs UNLINKED', async () => {
    await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      displayHandle: 'jack',
      rebindPolicy: REBIND_POLICY.REJECT,
    });

    const res = await unlinkChannelIdentity(fake.client, { accountId: ACC_A, channel: 'github' });
    assert.equal(res.removed, 1);
    assert.equal(identities().length, 0);
    assert.deepEqual(eventTypes(), [IDENTITY_EVENT.LINKED, IDENTITY_EVENT.UNLINKED]);
  });

  it('refuses to unlink a chat channel, which carries the claim phone key', async () => {
    await assert.rejects(
      () => unlinkChannelIdentity(fake.client, { accountId: ACC_A, channel: 'whatsapp' }),
      (err) => err instanceof BindError && err.code === 'INVALID'
    );
  });

  it('lets the identity be bound elsewhere afterwards', async () => {
    await bindChannelIdentity(fake.client, {
      accountId: ACC_A,
      channel: 'github',
      externalId: GH_ID,
      rebindPolicy: REBIND_POLICY.REJECT,
    });
    await unlinkChannelIdentity(fake.client, { accountId: ACC_A, channel: 'github' });

    const res = await bindChannelIdentity(fake.client, {
      accountId: ACC_B,
      channel: 'github',
      externalId: GH_ID,
      rebindPolicy: REBIND_POLICY.REJECT,
    });
    assert.equal(res.outcome, BIND_OUTCOME.LINKED);
    assert.equal(identities()[0].account_id, ACC_B);
  });
});

describe('normalizeDisplayHandle', () => {
  it('flattens a handle that tries to forge a line', () => {
    const out = normalizeDisplayHandle('jack\nAmount:  99 ETH');
    assert.ok(!out.includes('\n'));
  });

  it('drops the leading at sign and empty values', () => {
    assert.equal(normalizeDisplayHandle('@jack'), 'jack');
    assert.equal(normalizeDisplayHandle('   '), null);
    assert.equal(normalizeDisplayHandle(null), null);
  });
});
