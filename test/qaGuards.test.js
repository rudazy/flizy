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

describe('history after a transaction', () => {
  it('selects the sender id, so a received payment can be named', () => {
    // The fake database returns whole rows whatever is selected, so only the
    // select itself can prove the column is asked for.
    const src = read('lib/history.js');
    for (const name of ['TRANSFER_SELECT_FULL', 'TRANSFER_SELECT_CORE']) {
      const at = src.indexOf(`const ${name} =`);
      assert.ok(at >= 0, name);
      assert.match(src.slice(at, at + 200), /'id, account_id, amount_eth,/, name);
    }
  });

  it('shows no amount for a row that moved no money', () => {
    assert.match(read('web/app/dashboard/page.tsx'), /\{Number\(row\.amount\) > 0 \? \(/);
    assert.match(read('web/components/ActivityPanels.tsx'), /const hasAmount = Number\(row\.amount\) > 0;/);
  });

  it('refreshes balances and history after every money path on the site', () => {
    const provider = read('web/components/DashboardProvider.tsx');
    assert.match(provider, /window\.addEventListener\(TX_EVENT, onTx\)/);
    for (const file of [
      'web/components/FaucetPanel.tsx',
      'web/components/TokenTradeSheet.tsx',
      'web/app/dashboard/swap/page.tsx',
      'web/app/dashboard/page.tsx',
    ]) {
      assert.match(read(file), /announceTx\(\);/, file);
    }
  });

  it('shows a placeholder, not a zero, while the wallet loads', () => {
    const wallet = read('web/components/WalletBalances.tsx');
    assert.doesNotMatch(wallet, /: '0\.000000'\}/);
    assert.match(wallet, /aria-label="Loading balance"/);
  });
});

describe('figures that read "-"', () => {
  let summarizeAccountStats;
  let scan;
  before(async () => {
    ({ summarizeAccountStats } = await import('../web/lib/accountStats.ts'));
    scan = await import('../web/lib/walletScan.ts');
  });

  it('counts confirmed swaps and the ETH they and sends moved', () => {
    const stats = summarizeAccountStats([
      { kind: 'swap', status: 'confirmed', asset: 'ETH', amount_eth: '0.01', amount_secondary: '3.4', asset_secondary: 'FLZ' },
      { kind: 'swap', status: 'confirmed', asset: 'FLZ', amount_eth: '5', amount_secondary: '0.002', asset_secondary: 'ETH' },
      { kind: 'swap', status: 'failed', asset: 'ETH', amount_eth: '9' },
      { kind: null, status: 'confirmed', asset: null, amount_eth: '0.003' },
      { kind: 'transfer', status: 'confirmed', asset: 'FLZ', amount_eth: '100' },
      { kind: 'nft_market', status: 'confirmed', asset: 'ETH', amount_eth: '0' },
    ]);
    assert.equal(stats.swaps, 2);
    assert.ok(Math.abs(stats.volumeEth - 0.015) < 1e-12, String(stats.volumeEth));
  });

  it('prices a token-for-ETH swap on Scan by the ETH it received', () => {
    const NOW = Date.parse('2026-10-09T12:00:00Z');
    const base = { type: 'swap', direction: 'out', status: 'confirmed', createdAt: new Date(NOW - 3600e3).toISOString(), label: 'x', category: 'swap' };
    const rows = [
      { ...base, id: 'a', amount: '1', asset: 'ETH' },
      { ...base, id: 'b', amount: '10', asset: 'FLZ', amountSecondary: '0.5', assetSecondary: 'ETH' },
    ];
    assert.equal(scan.scanStats(rows, '24h', NOW, 2000).volumeUsd, 3000);
  });

  it('writes the token list unit as text, and keeps blue out of ETH marks', () => {
    const tokens = read('web/components/ExploreTokens.tsx');
    assert.doesNotMatch(tokens, /8c8fe8/i);
    assert.match(tokens, /return <>\{figure\.unit \? `\$\{figure\.value\} \$\{figure\.unit\}` : figure\.value\}<\/>;/);
    for (const file of ['web/components/WalletBalances.tsx', 'web/components/ExploreNfts.tsx']) {
      assert.doesNotMatch(read(file), /8c8fe8/i, file);
    }
  });

  it('has no unread dot on a bell with nothing to read', () => {
    assert.doesNotMatch(read('web/components/AppTopBar.tsx'), /rounded-full bg-sun"\s*\n\s*aria-hidden/);
  });
});

describe('first steps on Home', () => {
  let summarizeAccountStats;
  before(async () => {
    ({ summarizeAccountStats } = await import('../web/lib/accountStats.ts'));
  });
  const steps = read('web/components/FirstSteps.tsx');

  it('counts a confirmed send, in any asset, as a first payment', () => {
    const s = summarizeAccountStats([
      { kind: 'transfer', status: 'confirmed', asset: 'FLZ', amount_eth: '10' },
      { kind: 'transfer', status: 'failed', asset: 'ETH', amount_eth: '1' },
    ]);
    assert.equal(s.sends, 1);
    assert.equal(s.volumeEth, 0);
  });

  it('ticks each step from the account own data, and counts held claims as sends', () => {
    // A claim is 'sent' until its receipt lands, then 'confirmed'; both count.
    assert.match(steps, /lastClaim\?\.status === 'sent' \|\| faucet\?\.lastClaim\?\.status === 'confirmed'/);
    assert.match(read('web/app/api/history/route.ts'), /\.in\('status', \['sent', 'confirmed'\]\)/);
    assert.match(steps, /swapped: stats\.swaps > 0/);
    assert.match(steps, /sent: stats\.sends > 0/);
    assert.match(read('web/app/api/account/stats/route.ts'), /\.eq\('from_account_id', accountId\)\s*\.neq\('status', 'cancelled'\)/);
  });

  it('shows only to a ready account, hides when done or hidden, and follows transactions', () => {
    assert.match(steps, /if \(!ready \|\| hidden \|\| !progress\) return null;/);
    assert.match(steps, /if \(doneCount === steps\.length\) return null;/);
    assert.match(steps, /window\.addEventListener\(TX_EVENT, onTx\)/);
    assert.match(read('web/app/dashboard/page.tsx'), /<FirstSteps \/>/);
  });

  it('links each step to a real place', () => {
    for (const href of ['/dashboard/wallet?s=fund', '/dashboard/swap', '/dashboard/account?s=chat']) {
      assert.ok(steps.includes(`href: '${href}'`), href);
    }
    assert.match(read('web/app/dashboard/account/page.tsx'), /id: 'chat'/);
  });
});

describe('sign-in and sign-up', () => {
  const login = read('web/app/login/LoginForm.tsx');
  const signup = read('web/app/signup/SignupForm.tsx');
  const gate = read('web/components/EmailVerifyGate.tsx');

  it('sends a signed-in visitor on instead of showing the login form', () => {
    const page = read('web/app/login/page.tsx');
    assert.match(page, /if \(await getAccountIdFromCookie\(\)\) redirect\(safeNext\(searchParams\?\.next\)\);/);
  });

  it('says a resent code replaces the old one, and clears a stale error on typing', () => {
    assert.match(login, /New code sent to \$\{email\}\. Earlier codes no longer work\./);
    assert.match(login, /if \(error\) setError\(''\);/);
    assert.match(login, /you signed out here,\s*or it has been 30 days/);
  });

  it('keeps the button busy once the next page is on its way', () => {
    for (const [name, src] of [['login', login], ['signup', signup]]) {
      assert.match(src, /leaving = true;\s*\n\s*router\.push/, name);
      assert.match(src, /if \(!leaving\) setLoading\(false\);/, name);
    }
  });

  it('asks for the code sign-up already sent, and offers a new one second', () => {
    assert.match(gate, /We sent a 6-digit code to/);
    assert.doesNotMatch(gate, /Send verification code/);
    assert.ok(gate.indexOf('</form>') < gate.indexOf("'Send a new code'"));
    assert.doesNotMatch(gate, /\u2014/);
  });

  it('calls the PIN recommended and says what it is for', () => {
    const home = read('web/app/dashboard/page.tsx');
    assert.match(home, /action=\{<Badge>Recommended<\/Badge>\}/);
    assert.doesNotMatch(home, /subtitle="Required\. After flizy lock/);
  });

  it('offers Sign out from the profile menu as well as Security', () => {
    assert.match(read('web/components/AccountProfile.tsx'), /onSignOut\(\);\s*\n\s*\}\}[\s\S]{0,300}Sign out/);
    assert.match(read('web/app/dashboard/account/page.tsx'), /onSignOut=\{\(\) => void onSignOut\(\)\}/);
  });
});

describe('account ids stay on the server', () => {
  it('drops account_id from the legacy transfers rows History returns', () => {
    const route = read('web/app/api/history/route.ts');
    assert.match(route, /const \{ account_id: _accountId, \.\.\.rest \} = e\.row;/);
    assert.match(route, /transfers: transferRows\.slice\(0, 30\)/);
  });

  it('returns only figures from the stats route', () => {
    const route = read('web/app/api/account/stats/route.ts');
    assert.match(route, /\.eq\('account_id', accountId\)/);
    assert.match(route, /return NextResponse\.json\(stats\);/);
  });
});

describe('Explore order and Trending tokens', () => {
  it('opens Explore on Tokens, then Tasks, then NFTs', () => {
    const explore = read('web/app/dashboard/explore/page.tsx');
    assert.match(explore, /const SLIDES = \['tokens', 'tasks', 'nfts'\] as const;/);
    assert.match(explore, /useSlide\(SLIDES, 'tokens'\)/);
    const tabs = explore.slice(explore.indexOf('items={['));
    assert.ok(tabs.indexOf("id: 'tokens'") < tabs.indexOf("id: 'tasks'"));
    assert.ok(tabs.indexOf("id: 'tasks'") < tabs.indexOf("id: 'nfts'"));
  });

  it('sends task links to the Tasks slide now that Tokens opens first', () => {
    assert.match(read('web/app/dashboard/page.tsx'), /<CardLink href="\/dashboard\/explore\?s=tasks">View all<\/CardLink>/);
    assert.doesNotMatch(read('web/app/tasks/[ref]/page.tsx'), /['"]\/dashboard\/explore['"]/);
    assert.match(read('web/lib/searchIndex.ts'), /title: 'Explore tasks'[^\n]*href: '\/dashboard\/explore\?s=tasks'/);
  });

  it('lists only Flizy-listed tokens, from the Explore source, with ETH priced in FLZ', () => {
    const card = read('web/components/TrendingTokens.tsx');
    assert.match(card, /fetch\('\/api\/tokens'\)/);
    assert.doesNotMatch(card, /PEPE|SHIB/);
    assert.match(card, /unit: Number\.isFinite\(per\) && per > 0 \? 'FLZ' : ''/);
    assert.doesNotMatch(card, /border-red|#ff0000|outline-red/i);
  });
});

describe('any token opens like FLZ', () => {
  let market;
  let holders;
  before(async () => {
    market = await import('../web/lib/tokenMarket.ts');
    holders = await import('../web/lib/tokenHolders.ts');
  });

  it('prices a 6-decimal token in whole tokens, not raw units', () => {
    // 1 ETH bought 2,000 whole tokens of a 6-decimal token: 0.0005 ETH each.
    const print = market.printFromSwap({
      flzIsToken0: true,
      amount0In: 0n,
      amount1In: 10n ** 18n,
      amount0Out: 2000n * 10n ** 6n,
      amount1Out: 0n,
      time: 1,
      tokenDecimals: 6,
    });
    assert.ok(Math.abs(print.priceEth - 0.0005) < 1e-12, String(print.priceEth));
    assert.equal(print.flzAmount, 2000);
    assert.equal(print.side, 'buy');
  });

  it('shows holder amounts in the token own decimals', () => {
    const view = holders.presentHolders(
      [{ address: '0x' + '1'.repeat(40), balance: 1500n * 10n ** 6n }],
      3000n * 10n ** 6n,
      null,
      6
    );
    assert.equal(view.holders[0].amount, '1,500');
    assert.equal(view.topShare, '50.0%');
  });

  it('routes every token address to the full page, reading its own pool', () => {
    const page = read('web/app/dashboard/explore/tokens/[symbol]/page.tsx');
    assert.match(page, /return <TokenDetail symbol=\{params\.symbol \|\| ''\} \/>;/);
    assert.ok(!fs.existsSync(path.join(ROOT, 'web/components/HeldToken.tsx')));
    const detail = read('web/components/TokenDetail.tsx');
    assert.match(detail, /fetch\(`\/api\/tokens\/\$\{tokenRef\}\?range=\$\{which\}`\)/);
    assert.match(detail, /Not verified by Flizy, so it cannot be sent on socials\./);
    // Trading waits for the token's own pool, and never falls back to FLZ.
    assert.match(detail, /const canTrade = listed \|\| \(imported && market != null\);/);
    assert.match(detail, /const contract = market\?\.address \|\| held\?\.address \|\| \(imported \? symbol : null\);/);
    assert.match(detail, /\(listed \? 'FLZ' : 'Token'\)/);
    assert.equal((detail.match(/disabled=\{!canTrade\}/g) || []).length, 2);
    assert.match(detail, /tokenAddress=\{imported \? contract : null\}/);
    assert.match(detail, /\.filter\(\(\[id\]\) => listed \|\| id !== 'thesis'\)/);
    const route = read('web/app/api/tokens/[symbol]/route.ts');
    assert.match(route, /const described = await describeHeldToken\(accountId, raw\);/);
    assert.match(route, /cachedTokenDay\(held\.address, held\.symbol, held\.decimals\)/);
  });

  it('finds the pool through the swap router own factory', () => {
    const server = read('web/lib/tokenMarketServer.ts');
    assert.match(server, /new ethers\.Contract\(dex\.dexRouter, ROUTER_ABI, provider\)\.factory\(\)/);
    assert.match(server, /getPair\(token, dex\.wrappedNative\)/);
  });
});
