/**
 * Paying a Flizy Pay API checkout in chat: the checkout page's chat links, the
 * bot reading them, and the payment the bot makes (lib/api/checkoutPay.js).
 *
 * Run: node --test test/checkoutChat.test.js
 */

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { parseCheckoutCommand, checkoutFromStartPayload, parseLinkCommand, isFlizyCommandBody } = require('../lib/commands/parse');
const CP = require('../lib/api/checkoutPay');
const { resolveListedSendAsset } = require('../lib/dex');
const { generateLinkCode } = require('../lib/linkCode');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ID = '0d2b6c1a-1111-4222-8333-944445555666';

describe('chat reads a checkout link', () => {
  it('checkout <id> takes the UUID and nothing looser', () => {
    assert.deepEqual(parseCheckoutCommand(`checkout ${ID.toUpperCase()}`), { id: ID });
    assert.equal(parseCheckoutCommand('checkout 123'), null);
    assert.equal(parseCheckoutCommand(`checkout ${ID} now`), null);
    assert.equal(parseCheckoutCommand(`checkout ${ID.replace(/-/g, '')}`), null);
    assert.equal(isFlizyCommandBody(`checkout ${ID}`), true);
  });

  it('a Telegram start payload co_<32 hex> is the checkout; anything else is not', () => {
    assert.equal(checkoutFromStartPayload(`co_${ID.replace(/-/g, '')}`), ID);
    assert.equal(checkoutFromStartPayload(`co_${ID.replace(/-/g, '').toUpperCase()}`), ID);
    assert.equal(checkoutFromStartPayload(`co_${ID.replace(/-/g, '').slice(1)}`), null);
    assert.equal(checkoutFromStartPayload(''), null);
    assert.equal(checkoutFromStartPayload(undefined), null);
  });

  it('a link code can never be read as a checkout, nor a checkout payload as a link code', () => {
    for (let i = 0; i < 50; i += 1) assert.equal(checkoutFromStartPayload(generateLinkCode()), null);
    assert.equal(parseLinkCommand(`link co_${ID.replace(/-/g, '')}`), null);
  });

  it('the router maps /start co_... to checkout before the link-code fallback', () => {
    const src = read('lib/router.js');
    assert.match(src, /const checkoutId = checkoutFromStartPayload\(start\[1\]\);\s*if \(checkoutId\) return \{ text: `checkout \$\{checkoutId\}`, hadPrefix: true \};\s*return \{ text: start\[1\] \? `link \$\{start\[1\]\}`/);
    assert.match(src, /const checkoutCmd = parseCheckoutCommand\(text\);\s*if \(checkoutCmd\) \{\s*await handleCheckout\(ctx, user, account, checkoutCmd\.id\);/);
  });
});

describe('the checkout page links', () => {
  const KEYS = ['TELEGRAM_BOT_USERNAME', 'BOT_WHATSAPP_NUMBER', 'NEXT_PUBLIC_BOT_WHATSAPP_NUMBER', 'NEXT_PUBLIC_SHOW_BOT_NUMBER'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let links;
  before(async () => {
    links = (await import('../web/lib/checkoutChat.ts')).checkoutChatLinks;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const set = (env) => {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
  };

  it('Telegram carries co_ and the 32 hex digits, which the bot reads back as the same checkout', () => {
    set({ TELEGRAM_BOT_USERNAME: '@FlizyBot' });
    const tg = links(ID).telegram;
    assert.equal(tg, `https://t.me/FlizyBot?start=co_${ID.replace(/-/g, '')}`);
    assert.equal(checkoutFromStartPayload(new URL(tg).searchParams.get('start')), ID);
  });

  it('WhatsApp only where the number may be public, prefilled with the command the bot parses', () => {
    set({ BOT_WHATSAPP_NUMBER: '+1 555 0100' });
    assert.equal(links(ID).whatsapp, null);
    set({ BOT_WHATSAPP_NUMBER: '+1 555 0100', NEXT_PUBLIC_SHOW_BOT_NUMBER: 'true' });
    const wa = new URL(links(ID).whatsapp);
    assert.equal(wa.host, 'wa.me');
    assert.equal(wa.pathname, '/15550100');
    assert.deepEqual(parseCheckoutCommand(wa.searchParams.get('text').replace(/^flizy\s+/, '')), { id: ID });
  });

  it('no links without the bots, or for an id that is not a UUID', () => {
    set({});
    assert.deepEqual(links(ID), { telegram: null, whatsapp: null });
    set({ TELEGRAM_BOT_USERNAME: 'FlizyBot', BOT_WHATSAPP_NUMBER: '15550100', NEXT_PUBLIC_SHOW_BOT_NUMBER: 'true' });
    assert.deepEqual(links('../../x'), { telegram: null, whatsapp: null });
  });

  it('the page offers chat only while the checkout can be paid', () => {
    const page = read('web/app/checkout/[id]/page.tsx');
    assert.match(page, /const chat = payable \? checkoutChatLinks\(view\.id\) : \{ telegram: null, whatsapp: null \};/);
    const branch = page.slice(page.indexOf(') : payable ? ('), page.indexOf(') : open ? ('));
    assert.match(branch, /Pay in Telegram/);
    assert.match(branch, /Pay in WhatsApp/);
  });
});

describe('the checkout chat sees and pays', () => {
  const chainKey = 'giwa_sepolia';
  const payee = ethers.getAddress('0x' + '7'.repeat(40));
  const future = () => new Date(Date.now() + 3600e3).toISOString();
  function db({ state = 'accepted', expires = future(), enabled = true, received = '0', asset = 'TUSD', amount = '25000000' } = {}) {
    return createFakeSupabase({
      api_transactions: [{ id: ID, kind: 'payment', platform_id: 'plat-1', state, amount, asset, received_units: received, invoice_id: '0x' + 'ab'.repeat(32), expires_at: expires }],
      api_platforms: [{ id: 'plat-1', account_id: 'acct-platform', display_name: 'Shop\u202e One', wallet_address: payee, enabled }],
    }).client;
  }

  it('loads what chat shows: the name made safe, what is due, the token', async () => {
    const v = await CP.loadCheckout(db({ received: '10000000' }), ID, chainKey);
    assert.equal(v.platformName.includes('\u202e'), false);
    assert.equal(v.dueUnits, 15000000n);
    assert.equal(CP.plainUnits(v.dueUnits, v.decimals), '15');
    assert.equal(v.assetLabel, 'tUSD');
    assert.equal(v.token, ethers.getAddress(resolveListedSendAsset('TUSD', chainKey).tokenAddress));
    assert.equal((await CP.loadCheckout(db({ asset: 'ETH', amount: '10000000000000000' }), ID, chainKey)).token, null);
    assert.equal(await CP.loadCheckout(db(), 'not-a-uuid', chainKey), null);
  });

  it('refuses what cannot be paid: closed, expired, paused, own, already paid', async () => {
    assert.equal(CP.refusal(null, 'a'), 'That checkout was not found.');
    assert.equal(CP.refusal(await CP.loadCheckout(db({ state: 'confirmed' }), ID, chainKey), 'a'), 'This checkout is no longer open.');
    assert.equal(CP.refusal(await CP.loadCheckout(db({ expires: new Date(Date.now() - 1000).toISOString() }), ID, chainKey), 'a'), 'This checkout is no longer open.');
    assert.equal(CP.refusal(await CP.loadCheckout(db({ enabled: false }), ID, chainKey), 'a'), 'This checkout is no longer open.');
    assert.equal(CP.refusal(await CP.loadCheckout(db(), ID, chainKey), 'acct-platform'), 'You cannot pay your own checkout.');
    assert.equal(CP.refusal(await CP.loadCheckout(db({ received: '25000000' }), ID, chainKey), 'a'), 'This checkout is already paid.');
    assert.equal(CP.refusal(await CP.loadCheckout(db(), ID, chainKey), 'a'), null);
  });

  it('reads stored amounts as base units, rounding up', () => {
    assert.equal(CP.textToUnits('15.000000000000000000', 6), 15000000n);
    assert.equal(CP.textToUnits('0.0000015', 6), 2n);
    assert.equal(CP.textToUnits('7', 18), 7n * 10n ** 18n);
  });

  it('the allowance left is what the permission reports, less checkout payments it cannot see', async () => {
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const dayAgo = new Date(Date.now() - 25 * 3600e3).toISOString();
    const transfers = [
      { account_id: 'payer', note: 'Checkout', asset: 'TUSD', status: 'confirmed', amount_eth: '20.000000000000000000', created_at: hourAgo },
      { account_id: 'payer', note: 'Checkout', asset: 'TUSD', status: 'submitted', amount_eth: '15', created_at: hourAgo },
      // Not counted: failed, older than a day, another asset, another note, another account.
      { account_id: 'payer', note: 'Checkout', asset: 'TUSD', status: 'failed', amount_eth: '9', created_at: hourAgo },
      { account_id: 'payer', note: 'Checkout', asset: 'TUSD', status: 'confirmed', amount_eth: '9', created_at: dayAgo },
      { account_id: 'payer', note: 'Checkout', asset: 'ETH', status: 'confirmed', amount_eth: '9', created_at: hourAgo },
      { account_id: 'payer', note: null, asset: 'TUSD', status: 'confirmed', amount_eth: '9', created_at: hourAgo },
      { account_id: 'other', note: 'Checkout', asset: 'TUSD', status: 'confirmed', amount_eth: '9', created_at: hourAgo },
    ];
    const supabase = createFakeSupabase({ transfers }).client;
    assert.equal(await CP.ownerKeyUnitsToday(supabase, 'payer', 'TUSD', 6), 35000000n);
    const ask = (route, available, amount) =>
      CP.overPasskeyAllowance({ supabase, provider: null, accountId: 'payer', wallet: payee, asset: 'TUSD', amount, planSend: async () => ({ route, available }) });
    // The permission says 50 left; 35 went to checkouts it never saw: 15 is left.
    assert.deepEqual(await ask('permission', 50000000n, 15000000n), { over: false });
    assert.deepEqual(await ask('permission', 50000000n, 15000001n), { over: true, available: 15000000n });
    assert.deepEqual(await ask('over_cap', 10000000n, 15000000n), { over: true, available: 0n });
    // No permission (not a secured account): no allowance applies.
    assert.deepEqual(await ask('owner', undefined, 10n ** 12n), { over: false });
  });

  it('over the passkey allowance points at the checkout page, never sends', () => {
    const copy = CP.overAllowanceCopy({ id: ID, decimals: 6, assetLabel: 'tUSD' }, 4500000n);
    assert.match(copy, /4\.5 tUSD left/);
    assert.match(copy, /so it was not sent/);
    assert.ok(copy.endsWith(`/checkout/${ID}`));
  });
});

describe('payCheckout keeps the controls of the site payment', () => {
  const src = read('lib/api/checkoutPay.js');
  const body = src.slice(src.indexOf('async function payCheckout('));
  const at = (needle) => {
    const i = body.indexOf(needle);
    assert.ok(i >= 0, needle);
    return i;
  };

  it('reads the checkout again, then the allowance, the fences and the History row, then pays', () => {
    const order = [
      'const view = await loadCheckout(supabase, checkoutId, chain.id);',
      'const refused = refusal(view, accountId);',
      'cap = await overPasskeyAllowance(',
      "if (cap.over) return { ok: false, submitted: false, error: overAllowanceCopy(view, cap.available) };",
      'await assertSpendable(supabase, accountId, { asset: \'ETH\', holding: ethBal, amount: due,',
      'await checkDailySendLimitNow(accountId, ethers.formatEther(due));',
      'let transferRow = await insertTransfer(rowPayload);',
      "ERC20.encodeFunctionData('approve', [RECEIVER, due])",
      "RECEIVER_IFACE.encodeFunctionData('payToken', [view.invoiceId, view.token, view.payee, due])",
      'const sent = await executeGatorCall({',
      'await watcher.recordLog(entry, payments);',
    ];
    let last = -1;
    for (const needle of order) {
      const i = at(needle);
      assert.ok(i > last, `out of order: ${needle}`);
      last = i;
    }
  });

  it('an allowance that cannot be read sends nothing', () => {
    assert.match(body, /catch \(err\) \{\s*console\.error\('checkout passkey allowance:', publicErrorMessage\(err\)\);\s*return \{ ok: false, submitted: false, error: 'Could not check your passkey allowance right now, so nothing was sent\./);
  });

  it('records the hash before broadcast, and never calls an unknown outcome failed', () => {
    assert.match(body, /onBroadcast: async \(hash\) => \{\s*transferRow = \{ id: await recordBroadcast\(transferRow\?\.id, hash, rowPayload\) \};\s*payBroadcast = true;/);
    assert.match(body, /if \(outcomeUnknown\(err\) && payBroadcast\) \{\s*return \{ ok: false, submitted: true/);
    // The EOA path: only a mined revert is final.
    assert.match(body, /if \(waitErr\?\.code === 'CALL_EXCEPTION'\) throw waitErr;\s*throw new GatorExecError\('OUTCOME_UNKNOWN'/);
  });

  it('a payment that moved is never answered as a failure because recording it failed', () => {
    assert.match(body, /try \{\s*const watcher = makePaymentWatcher[\s\S]*?\} catch \(err\) \{\s*console\.warn\('checkout record \(the watcher settles it\):'/);
  });
});

describe('the chat plan', () => {
  const src = read('lib/router.js');

  it('is tiered on the payee and what is due, like the site', () => {
    assert.match(src, /if \(plan\.intent === 'CHECKOUT'\) \{\s*const native = plan\.route\.asset === 'ETH';\s*return sendTier\(supabase, accountId, plan\.route\.payee, native, native \? BigInt\(plan\.route\.dueUnits\) : 0n\);/);
  });

  it('shows its lines on the approval page, made safe', () => {
    assert.match(src, /if \(plan\.intent === 'CHECKOUT'\) \{\s*return \{ title: 'Approve a payment', lines: \(plan\.input\?\.lines \|\| \[\]\)\.map\(\(line\) => displaySafeLabel\(line, 120\)\) \};/);
  });

  it('pays through payCheckout under the confirm lock, as the account that made it', () => {
    const confirm = src.slice(src.indexOf('async function handleConfirm('), src.indexOf("if (plan.intent === 'SWAP') {"));
    assert.ok(confirm.indexOf("tryAccountTxLock(supabase, actorId, 'chat')") < confirm.indexOf("if (plan.intent === 'CHECKOUT')"));
    assert.match(confirm, /checkoutPay\.payCheckout\(\{\s*supabase,\s*provider,\s*chain,\s*accountId: plan\.actor\.accountId,\s*checkoutId: plan\.route\.checkoutId,/);
  });

  it('the preview checks the link, the session and the allowance before offering CONFIRM', () => {
    const fn = src.slice(src.indexOf('async function handleCheckout('), src.indexOf('async function askTradeDirection('));
    const order = ['requireLinkedSite(ctx, account)', 'checkoutPay.refusal(view, siteAcc.id)', 'sessionGate(actor)', 'checkoutPay.overPasskeyAllowance(', 'safePlanTier(plan, siteAcc.id)', 'pendingSends.set('];
    let last = -1;
    for (const needle of order) {
      const i = fn.indexOf(needle);
      assert.ok(i > last, `out of order: ${needle}`);
      last = i;
    }
  });
});
