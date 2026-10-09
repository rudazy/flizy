'use strict';

/**
 * Guards for the swap quote, the limit price, the pay link review and task
 * cancelling. Most are source checks, because the behaviour lives in client
 * pages; the pay number check runs the real normaliser.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('swap quote follows the inputs', () => {
  const swap = read('web/app/dashboard/swap/page.tsx');

  it('only counts a quote made for the amount, pair and slippage on screen', () => {
    assert.match(swap, /const inputs = `\$\{amountIn\}\|\$\{tokenIn\}\|\$\{tokenOut\}\|\$\{slippageBps\}`;/);
    assert.match(swap, /const quote = quoted && quoted\.inputs === inputs \? quoted : null;/);
    assert.match(swap, /setQuote\(\{ \.\.\.data, inputs: `\$\{amountIn\}\|\$\{tokenIn\}\|\$\{tokenOut\}\|\$\{slippageBps\}` \}\)/);
  });

  it('keeps Swap off until that quote is in', () => {
    assert.match(swap, /<CtaButton disabled=\{busy \|\| quoting \|\| !quote \|\| !password\} onClick=\{runSwap\}>/);
    assert.match(swap, /minOut: quote\?\.amountOutMin,/);
  });

  it('applies the limit price as it is typed', () => {
    assert.match(swap, /onLive=\{setLimitPrice\}/);
    assert.match(swap, /if \(onLive && Number\(next\) > 0\) onLive\(next\);/);
  });
});

describe('pay link', () => {
  const landing = read('web/components/PayLanding.tsx');

  it('reviews the payment before anything is sent', () => {
    const review = landing.indexOf("setStage('review')");
    const execute = landing.indexOf("fetch('/api/pay/execute'");
    assert.ok(review > 0 && execute > 0);
    assert.match(landing, /<form onSubmit=\{onReview\}/);
    assert.match(landing, /disabled=\{busy \|\| !password\}\s*onClick=\{\(\) => void onPay\(\)\}/);
    assert.match(landing, /Review payment to \{handle\}/);
  });

  it('shows the first payment warning on the review step too', () => {
    const reviewBlock = landing.slice(landing.indexOf("stage === 'review' ? ("), landing.indexOf("stage === 'edit' ? ("));
    assert.match(reviewBlock, /firstPay \?/);
    assert.match(reviewBlock, /First payment\./);
  });

  it('says Paid once, not again as an error', () => {
    assert.doesNotMatch(landing, /setMsg\('Paid\.'\)/);
  });

  it('decodes the number in both pay links before reading it', () => {
    for (const file of ['web/app/pay/[code]/page.tsx', 'web/app/pay/c/[code]/page.tsx']) {
      assert.match(read(file), /const raw = decodeRouteParam\(params\.code\);/, file);
    }
  });
});

describe('pay number with spaces', () => {
  let normalizePayCode;
  let decodeRouteParam;
  before(async () => {
    ({ normalizePayCode } = await import('../web/lib/payCode.ts'));
    ({ decodeRouteParam } = await import('../web/lib/routeParam.ts'));
  });

  it('reads 961 702 160 once the link is decoded', () => {
    assert.equal(normalizePayCode(decodeRouteParam('961%20702%20160')), '961702160');
  });

  it('leaves a malformed escape as it came instead of throwing', () => {
    assert.equal(decodeRouteParam('50%'), '50%');
    assert.equal(decodeRouteParam(undefined), '');
  });

  it('would misread it still encoded, which is why the page decodes', () => {
    assert.notEqual(normalizePayCode('961%20702%20160'), '961702160');
  });
});

describe('task cancel', () => {
  const review = read('web/app/dashboard/explore/[ref]/review/page.tsx');

  it('asks first, then calls the creator-only cancel route', () => {
    assert.match(review, /fetch\(`\/api\/tasks\/\$\{taskRef\}\/cancel`, \{ method: 'POST' \}\)/);
    assert.match(review, /onClick=\{\(\) => setCancelAsk\(true\)\}/);
    assert.match(review, /cancelAsk \? \(/);
    assert.match(review, /Yes, cancel task/);
  });

  it('is offered only while the task is live', () => {
    const at = review.indexOf('<AppSection title="Cancel this task">');
    assert.ok(at > 0);
    assert.match(review.slice(at - 60, at), /state === 'live' \? \(/);
  });
});

describe('Scan username is opt-in', () => {
  const sql = read('supabase/migrations/20261013120000_scan_username_opt_in.sql');
  const route = read('web/app/api/account/scan-visibility/route.ts');
  const scan = read('web/app/api/scan/route.ts');

  it('switches existing accounts off once, and never again on a re-run', () => {
    assert.match(sql, /if current_default = 'true' then\s+alter table public\.accounts alter column scan_show_username set default false;\s+update public\.accounts set scan_show_username = false where scan_show_username;/);
    assert.match(sql, /raise exception 'accounts\.scan_show_username default is not false'/);
  });

  it('reads a missing or null setting as off everywhere', () => {
    assert.doesNotMatch(route, /scan_show_username !== false/);
    assert.equal((route.match(/showUsername: data\?\.scan_show_username === true/g) || []).length, 2);
    assert.match(scan, /scan_show_username === true \? account\.username \?\? null : null/);
  });
});

describe('no blue', () => {
  it('draws ETH in the neutral palette, never the Ethereum blue', () => {
    const files = ['web/app/dashboard/swap/page.tsx', 'web/components/AccountProfile.tsx', 'web/components/ExploreTokens.tsx', 'web/components/WalletBalances.tsx'];
    for (const file of files) assert.doesNotMatch(read(file), /#627eea/i, file);
  });

  it('dims a gold button while it is off', () => {
    assert.match(read('web/app/globals.css'), /\.btn-sun:disabled \{\s*opacity: 0\.45;/);
  });
});
