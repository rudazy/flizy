/**
 * Owner notices and the chat lock behind a password change, and the history
 * projection that keeps a sender's identity key out of the receiver's browser.
 *
 * Run: node --test test/securityNotice.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let notice;
let historyRow;

before(async () => {
  notice = await import('../web/lib/securityNotice.ts');
  historyRow = await import('../web/lib/historyRow.ts');
});

const SITE = 'https://flizy.test';
const AT = new Date('2026-10-14T09:30:00Z');

describe('chatLabel', () => {
  it('uses the Telegram handle when there is one', () => {
    assert.equal(notice.chatLabel({ display_handle: '@ada_o', external_id: '5566778899' }), '@ada_o');
  });

  it('shows only the last four digits of a number or id', () => {
    assert.equal(notice.chatLabel({ phone_e164: '2348012345678' }), 'ending 5678');
    assert.equal(notice.chatLabel({ external_id: '112233445566778' }), 'ending 6778');
  });

  it('strips anything from a handle that could add a line to the mail', () => {
    assert.equal(notice.chatLabel({ display_handle: 'eve\nTo: attacker' }), '@eveToattacker');
  });
});

describe('the mails', () => {
  it('link code mail says what a code grants and how to undo it', () => {
    const mail = notice.linkCodeMail(SITE, AT);
    assert.match(mail.subject, /chat link code/i);
    assert.match(mail.text, /Change your password: https:\/\/flizy\.test\/dashboard\/account\?s=security/);
    assert.match(mail.text, /locks every linked chat/);
  });

  it('password mail lists every linked chat', () => {
    const mail = notice.passwordChangedMail(
      SITE,
      [
        { channel: 'whatsapp', label: 'ending 5678', linkedAt: '2026-09-01T10:00:00Z' },
        { channel: 'telegram', label: '@stranger', linkedAt: null },
      ],
      AT
    );
    assert.match(mail.text, /WhatsApp \(ending 5678\), linked 2026-09-01/);
    assert.match(mail.text, /Telegram \(@stranger\)/);
    assert.match(mail.text, /every linked chat was locked/);
  });

  it('password mail does not claim a lock that failed', () => {
    const mail = notice.passwordChangedMail(SITE, [], AT, false);
    assert.doesNotMatch(mail.text, /every linked chat was locked/);
    assert.match(mail.text, /could not be locked automatically/);
    assert.match(mail.text, /\(none\)/);
  });
});

describe('lockAllChats and listLinkedChats', () => {
  it('locks every session row on the account and no other account', async () => {
    const fake = createFakeSupabase({
      sessions: [
        { account_id: 'acc-1', channel: 'whatsapp', external_id: '1', is_locked: false, expires_at: '2999-01-01T00:00:00Z' },
        { account_id: 'acc-1', channel: 'telegram', external_id: '2', is_locked: false, expires_at: '2999-01-01T00:00:00Z' },
        { account_id: 'acc-2', channel: 'whatsapp', external_id: '3', is_locked: false, expires_at: '2999-01-01T00:00:00Z' },
      ],
    });
    await notice.lockAllChats(fake.client, 'acc-1');
    const rows = fake.db.tables.sessions;
    assert.deepEqual(rows.filter((r) => r.account_id === 'acc-1').map((r) => r.is_locked), [true, true]);
    assert.equal(rows.find((r) => r.account_id === 'acc-2').is_locked, false);
  });

  it('lists chat apps only, not platform handles', async () => {
    const fake = createFakeSupabase({
      channel_identities: [
        { account_id: 'acc-1', channel: 'whatsapp', external_id: '2348012345678', phone_e164: '2348012345678' },
        { account_id: 'acc-1', channel: 'github', external_id: '99' },
        { account_id: 'acc-2', channel: 'telegram', external_id: '777' },
      ],
    });
    const chats = await notice.listLinkedChats(fake.client, 'acc-1');
    assert.deepEqual(chats.map((c) => [c.channel, c.label]), [['whatsapp', 'ending 5678']]);
  });
});

describe('mailOwner', () => {
  it('sends to the primary email and reports success', async () => {
    const fake = createFakeSupabase({ accounts: [{ id: 'acc-1', email: 'owner@flizy.test' }] });
    const sent = [];
    const ok = await notice.mailOwner(fake.client, 'acc-1', { subject: 's', text: 't' }, async (m) => {
      sent.push(m);
      return { ok: true };
    });
    assert.equal(ok, true);
    assert.deepEqual(sent, [{ to: 'owner@flizy.test', subject: 's', text: 't' }]);
  });

  it('never throws when sending fails', async () => {
    const fake = createFakeSupabase({ accounts: [{ id: 'acc-1', email: 'owner@flizy.test' }] });
    const ok = await notice.mailOwner(fake.client, 'acc-1', { subject: 's', text: 't' }, async () => {
      throw new Error('smtp down');
    });
    assert.equal(ok, false);
  });
});

describe('publicTransferRow', () => {
  it('drops the sender identity key, account id and note from a received row', () => {
    const received = {
      id: 't1',
      account_id: 'acc-sender',
      amount_eth: '0.01',
      to_address: '0x2222222222222222222222222222222222222222',
      status: 'confirmed',
      tx_hash: '0xabc',
      created_at: '2026-10-01T00:00:00Z',
      phone: '2348012345678',
      chain_id: 91342,
      kind: 'send',
      asset: 'ETH',
      counterparty_label: 'Sender',
      note: 'rent',
    };
    assert.deepEqual(historyRow.publicTransferRow(received), {
      id: 't1',
      amount_eth: '0.01',
      to_address: '0x2222222222222222222222222222222222222222',
      status: 'confirmed',
      tx_hash: '0xabc',
      created_at: '2026-10-01T00:00:00Z',
      kind: 'send',
      asset: 'ETH',
    });
  });

  it('cannot leak a column added to the select later', () => {
    assert.deepEqual(historyRow.publicTransferRow({ id: 'x', future_secret: 'y' }), { id: 'x' });
  });
});
