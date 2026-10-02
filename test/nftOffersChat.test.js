/**
 * "flizy accept offer" in chat: which offer it finds, what it charges, and
 * that it never sells without CONFIRM and the unlock PIN.
 *
 * lib/nftOffers.js runs for real against encoded marketplace events. The
 * handler lives in lib/router.js, which needs a live runtime, so its wiring is
 * read from source, as test/pinRouteGate does.
 *
 * Run: node --test test/nftOffersChat.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const offers = require('../lib/nftOffers');
const parse = require('../lib/commands/parse');

const ROUTER = fs.readFileSync(path.join(__dirname, '..', 'lib', 'router.js'), 'utf8');
const NFT = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';
const MAKER = '0x20554499dE2DD0C32cEF1822dfD47f41BDA75989';
const ETH = 10n ** 18n;

let n = 0;
function log(name, args) {
  const iface = offers.MARKET_IFACE;
  const { topics, data } = iface.encodeEventLog(iface.getEvent(name), args);
  n += 1;
  return { topics, data, blockNumber: 100 + n, logIndex: 0 };
}

describe('fee and config', () => {
  it('matches FEE_BPS in the contract source', () => {
    const sol = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'src', 'market', 'FlizyMarketplace.sol'), 'utf8');
    assert.match(sol, /uint256 public constant FEE_BPS = 200;/);
    assert.equal(offers.FEE_BPS, 200n);
  });

  it('is off without a marketplace address', () => {
    assert.equal(offers.marketConfig({}), null);
    assert.deepEqual(offers.marketConfig({ CHAIN_GIWA_SEPOLIA_MARKETPLACE: NFT.toLowerCase(), CHAIN_GIWA_SEPOLIA_MARKETPLACE_FROM_BLOCK: '5' }), {
      address: NFT,
      fromBlock: 5,
    });
  });
});

describe('openTokenOffers', () => {
  it('keeps open offers on one token, newest first, and drops cancelled, accepted and collection offers', () => {
    const logs = [
      log('OfferMade', [1, NFT, MAKER, 12, false, ETH, 4_000_000_000]),
      log('OfferMade', [2, NFT, MAKER, 13, false, 2n * ETH, 4_000_000_000]),
      log('OfferMade', [3, NFT, MAKER, 0, true, ETH, 4_000_000_000]),
      log('OfferMade', [4, NFT, MAKER, 14, false, ETH, 4_000_000_000]),
      log('OfferCancelled', [4, MAKER]),
      log('OfferMade', [5, NFT, MAKER, 15, false, ETH, 4_000_000_000]),
      log('Sold', [NFT, 15, MAKER, NFT, ETH, 0, 0, 5]),
    ];
    const open = offers.openTokenOffers(logs.reverse());
    assert.deepEqual(
      open.map((o) => o.offerId),
      ['2', '1']
    );
    assert.equal(open[0].tokenId, '13');
    assert.equal(open[0].amount, 2n * ETH);
  });
});

describe('parseLogRows', () => {
  it('drops malformed explorer rows', () => {
    const good = { topics: [`0x${'11'.repeat(32)}`, null], data: '0x', block_number: 7, index: 1 };
    const rows = offers.parseLogRows({ items: [good, { topics: 'x' }, { ...good, data: 'zz' }, { ...good, block_number: 'x' }] });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].topics, [`0x${'11'.repeat(32)}`]);
  });
});

describe('the command', () => {
  it('is "accept offer", in any case, and a bare "accept" is not it', () => {
    assert.equal(parse.isAcceptOfferCommand('accept offer'), true);
    assert.equal(parse.isAcceptOfferCommand('ACCEPT OFFER'), true);
    assert.equal(parse.isFlizyCommandBody('accept offer'), true);
    assert.equal(parse.isAcceptOfferCommand('accept'), false);
  });
});

describe('router wiring', () => {
  const handler = ROUTER.slice(ROUTER.indexOf('async function handleAcceptOffer'), ROUTER.indexOf("\n/**\n * \"trade 100 flz\""));

  it('is dispatched', () => {
    assert.match(ROUTER, /if \(isAcceptOfferCommand\(text\)\) \{\s*await handleAcceptOffer\(ctx, user, account\);/);
  });

  it('refuses without an unlock PIN, and always asks for it after CONFIRM', () => {
    assert.match(handler, /if \(!siteAcc\.unlock_pin_hash\) \{/);
    assert.match(handler, /pendingSends\.set\(ctx\.key, \{ plan, createdAt: Date\.now\(\), needsSecret: true \}\);/);
  });

  it('shows the fee, the royalty and what the seller receives before anything is sent', () => {
    for (const line of ['Flizy fee (2%)', 'Creator royalty', 'You receive', 'Reply CONFIRM, then your unlock PIN. Or CANCEL.']) {
      assert.ok(handler.includes(line), line);
    }
  });

  it('only executes from handleConfirm, which takes the account lock first', () => {
    const confirm = ROUTER.slice(ROUTER.indexOf('async function handleConfirm'));
    const lock = confirm.indexOf("tryAccountTxLock(supabase, actorId, 'chat')");
    const branch = confirm.indexOf("if (plan.intent === 'NFT_ACCEPT_OFFER') {");
    assert.ok(lock > 0 && branch > lock);
    assert.match(confirm, /const result = await executeAcceptOfferPlan\(\{ plan, provider, chain \}\);/);
    assert.equal((ROUTER.match(/executeAcceptOfferPlan\(/g) || []).length, 1);
  });

  it("logs the sale under the site's kind, so the site's hourly cap and history count it", () => {
    const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine', 'executeAcceptOffer.js'), 'utf8');
    assert.match(engine, /kind: 'nft_market',/);
  });
});

describe('which offers chat looks at', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nftOffers.js'), 'utf8');

  it("reads the wallet's NFTs first, so market-wide offers cannot crowd out its own", () => {
    assert.match(src, /readHeldTokens\(explorerBaseUrl, owner, fetcher\)/);
    assert.match(src, /held\.has\(`\$\{o\.collection\.toLowerCase\(\)\}:\$\{o\.tokenId\}`\)/);
    const filter = src.indexOf('held.has(');
    const slice = src.indexOf('.slice(0, MAX_CANDIDATES)');
    assert.ok(filter > 0 && slice > filter, 'held filter must run before the candidate cap');
  });
});
