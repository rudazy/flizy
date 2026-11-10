/**
 * Paused features (payments-first): what is paused is hidden and takes nothing
 * new, and what people already own stays reachable.
 *
 * Paused: NFT marketplace, NFT minting and collections (with Copy Mint), tasks,
 * projects and the XP leaderboard, the token social layer, follows. Never
 * paused here: payments, swapping, listed tokens, liquidity, limit orders,
 * Ammora and Copy Trade.
 *
 * Run: node --test test/features.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const botFeatures = require('../lib/features');

const ROOT = path.join(__dirname, '..');
// Line endings vary by file; the checks below are written for \n.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const ALL_OFF = { nftMarket: false, nftMint: false, tasks: false, projects: false, tokenSocial: false, follows: false };
const ALL_ON = { nftMarket: true, nftMint: true, tasks: true, projects: true, tokenSocial: true, follows: true };

let web;
before(async () => {
  web = await import('../web/lib/features.ts');
});

describe('the switches', () => {
  it('every feature is paused unless its switch says "on"', () => {
    assert.deepEqual(web.featureFlags({}), ALL_OFF);
    assert.deepEqual(web.featureFlags({ FEATURE_NFT_MARKET: 'true', FEATURE_TASKS: '1', FEATURE_FOLLOWS: 'yes' }), ALL_OFF);
    assert.deepEqual(
      web.featureFlags({ FEATURE_NFT_MARKET: 'on', FEATURE_NFT_MINT: ' ON ', FEATURE_TASKS: 'On', FEATURE_PROJECTS: 'on', FEATURE_TOKEN_SOCIAL: 'on', FEATURE_FOLLOWS: 'on' }),
      ALL_ON
    );
  });

  it('the bots read the same switches with the same default', () => {
    assert.deepEqual({ ...botFeatures.FEATURE_ENV }, { ...web.FEATURE_ENV });
    assert.equal(botFeatures.PAUSED_MESSAGE, web.PAUSED_MESSAGE);
    for (const f of Object.keys(web.FEATURE_ENV)) {
      assert.equal(botFeatures.featureOn(f, {}), false, f);
      assert.equal(botFeatures.featureOn(f, { [web.FEATURE_ENV[f]]: 'on' }), true, f);
    }
    assert.throws(() => botFeatures.featureOn('payments', {}), /unknown feature/);
  });

  it('payments, swapping, liquidity, limit orders, Ammora and Copy Trade have no switch', () => {
    for (const name of Object.values(web.FEATURE_ENV)) assert.doesNotMatch(name, /PAY|SWAP|LIQUID|LIMIT|AMMORA|COPY_TRADE|TOKEN_(?!SOCIAL)/, name);
  });

  it('the root layout hands the server-read flags to the app', () => {
    const layout = read('web/app/layout.tsx');
    assert.match(layout, /<FeaturesProvider flags=\{featureFlags\(\)\}>/);
  });
});

describe('trading and payments are never switched off', () => {
  /** Every file on a trading or payment path, recursively for directories. */
  function files(rel) {
    const full = path.join(ROOT, rel);
    if (!fs.statSync(full).isDirectory()) return [rel];
    return fs.readdirSync(full, { withFileTypes: true }).flatMap((e) => files(path.posix.join(rel, e.name)));
  }
  const PATHS = [
    // Swap, liquidity and limit orders, on the site and in chat.
    'web/app/api/swap',
    'web/app/dashboard/swap',
    'web/components/TokenTradeSheet.tsx',
    'lib/dex.js',
    'lib/limitOrders.js',
    'lib/engine',
    // Ammora, the partner venue: its view, its panel, its routes and the chat venue.
    'web/app/api/ammora',
    'web/components/AmmoraTokens.tsx',
    'web/components/AmmoraSwapPanel.tsx',
    'lib/ammora',
    // Copy Trade.
    'web/components/CopyTradePanel.tsx',
    // Balances, payments, checkouts and the Pay API.
    'web/app/api/holdings',
    'web/app/api/pay',
    'web/app/pay',
    'web/app/api/checkout',
    'web/app/checkout',
    'web/app/api/v1',
    'lib/api',
  ];

  it('no trading or payment file reads a paused-feature switch', () => {
    for (const rel of PATHS.flatMap(files).filter((f) => /\.(js|ts|tsx)$/.test(f))) {
      assert.doesNotMatch(read(rel), /featureOn|useFeatures|pausedBody|FEATURE_[A-Z_]+/, rel);
    }
  });

  it('where a trading screen shares a file with a paused feature, only that feature is gated', () => {
    const tokens = read('web/components/ExploreTokens.tsx');
    assert.deepEqual([...new Set(tokens.match(/\b(tokenSocial|nftMarket|nftMint|tasks|projects|follows)\b/g))], ['tokenSocial']);
    assert.match(tokens, /const SOCIAL_TABS: readonly string\[\] = \['watchlist'\];/);
    assert.match(tokens, /view === 'ammora' && ammoraOn/);
    assert.match(tokens, /tab === 'copy' \? <CopyTradePanel \/>/);
    const detail = read('web/components/TokenDetail.tsx');
    assert.deepEqual([...new Set(detail.match(/useFeatures\(\)|tokenSocial/g))].sort(), ['tokenSocial', 'useFeatures()'].sort());
    // The copy route gates only Copy Mint; a Copy Trade save goes straight to saveCopySetup.
    assert.equal((read('web/app/api/copy/route.ts').match(/featureOn\('/g) || []).length, 1);
    // Chat gates only minting and selling into an NFT offer; buy, sell and swap are untouched.
    const router = read('lib/router.js');
    assert.deepEqual([...new Set(router.match(/featureOn\('[a-zA-Z]+'\)/g))].sort(), ["featureOn('nftMarket')", "featureOn('nftMint')"]);
    assert.match(router, /\{ command: 'buy', description: 'Trade: buy FLZ \(buy 100 FLZ\)' \}/);
    assert.match(router, /\{ command: 'swap', description: 'Trade: swap tokens' \}/);
  });

  it('Explore always opens on Tokens, the trading slide', () => {
    assert.match(read('web/app/dashboard/explore/page.tsx'), /SLIDES\.filter\(\(id\) => id === 'tokens' \|\|/);
  });
});

describe('hidden stays hidden', () => {
  it('Explore drops Tasks and NFTs, and the people button, while paused', () => {
    const explore = read('web/app/dashboard/explore/page.tsx');
    assert.match(explore, /id === 'tokens' \|\| \(id === 'tasks' && features\.tasks\) \|\| \(id === 'nfts' && nfts\)/);
    assert.match(explore, /const nfts = features\.nftMarket \|\| features\.nftMint;/);
    assert.match(explore, /\.filter\(\(item\) => \(slides as readonly string\[\]\)\.includes\(item\.id\)\)/);
    assert.match(explore, /people=\{features\.follows\}/);
  });

  it('NFT tabs follow the market switch, Copy Mint, Mint and Collections the mint switch', () => {
    const nfts = read('web/components/ExploreNfts.tsx');
    assert.match(nfts, /TABS\.filter\(\(t\) => \(t\.id === COPY_MINT\.id \? features\.nftMint : features\.nftMarket\)\)/);
    assert.match(nfts, /SECTIONS\.filter\(\(s\) => \(s\.id === 'discover' \? tabs\.length > 0 : features\.nftMint\)\)/);
  });

  it('Home hides the tasks card and Create task; Account hides Projects', () => {
    const home = read('web/app/dashboard/page.tsx');
    assert.match(home, /\{features\.tasks \? \(\s*<AppCollapsibleCard\s*id="home-tasks"/);
    assert.match(home, /if \(!features\.tasks\) return;\s*let cancelled = false;/);
    assert.match(home, /\{features\.tasks \? \(\s*<ActionRow href="\/dashboard\/explore\/new"/);
    assert.doesNotMatch(home, /accept NFT offers/);
    const account = read('web/app/dashboard/account/page.tsx');
    assert.match(account, /SLIDES\.filter\(\(id\) => id !== 'projects' \|\| projectsOn\)/);
    assert.match(account, /\.\.\.\(projectsOn \? \[\{ id: 'projects', label: 'Projects' \}\] : \[\]\)/);
  });

  it('token social: no watchlist filter and no theses or watch while paused', () => {
    assert.match(read('web/components/ExploreTokens.tsx'), /\.filter\(\(id\) => social \|\| !SOCIAL_TABS\.includes\(id\)\)/);
    assert.match(read('web/components/TokenDetail.tsx'), /const social = listed && walletMode == null && tokenSocial;/);
  });

  it('profiles keep Pay, hide follow counts and Follow, and let an existing follow end', () => {
    const profile = read('web/components/PublicProfile.tsx');
    assert.match(profile, /\) : !followsOn \? null : profile\.signedIn \? \(/);
    assert.match(profile, /\{followsOn \? \(\s*<div className="relative mt-4 flex items-center gap-4">/);
    assert.match(profile, /href=\{`\/pay\/\$\{encodeURIComponent\(profile\.username\)\}`\}/);
    assert.match(profile, /onClick=\{\(\) => void send\('DELETE'\)\}/);
    assert.match(read('web/app/people/page.tsx'), /if \(!featureOn\('follows'\)\) notFound\(\);/);
  });

  it('search offers paused places only while their feature is on, and My NFTs always', async () => {
    const I = await import('../web/lib/searchIndex.ts');
    const hrefs = (q, flags) => I.matchPlaces(q, 20, flags).map((r) => r.href);
    assert.equal(hrefs('tasks', ALL_OFF).includes('/dashboard/explore?s=tasks'), false);
    assert.equal(hrefs('tasks', { ...ALL_OFF, tasks: true }).includes('/dashboard/explore?s=tasks'), true);
    assert.equal(hrefs('mint', ALL_OFF).includes('/dashboard/explore/nfts/mints'), false);
    assert.equal(hrefs('projects', ALL_OFF).includes('/dashboard/account?s=projects'), false);
    assert.equal(hrefs('nfts', { ...ALL_OFF, nftMarket: true }).includes('/dashboard/explore?s=nfts'), true);
    assert.equal(hrefs('my nfts', ALL_OFF).includes('/dashboard/explore/nfts/me'), true);
    assert.equal(I.POPULAR_PLACES.some((p) => p.href.includes('tasks')), false);
    assert.equal(I.POPULAR_PLACES[0].href, '/dashboard/account?s=pay');
  });

  it('remote search skips paused groups without querying them', async () => {
    const S = await import('../web/lib/siteSearch.ts');
    const fake = createFakeSupabase({
      projects: [{ handle: 'flizy', name: 'Flizy' }],
      tasks: [{ id: 't-1', ref: 142, title: 'Flizy launch', status: 'live', ends_at: new Date(Date.now() + 3600e3).toISOString(), created_at: '2026-10-01T00:00:00.000Z' }],
    });
    let nftCalls = 0;
    const collections = async () => {
      nftCalls += 1;
      return [];
    };
    const off = await S.siteSearch('flizy', { client: fake.client, collections, flags: ALL_OFF });
    assert.deepEqual([off.projects, off.tasks, off.nfts], [[], [], []]);
    assert.equal(nftCalls, 0);
    const on = await S.siteSearch('flizy', { client: fake.client, collections, flags: ALL_ON });
    assert.equal(on.projects.length, 1);
    assert.equal(nftCalls, 1);
  });

  it('chat help keeps NFT send, drops mint while paused; the docs page drops mint and accept offer', () => {
    const router = read('lib/router.js');
    assert.match(router, /'YOUR NFTS',\s*`  \$\{p\('send giwaforge to you@email\.com'\)\}/);
    assert.match(router, /\.\.\.\(featureOn\('nftMint'\) \? \[`  \$\{p\('mint 1 giwaforge'\)\}   one test NFT per wallet`\] : \[\]\)/);
    const docs = read('web/app/docs/page.tsx');
    assert.match(docs, /group\.rows\.filter\(\(row\) => !row\.feature \|\| featureOn\(row\.feature\)\)/);
    assert.match(docs, /wa: 'mint 1 giwaforge',[\s\S]{0,300}?feature: 'nftMint',/);
    assert.match(docs, /wa: 'accept offer',[\s\S]{0,400}?feature: 'nftMarket',/);
  });

  it('the homepage and llms.txt lead with payments, then swap, and name no paused feature', () => {
    const home = read('web/app/page.tsx');
    const features = home.slice(home.indexOf('const FEATURES = ['), home.indexOf('const WHY = ['));
    assert.ok(features.indexOf("t: 'Pay and get paid'") < features.indexOf("t: 'Swap'"));
    assert.doesNotMatch(features, /NFT|Mint|task/i);
    const llms = read('web/public/llms.txt');
    assert.doesNotMatch(llms, /flizy\.app\/people|Follow and unfollow|mints and tasks/);
    assert.doesNotMatch(home + llms, /non-custodial|noncustodial|audited/i);
  });
});

describe('paused routes take nothing new', () => {
  const GUARDED = [
    ['web/app/api/mints/collections/route.ts', 'nftMint'],
    ['web/app/api/mints/generated/ai/image/route.ts', 'nftMint'],
    ['web/app/api/mints/generated/ai/plan/route.ts', 'nftMint'],
    ['web/app/api/mints/generated/images/route.ts', 'nftMint'],
    ['web/app/api/mints/generated/metadata/route.ts', 'nftMint'],
    ['web/app/api/mints/generated/pay/route.ts', 'nftMint'],
    ['web/app/api/mints/import/route.ts', 'nftMint'],
    ['web/app/api/mints/[collection]/allowlist/route.ts', 'nftMint'],
    ['web/app/api/tasks/route.ts', 'tasks'],
    ['web/app/api/tasks/[ref]/feature/route.ts', 'tasks'],
    ['web/app/api/tasks/[ref]/save/route.ts', 'tasks'],
    ['web/app/api/tasks/[ref]/submit/route.ts', 'tasks'],
    ['web/app/api/projects/route.ts', 'projects'],
    ['web/app/api/projects/workspace/[handle]/members/route.ts', 'projects'],
    ['web/app/api/tokens/[symbol]/theses/route.ts', 'tokenSocial'],
    ['web/app/api/tokens/[symbol]/theses/[id]/comments/route.ts', 'tokenSocial'],
    ['web/app/api/tokens/[symbol]/theses/[id]/like/route.ts', 'tokenSocial'],
    ['web/app/api/tokens/[symbol]/watch/route.ts', 'tokenSocial'],
    ['web/app/api/u/[username]/follow/route.ts', 'follows'],
    ['web/app/api/nfts/favorites/route.ts', 'nftMarket'],
  ];

  it('each new-activity POST refuses first thing while its feature is paused', () => {
    for (const [file, feature] of GUARDED) {
      const src = read(file);
      const post = src.slice(src.indexOf('export async function POST('));
      assert.match(
        post,
        new RegExp(`^export async function POST\\([^\\n]*\\{\\n  // Paused feature \\(web/lib/features\\.ts\\): nothing new while it is off\\.\\n  if \\(!featureOn\\('${feature}'\\)\\) return NextResponse\\.json\\(pausedBody\\(\\), \\{ status: 403 \\}\\);`),
        file
      );
    }
  });

  it('the marketplace refuses new trades and lets every exit through', () => {
    const market = read('web/app/api/market/[action]/route.ts');
    assert.equal((market.match(/if \(!exits && !featureOn\('nftMarket'\)\) return NextResponse\.json\(pausedBody\(\), \{ status: 403 \}\);/g) || []).length, 2);
    assert.equal((market.match(/const exits = action === 'cancel' \|\| action === 'offer-cancel' \|\| action === 'withdraw';/g) || []).length, 2);
  });

  it('the item page reads a paused marketplace as paused: Cancel and Withdraw stay, trade buttons go', () => {
    assert.match(read('web/lib/nftApi.ts'), /paused: paused \|\| !featureOn\('nftMarket'\)/);
    const item = read('web/components/NftItem.tsx');
    assert.match(item, /if \(m\.tradable && !m\.paused\) \{/);
    assert.match(item, /\) : m\.paused \? \(\s*<p[^>]*>Trading is paused right now\.<\/p>/);
  });

  it('a creator may still pause their own drop; nothing is minted, configured or published', () => {
    assert.match(read('web/app/api/mints/[collection]/[action]/route.ts'), /if \(action !== 'pause' && !featureOn\('nftMint'\)\) return NextResponse\.json\(pausedBody\(\), \{ status: 403 \}\);/);
  });

  it('Copy Mint saves are refused; Copy Trade saves are not', () => {
    const copy = read('web/app/api/copy/route.ts');
    assert.match(copy, /\?\.kind === 'mint' && !featureOn\('nftMint'\)/);
    assert.doesNotMatch(copy, /featureOn\('(?!nftMint)/);
  });

  it('chat refuses a new mint and selling into an offer, with the paused message', () => {
    const router = read('lib/router.js');
    assert.match(router, /async function handleMint\(ctx, user, account, parsed\) \{\n  \/\/ [^\n]*\n  if \(!featureOn\('nftMint'\)\) \{\n    await reply\(ctx, PAUSED_MESSAGE\);/);
    assert.match(router, /async function handleAcceptOffer\(ctx, user, account\) \{[\s\S]{0,200}?if \(!featureOn\('nftMarket'\)\) \{\s*await reply\(ctx, PAUSED_MESSAGE\);/);
  });
});

describe('owned assets stay reachable', () => {
  it('the wallet always shows owned NFTs, offers made and earnings, with no switch', () => {
    const balances = read('web/components/WalletBalances.tsx');
    assert.match(balances, /<WalletNfts chainName=\{chainName\} hidden=\{hidden\} \/>\s*<WalletOffers hidden=\{hidden\} \/>\s*<WalletEarnings hidden=\{hidden\} \/>/);
    for (const f of ['web/components/WalletBalances.tsx', 'web/components/WalletNfts.tsx', 'web/components/WalletOffers.tsx', 'web/components/WalletEarnings.tsx']) {
      assert.doesNotMatch(read(f), /useFeatures|featureOn/, f);
    }
  });

  it('My NFTs and every NFT item page open whatever the switches say', () => {
    for (const f of [
      'web/app/dashboard/explore/nfts/me/page.tsx',
      'web/app/dashboard/explore/nfts/[collection]/[tokenId]/page.tsx',
      'web/components/NftItem.tsx',
      'web/app/claim/[token]/page.tsx',
    ]) {
      assert.doesNotMatch(read(f), /useFeatures|featureOn/, f);
    }
  });

  it('exits are never gated: cancels, unfollow, deletes, decline, winners, earnings', () => {
    const exits = [
      'web/app/api/tasks/[ref]/cancel/route.ts',
      'web/app/api/tasks/[ref]/winners/route.ts',
      'web/app/api/nfts/offers/decline/route.ts',
      'web/app/api/tokens/[symbol]/theses/[id]/route.ts',
      'web/app/api/tokens/[symbol]/theses/[id]/comments/[commentId]/route.ts',
      'web/app/api/earnings/route.ts',
      'web/app/api/claim/payout/route.ts',
    ];
    for (const f of exits) assert.doesNotMatch(read(f), /featureOn|pausedBody/, f);
    // Unfollow and the follow settings keep working; only a new follow is refused.
    const follow = read('web/app/api/u/[username]/follow/route.ts');
    for (const m of ['DELETE', 'PATCH']) {
      const body = follow.slice(follow.indexOf(`export async function ${m}(`));
      assert.doesNotMatch(body.slice(0, body.indexOf('\n}\n')), /featureOn/, m);
    }
  });

  it('sending an NFT you hold and claiming stay open in chat', () => {
    const router = read('lib/router.js');
    // An NFT send is an ordinary send (parseNftSendCommand hands it to handleSend).
    assert.match(router, /const nftSend = parseNftSendCommand\(text\);[\s\S]{0,800}?await handleSend\(/);
    for (const fn of ['handleSend', 'handleSendResolved']) {
      const i = router.indexOf(`async function ${fn}(`);
      assert.ok(i >= 0, fn);
      const body = router.slice(i, router.indexOf('\n}\n', i));
      assert.doesNotMatch(body, /featureOn/, fn);
    }
    assert.doesNotMatch(read('lib/handlers/claims.js'), /featureOn/);
  });
});

describe('withdrawing mint sales from the site', () => {
  it('reads this wallet\'s drop credits and withdraws them through runMintTx, never paused', () => {
    const route = read('web/app/api/earnings/route.ts');
    assert.match(route, /const credit = await readCredits\(ctx\.provider, drop\.drop, DROP_IFACE, viewer\.address\);\s*if \(credit === 0n\) throw new MintError\('Nothing to withdraw\.'\);/);
    assert.match(route, /calls: \[\{ target: drop\.drop, value: 0n, data: DROP_IFACE\.encodeFunctionData\('withdraw', \[\]\) \}\],/);
    assert.match(route, /const denied = rejectIfCrossOrigin\(req\);/);
    assert.match(route, /await runMintTx\(\{/);
    const abi = read('web/lib/mintDrop.ts');
    assert.match(abi, /'function credits\(address\) view returns \(uint256\)',\s*'function withdraw\(\)',/);
    assert.match(read('contracts/src/mint/FlizyDrop.sol'), /function withdraw\(\) external nonReentrant \{\s*uint256 amount = credits\[msg\.sender\];/);
  });

  it('the wallet card withdraws mint sales here and NFT sales through the market', () => {
    const card = read('web/components/WalletEarnings.tsx');
    assert.match(card, /const url = source === 'market' \? '\/api\/market\/withdraw' : '\/api\/earnings';/);
    assert.match(card, /if \(!rows\.length && !msg\) return null;/);
  });
});
