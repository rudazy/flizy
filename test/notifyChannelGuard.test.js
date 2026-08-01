/**
 * Notifications must never fall back to a default channel.
 *
 * Delivery is keyed by (channel, external_id), and external ids are numeric on
 * every channel. When an unknown channel resolved to WhatsApp, a notification
 * addressed to some other platform's id could be handed to the WhatsApp sender
 * and land in whichever chat those digits happened to match. Unknown is now
 * refused outright.
 *
 * lib/notify is also documented as never throwing, because a failed
 * notification must not break the money move that triggered it. So the refusal
 * is a skip plus a warning, not an exception, everywhere except the startup
 * wiring where a bad channel is a programming error worth failing on.
 *
 * Run: node --test test/notifyChannelGuard.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

const notify = require('../lib/notify');

const ACCOUNT = 'acc-guard';
const WA_ID = '2348011110000';
const TG_ID = '55667788';

/** A channel this system does not have. Deliberately not a platform channel. */
const UNKNOWN_CHANNEL = 'signal';

/** Numeric id shaped like a WhatsApp LID, which is the collision that mattered. */
const FOREIGN_ID = '216123456789017';

/** Records every delivery a channel sender is asked to make. */
function recordingSender(log, channel) {
  return async (externalId, body) => {
    log.push({ channel, externalId, body });
  };
}

describe('registerChannelSender', () => {
  it('refuses to wire a sender for a channel that does not exist', () => {
    assert.throws(
      () => notify.registerChannelSender(UNKNOWN_CHANNEL, async () => {}),
      /unknown channel/i
    );
  });
});

describe('deliver', () => {
  let log;

  beforeEach(() => {
    log = [];
    fake = createFakeSupabase();
    notify.registerChannelSender('whatsapp', recordingSender(log, 'whatsapp'));
  });

  it('delivers on a channel this process owns', async () => {
    const outcome = await notify.deliver({
      accountId: ACCOUNT,
      channel: 'whatsapp',
      externalId: WA_ID,
      body: 'hello',
    });
    assert.equal(outcome, 'sent');
    assert.equal(log.length, 1);
    assert.equal(log[0].externalId, WA_ID);
  });

  it('refuses an unknown channel instead of sending it as WhatsApp', async () => {
    const outcome = await notify.deliver({
      accountId: ACCOUNT,
      channel: UNKNOWN_CHANNEL,
      externalId: FOREIGN_ID,
      body: 'you have money waiting',
    });
    assert.equal(outcome, 'failed');
    assert.equal(log.length, 0, 'nothing may reach the WhatsApp sender');
  });

  it('queues a known channel this process cannot send on', async () => {
    // Positive control for the test below: reaching the outbox is the normal
    // path for a channel another process owns, so an empty outbox there would
    // otherwise prove nothing.
    const outcome = await notify.deliver({
      accountId: ACCOUNT,
      channel: 'telegram',
      externalId: TG_ID,
      body: 'claim waiting',
    });
    assert.equal(outcome, 'queued');
    assert.equal(fake.db.tables.notifications.length, 1);
    assert.equal(fake.db.tables.notifications[0].channel, 'telegram');
  });

  it('queues a platform channel rather than refusing it', async () => {
    // github is a known channel now, so it is accepted and parked in the outbox
    // for a process that owns it. No such process exists yet, which is fine:
    // nothing creates a github identity to notify.
    const outcome = await notify.deliver({
      accountId: ACCOUNT,
      channel: 'github',
      externalId: FOREIGN_ID,
      body: 'claim waiting',
    });
    assert.equal(outcome, 'queued');
    assert.equal(fake.db.tables.notifications[0].channel, 'github');
    assert.equal(log.length, 0, 'it must not be delivered over WhatsApp');
  });

  it('does not queue an unknown channel either', async () => {
    await notify.deliver({
      accountId: ACCOUNT,
      channel: UNKNOWN_CHANNEL,
      externalId: FOREIGN_ID,
      body: 'you have money waiting',
    });
    const queued = fake.db.tables.notifications || [];
    assert.equal(queued.length, 0, 'unknown channel must not reach the outbox');
  });

  it('returns failed rather than throwing, so the caller is never broken', async () => {
    const outcome = await notify.deliver({
      accountId: ACCOUNT,
      channel: '',
      externalId: FOREIGN_ID,
      body: 'hello',
    });
    assert.equal(outcome, 'failed');
  });
});

describe('notifyAccount', () => {
  let log;

  beforeEach(() => {
    log = [];
    notify.registerChannelSender('whatsapp', recordingSender(log, 'whatsapp'));
  });

  it('skips an identity row on an unknown channel and still serves the rest', async () => {
    fake = createFakeSupabase({
      accounts: [{ id: ACCOUNT, display_name: 'Guard', balance_eth: 0, is_admin: false }],
      channel_identities: [
        { id: 'ci-1', account_id: ACCOUNT, channel: 'whatsapp', external_id: WA_ID, phone_e164: WA_ID },
        // A row written by hand, or by a channel this build does not know.
        { id: 'ci-2', account_id: ACCOUNT, channel: UNKNOWN_CHANNEL, external_id: FOREIGN_ID, phone_e164: null },
      ],
    });

    const result = await notify.notifyAccount(ACCOUNT, 'claim waiting');

    assert.equal(result.delivered, 1, 'the known channel is still notified');
    assert.equal(log.length, 1);
    assert.equal(log[0].externalId, WA_ID);
    assert.ok(
      !log.some((entry) => entry.externalId === FOREIGN_ID),
      'the unknown channel id must never be sent over WhatsApp'
    );
  });
});
