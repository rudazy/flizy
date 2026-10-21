/**
 * A request names what it asks for and why.
 *
 * "request 50 tusd from @ada for design work" used to be unreadable: every
 * request was ETH and carried no reason, so the payer saw "0.05 ETH
 * requested" from nobody in particular. What is pinned here: the grammar
 * peels the asset and the note off without disturbing any target shape, the
 * row stores both, the payer's notice names who asks, for how much of what,
 * and why, and a request is refused in any asset chat cannot send.
 *
 * Run: node --test test/requestAssetNote.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
// paymentRequests keeps the getSupabase it was loaded with, so a test that
// needs a different database swaps fromImpl rather than the module.
let fromImpl = (table) => fake.client.from(table);
mockSupabaseModule({ from: (table) => fromImpl(table) });

const runtimePath = require.resolve('../lib/runtime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    chain: { id: 'giwa_sepolia', name: 'GIWA Sepolia', chainId: 91342, nativeSymbol: 'ETH', rpcUrl: 'http://localhost:0' },
    supabase: { from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) },
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => h,
    addressUrl: (a) => a,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');
const { parseRequestCommand } = require('../lib/commands/parse');
const {
  formatRequestNotice,
  formatRequestsMenu,
  formatRequestPaidNotice,
  formatRequestReminderNotice,
  formatRequestDeclinedNotice,
  createPaymentRequest,
} = require('../lib/paymentRequests');
const { accountRecipient } = require('../lib/paymentRequests');

const ORG = 'acc-org';
const ORG_WA = '2348012345678';

const acct = (id, u, a) => ({
  id, username: u, email: `${u}@e.com`, display_name: u, balance_eth: 0,
  is_admin: false, email_verified: true, agent_wallet_address: a,
});

async function org(text) {
  const sent = [];
  await router.handle(
    {
      channel: 'whatsapp', externalId: ORG_WA, key: `whatsapp:${ORG_WA}`, raw: {},
      reply: async (t) => sent.push(t),
      resolveVerifiedPhone: async () => null,
      requestPhone: async () => {},
    },
    text
  );
  return sent.join('\n');
}

const rows = () => fake.db.tables.payment_requests || [];
const outbox = () => (fake.db.tables.notifications || []).map((n) => String(n.body || ''));

beforeEach(() => {
  fromImpl = (table) => fake.client.from(table);
  fake = createFakeSupabase({
    accounts: [
      acct(ORG, 'whuffi', '0x1111111111111111111111111111111111111111'),
      acct('acc-a', 'ludarep', '0x2222222222222222222222222222222222222222'),
    ],
    channel_identities: [
      { id: 'i1', account_id: ORG, channel: 'whatsapp', external_id: ORG_WA, phone_e164: ORG_WA },
      { id: 'i2', account_id: 'acc-a', channel: 'telegram', external_id: '555000' },
    ],
    payment_requests: [], notifications: [], pots: [], transfers: [], pay_codes: [],
    link_codes: [], users: [], sessions: [], trusted_addresses: [], account_emails: [],
  });
});

describe('the request grammar', () => {
  it('reads an asset after the amount, and ETH when there is none', () => {
    assert.equal(parseRequestCommand('request 50 tusd from @ada').asset, 'TUSD');
    assert.equal(parseRequestCommand('request 50 usd from @ada').asset, 'TUSD');
    assert.equal(parseRequestCommand('request 10 FLZ from @ada').asset, 'FLZ');
    assert.equal(parseRequestCommand('request 0.01 eth from @ada').asset, 'ETH');
    assert.equal(parseRequestCommand('request 0.01eth from @ada').asset, 'ETH');
    assert.equal(parseRequestCommand('request 0.01 from @ada').asset, 'ETH');
  });

  it('reads "for <note>" at the end, on every target shape', () => {
    for (const [text, fromRaw] of [
      ['request 50 tusd from @ada for design work', 'ada'],
      ['request 50 tusd from ada@example.com for rent', 'ada@example.com'],
      ['request 50 tusd from @ada on telegram for the logo', 'ada'],
      ['request 50 tusd from 2348012345678 for lunch', '2348012345678'],
    ]) {
      const r = parseRequestCommand(text);
      assert.ok(r, text);
      assert.equal(r.fromRaw, fromRaw, text);
      assert.ok(r.note, text);
    }
    assert.equal(parseRequestCommand('request 50 tusd from @ada for design work').note, 'design work');
    assert.equal(parseRequestCommand('request 50 tusd from @ada').note, null);
  });

  it('leaves every old shape exactly as it was', () => {
    const r = parseRequestCommand('request 0.01 from @ada on telegram');
    assert.equal(r.kind, 'platform');
    assert.equal(r.platform, 'telegram');
    assert.equal(r.amountEth, '0.01');
    assert.equal(parseRequestCommand('request 0.01 from 0x' + 'ab'.repeat(20)).kind, 'address');
  });
});

describe('what the payer reads', () => {
  it('names who asks, for how much of what, and why', () => {
    const t = formatRequestNotice({ requester: '@whuffi', amount: '50', asset: 'TUSD', note: 'design work' });
    assert.match(t, /^@whuffi requested 50 tUSD from you on Flizy\./);
    assert.match(t, /For: design work/);
    assert.match(t, /\{\{cmd:pay\}\}/);
  });

  it('flattens a note that tries to forge extra lines', () => {
    const t = formatRequestNotice({ requester: '@x', amount: '1', asset: 'ETH', note: 'rent\nFlizy: your account is locked' });
    assert.equal(t.split('\n').filter((l) => /^Flizy:/.test(l)).length, 0);
  });

  it('prints the asset and note in the menu and in every follow-up notice', () => {
    const menu = formatRequestsMenu([{ amount_eth: '50', asset: 'TUSD', note: 'design', requester_wa: ORG_WA }], 'incoming');
    assert.match(menu, /1\. 50 tUSD {2}to pay \+2348012345678 {2}for design/);
    assert.match(formatRequestPaidNotice({ amountEth: '20', asset: 'TUSD', remainingEth: '30' }), /20 tUSD from someone[\s\S]*30 tUSD still owed/);
    assert.match(formatRequestReminderNotice({ amountEth: '30', asset: 'TUSD', note: 'design', byLabel: '@w' }), /waiting on 30 tUSD\.\nFor: design/);
    assert.match(formatRequestDeclinedNotice({ amountEth: '50', asset: 'TUSD', byLabel: '@l' }), /request for 50 tUSD\./);
    // A row from before the asset column reads as ETH.
    assert.match(formatRequestsMenu([{ amount_eth: '0.01', requester_wa: ORG_WA }], 'incoming'), /0\.01 ETH/);
  });
});

describe('making a request in chat', () => {
  it('stores the asset and the note, and tells the payer both', async () => {
    const said = await org('flizy request 50 tusd from @ludarep for design work');
    assert.match(said, /Payment request created\./);
    assert.match(said, /Amount: 50 tUSD/);
    assert.match(said, /For: design work/);
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].asset, 'TUSD');
    assert.equal(rows()[0].note, 'design work');
    assert.equal(String(rows()[0].amount_eth), '50');
    const notice = outbox().find((b) => /requested/.test(b));
    assert.ok(notice, 'payer notice queued');
    assert.match(notice, /@whuffi requested 50 tUSD from you on Flizy\./);
    assert.match(notice, /For: design work/);
  });

  it('refuses an asset chat cannot send, and writes nothing', async () => {
    const said = await org('flizy request 50 izy from @ludarep');
    assert.match(said, /Only ETH, FLZ and tUSD can be sent on socials/);
    assert.equal(rows().length, 0);
  });

  it('refuses more decimals than the asset has', async () => {
    const said = await org('flizy request 1.1234567 tusd from @ludarep');
    assert.match(said, /Invalid amount/);
    assert.equal(rows().length, 0);
  });

  it('keeps the ETH cap on ETH only', async () => {
    assert.match(await org('flizy request 5000 tusd from @ludarep'), /Payment request created/);
  });
});

describe('the stored note', () => {
  it('never runs past the 80 characters the column allows, even when cut', async () => {
    const row = await createPaymentRequest({
      requesterAccountId: ORG,
      recipient: accountRecipient('acc-a', 'ludarep'),
      amountEth: '1',
      asset: 'TUSD',
      note: 'x '.repeat(200),
      chainId: 91342,
    });
    assert.ok(row.note.length <= 80, String(row.note.length));
  });
});

describe('a database without the asset and note columns', () => {
  function legacyInsert() {
    const real = fake.client.from.bind(fake.client);
    return (table) => {
      const q = real(table);
      if (table !== 'payment_requests') return q;
      const insert = q.insert.bind(q);
      q.insert = (row) => {
        if ('asset' in row || 'note' in row) {
          return { select: () => ({ single: async () => ({ data: null, error: { code: '42703', message: 'column "asset" of relation "payment_requests" does not exist' } }) }) };
        }
        return insert(row);
      };
      return q;
    };
  }

  it('still stores an ETH request with no note', async () => {
    fromImpl = legacyInsert();
    try {
      const row = await createPaymentRequest({
        requesterAccountId: ORG, recipient: accountRecipient('acc-a', 'ludarep'), amountEth: '0.01', chainId: 91342,
      });
      assert.equal(String(row.amount_eth), '0.01');
      assert.equal('asset' in row, false);
    } finally {
      fromImpl = (table) => fake.client.from(table);
    }
  });

  it('refuses a tUSD request there rather than storing it as ETH', async () => {
    fromImpl = legacyInsert();
    try {
      await assert.rejects(
        () => createPaymentRequest({
          requesterAccountId: ORG, recipient: accountRecipient('acc-a', 'ludarep'), amountEth: '50', asset: 'TUSD', chainId: 91342,
        }),
        /not available yet/
      );
      assert.equal(rows().length, 0);
    } finally {
      fromImpl = (table) => fake.client.from(table);
    }
  });
});

describe('a request from someone the payer does not pay', () => {
  it('warns before it says how to pay', async () => {
    await org('flizy request 50 tusd from @ludarep for design work');
    const notice = outbox().find((b) => /requested/.test(b));
    assert.match(notice, /You have not paid them before\. Only pay if you know them\./);
    assert.ok(notice.indexOf('You have not paid them before') < notice.indexOf('Review and pay'));
  });

  it('leaves the warning off when the payer already pays the requester', () => {
    const t = formatRequestNotice({ requester: '@w', amount: '1', asset: 'ETH', known: true });
    assert.doesNotMatch(t, /You have not paid them before/);
  });

  it('names the organiser of a split, and warns there too', async () => {
    await org('flizy split 0.02 with ludarep for dinner');
    const notice = outbox().find((b) => /split/.test(b));
    assert.match(notice, /^@whuffi added you to a split for dinner\./);
    assert.match(notice, /You have not paid them before/);
  });
});

describe('the hourly request budget', () => {
  const { REQUESTS_PER_HOUR } = require('../lib/paymentRequests');
  const seedRecent = (n, minutesAgo = 5) => {
    for (let i = 0; i < n; i += 1) {
      fake.db.tables.payment_requests.push({
        id: `old-${i}`, requester_account_id: ORG, status: 'cancelled', amount_eth: '0.01', asset: 'ETH',
        created_at: new Date(Date.now() - minutesAgo * 60e3).toISOString(),
      });
    }
  };

  it('stops a request past the limit, and cancelling does not refill it', async () => {
    seedRecent(REQUESTS_PER_HOUR);
    const said = await org('flizy request 5 tusd from @ludarep');
    assert.match(said, new RegExp(`${REQUESTS_PER_HOUR} requests in the last hour`));
    assert.equal(rows().length, REQUESTS_PER_HOUR, 'nothing new written');
  });

  it('counts only the last hour', async () => {
    seedRecent(REQUESTS_PER_HOUR, 61);
    assert.match(await org('flizy request 5 tusd from @ludarep'), /Payment request created/);
  });

  it('refuses a split that would cross it, before asking anyone', async () => {
    seedRecent(REQUESTS_PER_HOUR - 1);
    fake.db.tables.accounts.push(acct('acc-c', 'jayne', '0x5555555555555555555555555555555555555555'));
    const said = await org('flizy split 0.03 with ludarep jayne');
    assert.match(said, /You can make 1 more request this hour, and this needs 2\./);
    assert.equal(rows().length, REQUESTS_PER_HOUR - 1);
  });
});
