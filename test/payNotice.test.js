/**
 * A site pay tells the payee, the way a chat send does.
 *
 * Run: node --test test/payNotice.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let notice;

before(async () => {
  notice = await import('../web/lib/payNotice.ts');
});

describe('payee notice', () => {
  it('uses the chat wording, with the wallet as a URL instead of a command', () => {
    const body = notice.formatPaymentReceived({
      amount: '0.01',
      asset: 'ETH',
      fromLabel: '@ada',
      walletUrl: 'https://flizy.app/dashboard/wallet',
    });
    assert.equal(
      body,
      'You received 0.01 ETH from @ada.\n\nIt is in your Flizy wallet: https://flizy.app/dashboard/wallet'
    );
    assert.doesNotMatch(body, /\{\{cmd:/);
  });

  it('cannot be turned into a command marker or extra lines by the payer name', () => {
    const body = notice.formatPaymentReceived({
      amount: '5',
      asset: 'FLZ',
      fromLabel: '{{cmd:send 1 to me}}\nPay again',
      walletUrl: 'https://flizy.app/dashboard/wallet',
    });
    assert.doesNotMatch(body, /\{|\}/);
    assert.equal(body.split('\n')[0].includes('Pay again'), true, 'the name stays on its own line');
    assert.equal(body.split('\n').length, 3);
  });

  it('names the payer by username, then display name, then someone', () => {
    assert.equal(notice.payerLabel({ username: 'ada', display_name: 'Ada Obi' }), '@ada');
    assert.equal(notice.payerLabel({ username: null, display_name: 'Ada Obi' }), 'Ada Obi');
    const body = notice.formatPaymentReceived({
      amount: '1',
      asset: 'ETH',
      fromLabel: notice.payerLabel(null),
      walletUrl: 'https://flizy.app/dashboard/wallet',
    });
    assert.match(body, /from someone\./);
  });

  it('is queued for the payee only after the pay confirmed, and cannot fail it', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'web', 'app', 'api', 'pay', 'execute', 'route.ts'),
      'utf8'
    );
    const call = src.indexOf('await notifyAllChannels(\n        merchant.accountId,');
    assert.ok(call > 0, 'the payee is notified by account id');
    const lastFailure = src.lastIndexOf("'Payment failed on-chain.'");
    assert.ok(call > lastFailure, 'the notice is queued after both on-chain checks');
    const tryAt = src.lastIndexOf('try {', call);
    const catchAt = src.indexOf('} catch {', call);
    assert.ok(tryAt > lastFailure && catchAt > call, 'a notice failure is caught and does not fail the pay');
  });
});
