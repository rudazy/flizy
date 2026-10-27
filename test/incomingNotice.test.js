/**
 * A payment that reaches an account is stored for the bell and emailed once.
 * The sentence is built by the site. A caller cannot choose the link or put a
 * command marker in the mail.
 *
 * Run: node --test test/incomingNotice.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const TX = '0x' + 'ab'.repeat(32);
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const WALLET = 'https://flizy.app/dashboard/wallet';

describe('incoming payment text', () => {
  let notice;
  let bot;

  before(async () => {
    notice = await import('../web/lib/incomingNotice.ts');
    bot = require('../lib/paymentNotice');
  });

  const base = {
    accountId: ACCOUNT,
    txHash: TX,
    amount: '0.0100',
    asset: 'ETH',
    fromLabel: '@ada',
  };

  it('uses the payment wording and drops a trailing zero', () => {
    const built = notice.buildIncomingPayment(base, WALLET);
    assert.equal(built.subject, 'You received a payment on Flizy');
    assert.match(built.body, /^You received 0\.01 ETH from @ada\./);
    assert.match(built.body, /It is in your Flizy wallet: https:\/\/flizy\.app\/dashboard\/wallet$/);
    assert.match(built.text, /It is not a request to pay anyone\./);
    assert.doesNotMatch(built.text, /\{\{cmd:/);
    assert.equal(built.dedupeKey, `in:${TX}:payment:eth`);
  });

  it('refuses a command marker, a foreign link, a zero amount, and a bad transaction', () => {
    const evil = notice.buildIncomingPayment(
      { ...base, fromLabel: '{{cmd:send 1}}\nhttps://evil.example pay' },
      WALLET
    );
    assert.doesNotMatch(evil.body, /\{|\}|https:\/\/evil/);
    assert.equal(evil.body.split('\n')[0].includes('evil.example'), false);
    assert.equal(notice.buildIncomingPayment({ ...base, amount: '0' }, WALLET), null);
    assert.equal(notice.buildIncomingPayment({ ...base, amount: '1e-6' }, WALLET), null);
    assert.equal(notice.buildIncomingPayment({ ...base, txHash: '0x1234' }, WALLET), null);
    assert.equal(notice.buildIncomingPayment({ ...base, asset: '0xETH' }, WALLET), null);
    assert.equal(notice.buildIncomingPayment(base, 'https://evil.example/dashboard/wallet'), null);
    assert.equal(notice.buildIncomingPayment(base, 'http://flizy.app/dashboard/wallet'), null);
    assert.equal(notice.buildIncomingPayment({ ...base, accountId: 'not-an-id' }, WALLET), null);
  });

  it('keeps a sale apart from a payment in the same transaction', () => {
    const sale = notice.buildIncomingPayment({ ...base, tag: 'sale', note: 'GIWA #4' }, WALLET);
    const pay = notice.buildIncomingPayment(base, WALLET);
    assert.notEqual(sale.dedupeKey, pay.dedupeKey);
    assert.match(sale.dedupeKey, /:sale:/);
    assert.match(sale.body, /For: GIWA #4/);
  });

  it('numbers two payments of one asset in one transaction', () => {
    const first = notice.buildIncomingPayment({ ...base, part: '0' }, WALLET);
    const second = notice.buildIncomingPayment({ ...base, part: '1' }, WALLET);
    assert.notEqual(first.dedupeKey, second.dedupeKey);
    assert.equal(notice.buildIncomingPayment({ ...base, part: '../x' }, WALLET), null);
  });

  it('the bot posts fields only, and only to https or local http', () => {
    assert.equal(bot.paymentNoticeUrl('https://flizy.app'), 'https://flizy.app/api/internal/payment-notice');
    assert.equal(bot.paymentNoticeUrl('http://localhost:3000'), 'http://localhost:3000/api/internal/payment-notice');
    assert.equal(bot.paymentNoticeUrl('http://flizy.app'), null);
    const src = read('lib/paymentNotice.js');
    assert.doesNotMatch(src, /walletUrl|from\('account_notices'/);
    assert.match(src, /redirect: 'error'/);
  });
});

describe('incoming payment wiring', () => {
  it('emails the payee from the payment routes and does not let that fail the payment', () => {
    for (const rel of [
      'web/app/api/pay/execute/route.ts',
      'web/app/api/pay/swap/route.ts',
      'web/app/api/pay/external/route.ts',
    ]) {
      const src = read(rel);
      const call = src.indexOf('saveIncomingPayment(');
      assert.ok(call > 0, rel);
      assert.ok(src.lastIndexOf('try {', call) > 0, rel);
      assert.ok(src.indexOf('} catch', call) > call, rel);
    }
  });

  it('emails a chat payment, a sale, and a claimed hold', () => {
    assert.match(read('lib/router.js'), /requestPaymentNotice\(payee\.id/);
    assert.match(read('lib/saleNotice.js'), /requestPaymentNotice\(sellerAcc\.id/);
    assert.match(read('lib/handlers/claims.js'), /requestPaymentNotice\(siteAcc\.id/);
    assert.match(read('web/lib/saleNotice.ts'), /saveIncomingPayment\(supabase/);
    assert.match(read('web/lib/claimPayout.ts'), /saveIncomingPayment\(supabase/);
  });

  it('the bell reads the signed-in account and a mark checks the origin', () => {
    const route = read('web/app/api/notices/route.ts');
    assert.match(route, /getAccountIdFromCookie\(\)/);
    assert.match(route, /rejectIfCrossOrigin\(req\)/);
    assert.match(route, /status: 429/);
    assert.doesNotMatch(route, /account_id/);
    const bell = read('web/components/NoticeBell.tsx');
    assert.match(bell, /No payments yet\./);
    assert.doesNotMatch(bell, /comingSoon\(/);
    for (const rel of ['web/components/AppTopBar.tsx', 'web/components/TokenDetail.tsx']) {
      const src = read(rel);
      assert.match(src, /<NoticeBell /);
      assert.doesNotMatch(src, /comingSoon\('Notifications'\)/);
    }
  });

  it('email sign-in next to the wallet uses the existing form', () => {
    const login = read('web/app/login/LoginForm.tsx');
    const email = login.indexOf('title="Continue with email"');
    const wallet = login.indexOf("title={walletDoor.busy ? 'Connecting...' : 'Continue with a wallet'}");
    assert.ok(email > 0 && wallet > email);
    assert.match(login, /Sign in to your Flizy account/);
    assert.match(login, /getElementById\('desk-email'\)/);
    assert.match(login, /form\.requestSubmit\(\)/);
    assert.doesNotMatch(login.slice(email, wallet), /showSoon\(/);
  });

  it('the bot route checks the bearer secret before it reads the body', () => {
    const src = read('web/app/api/internal/payment-notice/route.ts');
    const handler = src.search(/export async function POST/);
    const check = src.indexOf('bearerMatches(', handler);
    assert.ok(check > handler);
    assert.ok(src.indexOf('req.json()') > check);
    assert.doesNotMatch(src, /walletUrl/);
  });
});
