/**
 * Telling a claim's recipient who is not on Flizy (Slice 2): the share message
 * and the Telegram start link (lib/claimShare.js), the notification adapters
 * (lib/claimNotify.js), the Telegram start handler and its pin, the private
 * @username warning and cap, and the site share card, claim page and routes.
 *
 * Covers: the message says testnet and carries the link; only a real token
 * makes a start link; no channel reaches a non-user without a sender and its
 * setting, and WhatsApp, Telegram, Discord, GitHub and X cannot; a private
 * @username claim is pinned once to the first matching Telegram id and nobody
 * else; a refusal never says who the payment was for; the signed-out claim page
 * reveals only sender, amount, testnet and expiry.
 *
 * Run: node --test test/claimShareLink.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });
const runtimePath = require.resolve('../lib/runtime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    chain: { id: 'giwa_sepolia', name: 'GIWA Sepolia', chainId: 91342, nativeSymbol: 'ETH', rpcUrl: 'http://localhost:0' },
    supabase: { from: (table) => fake.client.from(table), rpc: (name, args) => fake.client.rpc(name, args) },
    provider: { getBalance: async () => ethers.parseEther('5') },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const S = require('../lib/claimShare');
const N = require('../lib/claimNotify');
const handlers = require('../lib/handlers/claims');
const { normalizeInput } = require('../lib/router');
const { parseClaimStartCommand, isFlizyCommandBody } = require('../lib/commands/parse');
const { formatClaimPlanPreview } = require('../lib/engine/plan');

const TOKEN = 'ab'.repeat(16);
const SENDER = '11111111-1111-4111-8111-111111111111';
const quiet = { warn() {} };

describe('the share message and the Telegram start link', () => {
  it('says testnet, names what was sent, and carries the link', () => {
    assert.equal(
      S.claimShareMessage({ amount: '0.01', asset: 'ETH', url: 'https://flizy.app/claim/t' }),
      'I sent you 0.01 ETH on Flizy (testnet). Claim it here: https://flizy.app/claim/t'
    );
    const tg = S.claimShareMessage({ amount: '5', asset: 'TUSD', url: 'https://flizy.app/claim/t', telegramUrl: 'https://t.me/FlizyBot?start=claim_x' });
    assert.match(tg, /^I sent you 5 tUSD on Flizy \(testnet\)\. Claim it here: https:\/\/flizy\.app\/claim\/t\nOr open it in Telegram: https:\/\/t\.me\/FlizyBot\?start=claim_x$/);
    assert.doesNotMatch(tg, /[^\x00-\x7F]/);
  });

  it('a start link only for a real token and a real bot name; the payload reads back', () => {
    assert.equal(S.telegramStartUrl('@FlizyBot', TOKEN), `https://t.me/FlizyBot?start=claim_${TOKEN}`);
    assert.equal(S.telegramStartUrl('FlizyBot', 'not-a-token'), null);
    assert.equal(S.telegramStartUrl('', TOKEN), null);
    assert.equal(S.telegramStartUrl('bad name!', TOKEN), null);
    assert.equal(S.tokenFromStartPayload(`claim_${TOKEN.toUpperCase()}`), TOKEN);
    assert.equal(S.tokenFromStartPayload('claim_123'), null);
    assert.ok(`claim_${TOKEN}`.length <= 64, 'within Telegram start payload limit');
  });

  it('Telegram /start claim_<token> opens the claim; a checkout and a link code still work', () => {
    const ctx = { channel: 'telegram', key: 'telegram:1' };
    assert.deepEqual(normalizeInput(ctx, `/start claim_${TOKEN}`), { text: `claim start ${TOKEN}`, hadPrefix: true });
    assert.deepEqual(parseClaimStartCommand(`claim start ${TOKEN}`), { token: TOKEN });
    assert.equal(isFlizyCommandBody(`claim start ${TOKEN}`), true);
    assert.equal(normalizeInput(ctx, '/start ABC123XY').text, 'link ABC123XY');
  });
});

describe('the notification adapters', () => {
  it('map each recipient to its channel', () => {
    assert.equal(N.recipientChannel({ kind: 'email', email: 'a@b.co' }), 'email');
    assert.equal(N.recipientChannel({ kind: 'phone', phone: '234801' }), 'whatsapp');
    for (const ch of ['telegram', 'discord', 'github', 'x']) assert.equal(N.recipientChannel({ kind: 'platform', channel: ch }), ch);
    assert.equal(N.recipientChannel({ kind: 'platform', channel: 'myspace' }), null);
  });

  it('Telegram, Discord, GitHub and X can never take a sender; WhatsApp and email reach nobody without a sender and their setting', () => {
    for (const ch of ['telegram', 'discord', 'github', 'x', 'share_link']) {
      assert.throws(() => N.registerNoticeSender(ch, async () => true), /cannot carry claim notices/, ch);
      assert.equal(N.canReach(ch, { CLAIM_NOTIFY_EMAIL: 'true', CLAIM_NOTIFY_WHATSAPP: 'true' }), false, ch);
    }
    assert.equal(N.canReach('whatsapp', { CLAIM_NOTIFY_WHATSAPP: 'true' }), false, 'no WhatsApp sender exists');
    assert.equal(N.canReach('email', { CLAIM_NOTIFY_EMAIL: 'true' }), false, 'no email sender yet');
  });

  it('a registered sender with its setting on reaches them, and notified is recorded only when accepted', async () => {
    const db = createFakeSupabase({ claim_events: [] });
    const results = [true, false];
    N.registerNoticeSender('email', async () => results.shift());
    const claim = { id: 'c1' };
    const email = { kind: 'email', email: 'a@b.co' };
    assert.equal(await N.noticeNonUser({ supabase: db.client, claim, recipient: email, env: { CLAIM_NOTIFY_EMAIL: 'false' }, log: quiet }), null, 'setting off');
    assert.equal(await N.noticeNonUser({ supabase: db.client, claim, recipient: email, env: { CLAIM_NOTIFY_EMAIL: 'true' }, log: quiet }), 'email');
    assert.equal(await N.noticeNonUser({ supabase: db.client, claim, recipient: email, env: { CLAIM_NOTIFY_EMAIL: 'true' }, log: quiet }), null, 'not accepted');
    N.registerNoticeSender('email', async () => {
      throw new Error('smtp down');
    });
    assert.equal(await N.noticeNonUser({ supabase: db.client, claim, recipient: email, env: { CLAIM_NOTIFY_EMAIL: 'true' }, log: quiet }), null, 'a failing sender never throws');
    assert.deepEqual(db.db.tables.claim_events.map((e) => [e.event, e.channel]), [['notified', 'email']]);
  });
});

describe('a claim opened from its Telegram start link', () => {
  let sent;
  const tgCtx = (id, handle) => ({
    channel: 'telegram',
    externalId: id,
    key: `telegram:${id}`,
    displayHandle: handle,
    raw: {},
    reply: async (text) => sent.push(text),
  });
  const claim = (over) => ({
    id: 'cl1',
    claim_token: TOKEN,
    from_account_id: SENDER,
    status: 'pending',
    to_channel: 'telegram',
    to_external_id: 'tguser:ada_rich',
    to_display_handle: 'Ada_Rich',
    amount_eth: '0.01',
    asset: 'ETH',
    ...over,
  });
  const seed = (c) => {
    fake = createFakeSupabase({
      claims: [c],
      claim_events: [],
      accounts: [{ id: SENDER, username: 'kemi', email: 'kemi@example.com' }],
      channel_identities: [],
    });
    sent = [];
  };
  const kinds = () => fake.db.tables.claim_events.map((e) => e.event);

  beforeEach(() => seed(claim()));

  it('a private @username claim is pinned once to the first Telegram id that holds that @username', async () => {
    await handlers.handleClaimStart(tgCtx('777001', 'ADA_rich'), null, TOKEN);
    assert.equal(fake.db.tables.claims[0].to_external_id, '777001');
    assert.deepEqual(kinds(), ['link_opened', 'recipient_pinned']);
    assert.match(sent[0], /^@kemi sent you 0\.01 ETH on Flizy \(testnet\)\.\n\nIt is for you\. Create a Flizy account and link this Telegram to receive it:/);

    // Someone else who later takes the same @username is refused: it is tied to the id now.
    sent = [];
    await handlers.handleClaimStart(tgCtx('888002', 'ada_rich'), null, TOKEN);
    assert.equal(fake.db.tables.claims[0].to_external_id, '777001');
    assert.match(sent[0], /This payment cannot be received with this Telegram account\./);
  });

  it('two people pinning at once: only the first wins, the second changes nothing', async () => {
    // Between this open reading the claim and pinning it, someone else pins it.
    const from = fake.client.from.bind(fake.client);
    fake.client.from = (table) => {
      const q = from(table);
      if (table !== 'claims') return q;
      const update = q.update.bind(q);
      q.update = (patch) => {
        // A new row, as a write from elsewhere would be: the fake hands out its
        // stored objects, so changing this one in place would change the copy
        // the handler already read.
        fake.db.tables.claims[0] = { ...fake.db.tables.claims[0], to_external_id: '111111' };
        return update(patch);
      };
      return q;
    };
    await handlers.handleClaimStart(tgCtx('777001', 'ada_rich'), null, TOKEN);
    assert.equal(fake.db.tables.claims[0].to_external_id, '111111');
    assert.ok(!kinds().includes('recipient_pinned'));
    assert.deepEqual(sent, ['Could not open that payment. Try again shortly.']);
  });

  it('a different @username, a different id, or no @username is refused without saying who it was for', async () => {
    await handlers.handleClaimStart(tgCtx('777001', 'not_ada'), null, TOKEN);
    await handlers.handleClaimStart(tgCtx('777001', null), null, TOKEN);
    assert.equal(fake.db.tables.claims[0].to_external_id, 'tguser:ada_rich');
    seed(claim({ to_external_id: '123456', to_display_handle: 'bob' }));
    await handlers.handleClaimStart(tgCtx('999', 'bob'), null, TOKEN);
    for (const text of sent) {
      assert.match(text, /cannot be received with this Telegram account/);
      assert.doesNotMatch(text, /ada|bob|123456/i);
    }
    assert.ok(!kinds().includes('recipient_pinned'));
  });

  it('a claim for an email or a phone points to the claim page and never names the recipient', async () => {
    seed(claim({ to_channel: null, to_external_id: null, to_display_handle: null, to_email: 'secret@example.com' }));
    await handlers.handleClaimStart(tgCtx('777001', 'ada_rich'), null, TOKEN);
    assert.match(sent[0], new RegExp(`See how to receive it: .*/claim/${TOKEN}$`));
    assert.doesNotMatch(sent[0], /secret/);
  });

  it('the sender opening their own link is told so, and it is not counted as opened; a spent or unknown link says so', async () => {
    await handlers.handleClaimStart(tgCtx('555', 'kemi'), { id: SENDER, email: 'kemi@example.com' }, TOKEN);
    assert.match(sent[0], /^This is a payment you sent\./);
    assert.deepEqual(kinds(), []);
    seed(claim({ status: 'claimed' }));
    await handlers.handleClaimStart(tgCtx('777001', 'ada_rich'), null, TOKEN);
    await handlers.handleClaimStart(tgCtx('777001', 'ada_rich'), null, 'cd'.repeat(16));
    assert.deepEqual(sent, ['This payment is no longer waiting to be claimed.', 'That claim link is not valid.']);
  });
});

describe('a private Telegram @username at send time', () => {
  it('the preview carries the warning, with the handle', () => {
    const plan = {
      createdAt: 0,
      expiresAt: 5 * 60000,
      input: { recipientKind: 'platform', recipientChannel: 'telegram', amount: '0.01', asset: 'ETH', recipient: '@ada_rich (Telegram)' },
      route: { recipient: { pendingUsername: true, displayHandle: 'ada_rich', externalId: 'tguser:ada_rich' }, fromAddress: '0x' + '1'.repeat(40), chainName: 'GIWA Sepolia' },
    };
    assert.match(formatClaimPlanPreview(plan), /Private Telegram user: whoever holds @ada_rich when they claim can receive it\. Only send to handles you're sure of\./);
  });

  it('capped at CLAIM_TGUSER_MAX_USD ($20 by default), checked before the hold; an NFT or an unpriced amount is refused', () => {
    const src = read('lib/handlers/claims.js');
    assert.match(src, /const TGUSER_DEFAULT_MAX_USD = '20';/);
    const pending = src.indexOf('if (profile.pendingUsername || (ch === CHANNELS.TELEGRAM && !profile.id)) {');
    assert.ok(pending > 0 && src.indexOf('const refused = await tguserCapRefusal(amountEth, sendAsset, listedOverride);', pending) - pending < 200);
    const fn = src.slice(src.indexOf('async function tguserCapRefusal'));
    assert.match(fn, /if \(listed\.nftTokenId\) return tooMuch\(capText\);/);
    assert.match(fn, /return usdMicro > capMicro \? tooMuch\(capText\) : null;/);
    assert.match(fn, /console\.warn\('tguser cap price:', publicErrorMessage\(err\)\);\s+return tooMuch\(capText\);/);
  });
});

describe('chat and the site', () => {
  it('after a hold for someone not on Flizy, chat tries their channel, then sends the link to forward', () => {
    const router = read('lib/router.js');
    assert.match(router, /!notified && result\.claim\s+\? await noticeNonUser\(\{ supabase, claim: result\.claim, recipient: recipient \|\| \{ kind: 'phone', phone: toWaHint \} \}\)/);
    assert.match(router, /if \(!notified && result\.claim\) \{\s+await reply\(\s+ctx,\s+claimShareMessage\(/);
    assert.match(router, /await recordClaimEvent\(supabase, result\.claim\.id, 'link_shared', \{ channel: 'share_link' \}\);/);
    assert.match(read('lib/reconcile.js'), /if \(!told && claimUrl\) \{/);
  });

  it('the signed-out claim page data: sender, amount, testnet and expiry, nothing about the recipient', () => {
    const route = read('web/app/api/claim/[token]/route.ts');
    const base = route.slice(route.indexOf('const body: Record<string, unknown> = {'), route.indexOf('if (viewerId) {'));
    for (const key of ['amount_eth', 'asset', 'nft_token_id', 'status', 'sender', 'testnet: true', 'expires_at']) assert.ok(base.includes(key), key);
    assert.doesNotMatch(base, /recipient|sent_to|to_wa_hint|to_email|carries_invite|can_claim/);
    const page = read('web/app/claim/[token]/page.tsx');
    // The page no longer says it (Ludarep's design); the email and the share message still do.
    assert.doesNotMatch(page, /Testnet: these are test funds/);
    assert.match(page, /Create a Flizy account/);
    assert.match(page, /This payment was sent to \{data\.sent_to \|\| 'another identity'\}\. Add and verify it on your account to claim/);
  });

  it('the share card and its record: the sender only, their pending claims, capped', () => {
    const route = read('web/app/api/claim/shared/route.ts');
    assert.ok(route.indexOf('rejectIfCrossOrigin(req)') < route.indexOf('getAccountIdFromCookie()'));
    assert.match(route, /if \(!claim \|\| claim\.from_account_id !== accountId\) return NextResponse\.json\(\{ error: 'Not found' \}, \{ status: 404 \}\);/);
    assert.match(route, /if \(\(count \|\| 0\) >= MAX_SHARES\)/);
    assert.match(read('web/app/api/history/route.ts'), /share: status === 'pending' \? claimShareFor\(row\) : null,/);
    const card = read('web/components/ShareClaimCard.tsx');
    assert.match(card, /https:\/\/wa\.me\/\?text=\$\{encodeURIComponent\(share\.text\)\}/);
    assert.match(card, /navigator\.share\(\{ text: share\.text \}\)/);
  });
});
