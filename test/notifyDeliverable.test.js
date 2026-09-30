/**
 * A notification is only queued where something will read it.
 *
 * An account may link X, GitHub or Discord, and no process registers a sender
 * or drains the outbox for any of them (only index.js for WhatsApp and
 * lib/telegram/bot.js for Telegram do). Without the filter tested here, every
 * fan-out to an account with one linked would write a row that sits pending for
 * ever, and report success.
 *
 * The warnings that announce a new payout destination go through this path, so
 * a silent drop there is a security message nobody receives.
 *
 * Run: node --test test/notifyDeliverable.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

const notify = require('../lib/notify');
const { DELIVERABLE_CHANNELS, isDeliverableChannel } = require('../lib/channelKey');

const ACCOUNT = 'acc-a';

/** One identity per channel, so a fan-out has somewhere to go wrong. */
function seed() {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, email: 'a@example.com', display_name: 'A' }],
    channel_identities: [
      { id: 'i1', account_id: ACCOUNT, channel: 'telegram', external_id: '111', phone_e164: null },
      { id: 'i2', account_id: ACCOUNT, channel: 'whatsapp', external_id: '222', phone_e164: null },
      { id: 'i3', account_id: ACCOUNT, channel: 'github', external_id: '333', phone_e164: null },
      { id: 'i4', account_id: ACCOUNT, channel: 'discord', external_id: '444', phone_e164: null },
      { id: 'i5', account_id: ACCOUNT, channel: 'x', external_id: '555', phone_e164: null },
    ],
    notifications: [],
  });
}

const queued = () => fake.db.tables.notifications || [];

describe('the deliverable set', () => {
  it('is exactly the channels a process drains', () => {
    assert.deepEqual([...DELIVERABLE_CHANNELS].sort(), ['telegram', 'whatsapp']);
  });

  it('answers no for every platform channel', () => {
    for (const ch of ['x', 'github', 'discord']) {
      assert.equal(isDeliverableChannel(ch), false, `${ch} has no reader`);
    }
    assert.equal(isDeliverableChannel('whatsapp'), true);
    assert.equal(isDeliverableChannel('telegram'), true);
    assert.equal(isDeliverableChannel('nonsense'), false);
    assert.equal(isDeliverableChannel(''), false);
  });
});

describe('notifyAccount only queues what can be delivered', () => {
  beforeEach(seed);

  it('writes rows for the chat channels and none for the platforms', async () => {
    await notify.notifyAccount(ACCOUNT, 'a new payout destination was saved');

    const channels = queued().map((r) => r.channel).sort();
    assert.deepEqual(channels, ['telegram', 'whatsapp']);
    assert.equal(
      queued().some((r) => ['x', 'github', 'discord'].includes(r.channel)),
      false,
      'a row nothing drains must never be written'
    );
  });

  it('counts only what it actually queued', async () => {
    const result = await notify.notifyAccount(ACCOUNT, 'body');
    assert.equal(result.delivered + result.queued, 2, 'five identities, two reachable');
  });

  it('still honours the skip list on top of that', async () => {
    await notify.notifyAccount(ACCOUNT, 'body', {
      skip: [{ channel: 'telegram', externalId: '111' }],
    });
    assert.deepEqual(queued().map((r) => r.channel), ['whatsapp']);
  });

  it('queues nothing at all when only platform identities exist', async () => {
    fake = createFakeSupabase({
      accounts: [{ id: ACCOUNT, email: 'a@example.com' }],
      channel_identities: [
        { id: 'i3', account_id: ACCOUNT, channel: 'github', external_id: '333' },
      ],
      notifications: [],
    });

    const result = await notify.notifyAccount(ACCOUNT, 'body');
    assert.equal(queued().length, 0);
    assert.equal(result.delivered + result.queued, 0, 'and it must not claim it warned them');
  });
});

describe('the web copy agrees with the bot copy', () => {
  const WEB_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'lib', 'notifyChannels.ts'),
    'utf8'
  );

  it('lists the same deliverable channels', () => {
    // web/lib cannot import the root package (the Vercel root is `web`), so the
    // set is duplicated. Duplicated means it can drift, which is what this is.
    const match = WEB_SRC.match(/DELIVERABLE_CHANNELS = new Set\(\[([^\]]*)\]\)/);
    assert.ok(match, 'web copy must declare a deliverable set');
    const webSet = match[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
      .sort();
    assert.deepEqual(webSet, [...DELIVERABLE_CHANNELS].sort());
  });

  it('filters on it before writing a row', () => {
    assert.match(
      WEB_SRC,
      /DELIVERABLE_CHANNELS\.has\(/,
      'declaring the set is not the same as using it'
    );
  });

  it('refuses a body carrying a command marker', () => {
    // This path inserts the body raw and drainOutbox sends it untouched, so a
    // marker would reach the person literally.
    assert.match(WEB_SRC, /\{\\\{cmd:/, 'web copy must detect the marker');
  });

  it('no caller of notifyAllChannels passes a marker', () => {
    // Comments are stripped first. A route that explains in prose why it avoids
    // the marker contains the marker, and a guard that fires on its own
    // documentation is one somebody switches off.
    const stripComments = (src) =>
      src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const roots = [path.join(__dirname, '..', 'web', 'lib'), path.join(__dirname, '..', 'web', 'app')];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.next') continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (!src.includes('notifyAllChannels(')) continue;
        // The module that declares the function carries the marker in its own
        // guard and in the comment explaining the guard. Checking callers means
        // callers, not the implementation.
        if (src.includes('export async function notifyAllChannels')) continue;
        if (/\{\{cmd:/.test(stripComments(src))) {
          offenders.push(path.relative(path.join(__dirname, '..'), full));
        }
      }
    };
    for (const root of roots) if (fs.existsSync(root)) walk(root);
    assert.deepEqual(offenders, [], 'these files would deliver a literal marker');
  });
});
