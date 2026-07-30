/**
 * Channel-agnostic identity: (channel, external id) -> account, and the rule
 * that one phone maps to exactly one account across every channel.
 *
 * Run: node --test test/identityChannel.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();
mockSupabaseModule({
  // Indirection so each test can swap the seed without re-requiring identity
  from: (table) => fake.client.from(table),
});

const identity = require('../lib/identity');
const {
  CHANNELS,
  identityTransferKey,
  getAccountByIdentity,
  getOrCreateAccountForIdentity,
  listIdentitiesForAccount,
  findAccountIdByPhone,
  assertPhoneFreeForAccount,
  setIdentityPhone,
  consumeLinkCode,
} = identity;

const PHONE = '2348012345678';
const WA_LID = '216123456789017';
const TG_ID = '778899123';

function seedAccounts() {
  fake = createFakeSupabase({
    accounts: [
      { id: 'acc-a', email: 'a@example.com', display_name: 'A', balance_eth: 0, is_admin: false },
      { id: 'acc-b', email: 'b@example.com', display_name: 'B', balance_eth: 0, is_admin: false },
    ],
  });
}

describe('identityTransferKey', () => {
  it('keeps WhatsApp ids bare so historic transfer rows still match', () => {
    assert.equal(identityTransferKey('whatsapp', WA_LID), WA_LID);
    assert.equal(identityTransferKey('whatsapp', `${WA_LID}@c.us`), WA_LID);
  });

  it('namespaces other channels so a Telegram id cannot collide with a phone', () => {
    assert.equal(identityTransferKey('telegram', TG_ID), `telegram:${TG_ID}`);
    assert.notEqual(identityTransferKey('telegram', PHONE), PHONE);
  });
});

describe('channel-agnostic lookup', () => {
  beforeEach(seedAccounts);

  it('resolves the same account from a WhatsApp and a Telegram identity', async () => {
    fake.db.tables.channel_identities.push(
      { id: 'i1', account_id: 'acc-a', channel: 'whatsapp', external_id: WA_LID, phone_e164: null },
      { id: 'i2', account_id: 'acc-a', channel: 'telegram', external_id: TG_ID, phone_e164: null }
    );

    const wa = await getAccountByIdentity(CHANNELS.WHATSAPP, WA_LID);
    const tg = await getAccountByIdentity(CHANNELS.TELEGRAM, TG_ID);

    assert.equal(wa.account.id, 'acc-a');
    assert.equal(tg.account.id, 'acc-a');
    assert.equal(wa.identity.channel, 'whatsapp');
    assert.equal(tg.identity.channel, 'telegram');
  });

  it('does not mix channels that share the same digits', async () => {
    fake.db.tables.channel_identities.push(
      { id: 'i1', account_id: 'acc-a', channel: 'whatsapp', external_id: '5551234567', phone_e164: null },
      { id: 'i2', account_id: 'acc-b', channel: 'telegram', external_id: '5551234567', phone_e164: null }
    );

    const wa = await getAccountByIdentity(CHANNELS.WHATSAPP, '5551234567');
    const tg = await getAccountByIdentity(CHANNELS.TELEGRAM, '5551234567');

    assert.equal(wa.account.id, 'acc-a');
    assert.equal(tg.account.id, 'acc-b');
  });

  it('returns null for an unknown identity', async () => {
    assert.equal(await getAccountByIdentity(CHANNELS.TELEGRAM, '404404404'), null);
  });

  it('lists every identity on one account for cross-channel notification', async () => {
    fake.db.tables.channel_identities.push(
      { id: 'i1', account_id: 'acc-a', channel: 'whatsapp', external_id: WA_LID, phone_e164: PHONE },
      { id: 'i2', account_id: 'acc-a', channel: 'telegram', external_id: TG_ID, phone_e164: PHONE },
      { id: 'i3', account_id: 'acc-b', channel: 'telegram', external_id: '999', phone_e164: null }
    );

    const rows = await listIdentitiesForAccount('acc-a');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.channel).sort(),
      ['telegram', 'whatsapp']
    );
  });

  it('creates an account and identity for a first-time Telegram user', async () => {
    const created = await getOrCreateAccountForIdentity(CHANNELS.TELEGRAM, TG_ID);
    assert.equal(created.isNew, true);
    assert.ok(created.account.id);

    const again = await getOrCreateAccountForIdentity(CHANNELS.TELEGRAM, TG_ID);
    assert.equal(again.isNew, false);
    assert.equal(again.account.id, created.account.id);
  });
});

describe('one phone maps to exactly one account, across channels', () => {
  beforeEach(seedAccounts);

  it('finds the owning account by phone regardless of channel', async () => {
    fake.db.tables.channel_identities.push({
      id: 'i1',
      account_id: 'acc-a',
      channel: 'telegram',
      external_id: TG_ID,
      phone_e164: PHONE,
    });
    assert.equal(await findAccountIdByPhone(PHONE), 'acc-a');
    assert.equal(await findAccountIdByPhone(`+234 801 234 5678`), 'acc-a');
  });

  it('allows the same phone on several identities of the SAME account', async () => {
    fake.db.tables.channel_identities.push(
      { id: 'i1', account_id: 'acc-a', channel: 'whatsapp', external_id: WA_LID, phone_e164: PHONE },
      { id: 'i2', account_id: 'acc-a', channel: 'telegram', external_id: TG_ID, phone_e164: null }
    );

    const free = await assertPhoneFreeForAccount(PHONE, 'acc-a');
    assert.equal(free.ok, true);

    const res = await setIdentityPhone(CHANNELS.TELEGRAM, TG_ID, PHONE);
    assert.equal(res.ok, true);
    assert.equal(res.phone, PHONE);
  });

  it('refuses to attach a phone already bound to a DIFFERENT account', async () => {
    fake.db.tables.channel_identities.push(
      { id: 'i1', account_id: 'acc-a', channel: 'whatsapp', external_id: WA_LID, phone_e164: PHONE },
      { id: 'i2', account_id: 'acc-b', channel: 'telegram', external_id: TG_ID, phone_e164: null }
    );

    const free = await assertPhoneFreeForAccount(PHONE, 'acc-b');
    assert.equal(free.ok, false);
    assert.equal(free.reason, 'phone_taken');

    const res = await setIdentityPhone(CHANNELS.TELEGRAM, TG_ID, PHONE);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'phone_taken');

    // Nothing was written: acc-b must not silently acquire the number
    const row = fake.db.tables.channel_identities.find((r) => r.id === 'i2');
    assert.equal(row.phone_e164, null);
    assert.equal(await findAccountIdByPhone(PHONE), 'acc-a');
  });

  it('rejects an implausible number instead of storing junk', async () => {
    fake.db.tables.channel_identities.push({
      id: 'i2',
      account_id: 'acc-b',
      channel: 'telegram',
      external_id: TG_ID,
      phone_e164: null,
    });
    const res = await setIdentityPhone(CHANNELS.TELEGRAM, TG_ID, '12345');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'invalid');
  });
});

describe('link codes bind any channel', () => {
  beforeEach(seedAccounts);

  function seedCode(code, accountId, ttlMs = 60000) {
    fake.db.tables.link_codes.push({
      id: `code-${code}`,
      account_id: accountId,
      code,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
      used_at: null,
    });
  }

  it('binds a Telegram identity and burns the code', async () => {
    seedCode('AAAA1111', 'acc-a');

    const res = await consumeLinkCode(CHANNELS.TELEGRAM, TG_ID, 'aaaa1111');
    assert.equal(res.ok, true);
    assert.equal(res.account.id, 'acc-a');

    const burned = fake.db.tables.link_codes[0];
    assert.ok(burned.used_at);
    assert.equal(burned.used_by_channel, 'telegram');

    // 'used', not 'invalid': a spent code is one we really issued, so it is
    // reported as spent and never counted as a guess.
    const again = await consumeLinkCode(CHANNELS.TELEGRAM, TG_ID, 'AAAA1111');
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'used');
  });

  it('rejects an expired code', async () => {
    seedCode('BBBB2222', 'acc-a', -1000);
    const res = await consumeLinkCode(CHANNELS.TELEGRAM, TG_ID, 'BBBB2222');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
  });

  it('fails loudly when the verified phone belongs to another account, and leaves the code usable', async () => {
    fake.db.tables.channel_identities.push({
      id: 'i1',
      account_id: 'acc-a',
      channel: 'whatsapp',
      external_id: WA_LID,
      phone_e164: PHONE,
    });
    seedCode('CCCC3333', 'acc-b');

    const res = await consumeLinkCode(CHANNELS.TELEGRAM, TG_ID, 'CCCC3333', PHONE);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'phone_bound_elsewhere');

    // No identity created for acc-b, and the code is still unburned
    assert.equal(await getAccountByIdentity(CHANNELS.TELEGRAM, TG_ID), null);
    assert.equal(fake.db.tables.link_codes[0].used_at, null);
  });

  it('lets one account hold both a WhatsApp and a Telegram identity', async () => {
    seedCode('DDDD4444', 'acc-a');
    seedCode('EEEE5555', 'acc-a');

    await consumeLinkCode(CHANNELS.WHATSAPP, WA_LID, 'DDDD4444');
    await consumeLinkCode(CHANNELS.TELEGRAM, TG_ID, 'EEEE5555');

    const rows = await listIdentitiesForAccount('acc-a');
    assert.equal(rows.length, 2);
  });
});
