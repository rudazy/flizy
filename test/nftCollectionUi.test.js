/**
 * NFT marketplace screens: the collection page has every part of the design,
 * every trade shows its full split before the password, nothing on the
 * screens is blue, and the wallet lists every NFT, not only verified ones.
 *
 * The screens are client components that need a browser to render, so this
 * reads their source, the same way test/exploreNftsUi does. The formatters
 * run for real.
 *
 * Run: node --test test/nftCollectionUi.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const COLLECTION = read('components/NftCollection.tsx');
const ITEM = read('components/NftItem.tsx');
const SHEET = read('components/NftTradeSheet.tsx');
const LIST = read('components/NftCollectionList.tsx');
const WALLET_NFTS = read('components/WalletNfts.tsx');
const EXPLORE = read('components/ExploreNfts.tsx');
const CHART = read('components/NftFloorChart.tsx');

describe('Explore NFTs tab', () => {
  it('opens the real collection page and the full list, not Coming soon', () => {
    assert.match(EXPLORE, /href=\{`\/dashboard\/explore\/nfts\/\$\{collection\.address\}`\}/);
    assert.match(EXPLORE, /href="\/dashboard\/explore\/nfts"/);
    assert.doesNotMatch(EXPLORE, /comingSoon\('Collection page'\)|comingSoon\('All collections'\)/);
  });
});

describe('collection page', () => {
  it('has the five tabs from the design', () => {
    for (const label of ['Items', 'Activity', 'Holders', 'Traits', 'About']) {
      assert.match(COLLECTION, new RegExp(`label: '${label}'`), label);
    }
  });

  it('shows floor, volume and owners, and the royalty chip traders see', () => {
    for (const label of ['Floor price', 'Total volume', 'Owners']) assert.ok(COLLECTION.includes(`label="${label}"`), label);
    assert.match(COLLECTION, /`\$\{bpsLabel\(m\.royaltyBps\)\} Royalties`/);
    assert.match(COLLECTION, /'No royalties'/);
  });

  it('has Buy Floor and Make Offer, Live floor with View chart, and Featured', () => {
    for (const text of ['Buy Floor', 'Make Offer', 'Live floor', 'View chart', 'Featured']) assert.ok(COLLECTION.includes(text), text);
    assert.match(COLLECTION, /action: 'offer', collection: address, tokenId: null/);
  });

  it('has the filter, sort and layout controls', () => {
    for (const text of ["label: 'All items'", "label: 'Price: Low to High'", "label: 'My items'", 'Search by name or trait']) {
      assert.ok(COLLECTION.includes(text), text);
    }
  });

  it('marks collections Flizy has not verified', () => {
    assert.ok(COLLECTION.includes('Not verified by Flizy'));
    assert.ok(COLLECTION.includes('cannot be sent in chat'));
  });

  it('keeps grid columns from growing to their content', () => {
    assert.match(COLLECTION, /grid grid-cols-\[minmax\(0,1fr\)\] gap-\[14px\]/);
    assert.match(COLLECTION, /<article className="relative min-w-0 /);
  });

  it('positions the heart through a wrapper, since .hit-44 sets position on the button', () => {
    assert.match(COLLECTION, /<span className="absolute right-\[8px\] top-\[8px\]">\s*<button/);
  });

  it('sits the action bar above the tab bar on phones', () => {
    assert.match(COLLECTION, /bottom-\[calc\(var\(--app-nav-h\)\+var\(--app-nav-overhang\)\)\]/);
  });
});

describe('every trade shows its split before the password', () => {
  it('names the 2% Flizy fee and the creator royalty', () => {
    assert.ok(SHEET.includes('Flizy fee (2%)'));
    assert.match(SHEET, /`Creator royalty \(\$\{bpsLabel\(Number\(capped\)\)\}\)`/);
    assert.match(SHEET, /const FEE_BPS = 200n;/);
  });

  it('shows the seller what they receive and the buyer what they pay', () => {
    assert.ok(SHEET.includes('label="You receive"'));
    assert.ok(SHEET.includes('label="You pay"'));
  });

  it('labels the dollar line as the mainnet rate on testnet ETH', () => {
    assert.ok(SHEET.includes('at the mainnet ETH price. This is {network} testnet ETH.'));
  });

  it('cannot submit without the password and posts to the market route', () => {
    assert.match(SHEET, /const ready = !busy && !!password/);
    assert.match(SHEET, /fetch\(`\/api\/market\/\$\{intent\.action\}`/);
  });

  it('a buy sends the price the person reviewed', () => {
    assert.match(SHEET, /priceWei: intent\.priceWei/);
  });
});

describe('item page', () => {
  it('offers buy, offer, list, cancel, accept and withdraw where they apply', () => {
    for (const text of ['Buy now', 'Make offer', 'List for sale', 'Change price', 'Cancel listing', 'Accept', 'from sales']) {
      assert.ok(ITEM.includes(text), text);
    }
  });
});

describe('no blue', () => {
  // Hues from cyan to violet, as hex, plus Tailwind's blue families.
  const BLUE_HEX = /#(8c8fe8|c9b8ff|44dcea)\b/i;
  const BLUE_CLASS = /\b(?:text|bg|border|from|to|via|fill|stroke)-(?:blue|sky|cyan|indigo|teal|violet)-\d/;
  for (const [name, src] of Object.entries({ COLLECTION, ITEM, SHEET, LIST, WALLET_NFTS, CHART })) {
    it(name, () => {
      assert.doesNotMatch(src, BLUE_HEX);
      assert.doesNotMatch(src, BLUE_CLASS);
    });
  }
});

describe('wallet', () => {
  it('lists every NFT the wallet holds from the explorer, and links each one', () => {
    assert.match(WALLET_NFTS, /fetch\(`\/api\/nfts\/mine/);
    assert.match(WALLET_NFTS, /href=\{`\/dashboard\/explore\/nfts\/\$\{n\.collection\}\/\$\{n\.tokenId\}`\}/);
    assert.ok(WALLET_NFTS.includes("can't be sent in chat"));
  });
});

describe('formatters', () => {
  let f;
  before(async () => {
    f = await import('../web/lib/nftFormat.ts');
  });

  it('formats wei as ETH and survives junk', () => {
    assert.equal(f.ethFromWei('98000000000000000'), '0.098');
    assert.equal(f.ethFromWei('120400000000000000000'), '120.4');
    assert.equal(f.ethFromWei(null), null);
    assert.equal(f.ethFromWei('x'), null);
  });

  it('computes USD in integer cents and hides without a rate', () => {
    assert.equal(f.usdLabel('98000000000000000', 2450.12), '≈ $240.11');
    assert.equal(f.usdLabel('120400000000000000000', 2450.12), '≈ $295K');
    assert.equal(f.usdLabel('1', null), null);
  });

  it('labels royalties and counts', () => {
    assert.equal(f.bpsLabel(500), '5%');
    assert.equal(f.bpsLabel(250), '2.5%');
    assert.equal(f.compactCount(2415), '2,415');
    assert.equal(f.compactCount(10000), '10K');
    assert.equal(f.compactCount(null), '-');
  });

  it('says how long ago', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    assert.equal(f.timeAgo('2026-10-02T11:59:30Z', now), 'just now');
    assert.equal(f.timeAgo('2026-10-02T11:00:00Z', now), '1h ago');
    assert.equal(f.timeAgo('2026-09-30T12:00:00Z', now), '2d ago');
    assert.equal(f.timeAgo(null, now), '');
  });

  it('shortens addresses', () => {
    assert.equal(f.shortAddr('0xa613FcF6FE09442391b07F87b82c24a539bCCB2A'), '0xa613...CB2A');
  });
});

describe('ETH/USD rate', () => {
  let rate;
  before(async () => {
    rate = await import('../web/lib/ethUsd.ts');
  });

  it('accepts a plausible mainnet price and nothing else', () => {
    assert.equal(rate.parseEthUsd({ ethereum: { usd: 2450.12 } }), 2450.12);
    assert.equal(rate.parseEthUsd({ ethereum: { usd: '2450' } }), null);
    assert.equal(rate.parseEthUsd({ ethereum: { usd: 0 } }), null);
    assert.equal(rate.parseEthUsd({ ethereum: { usd: 5e7 } }), null);
    assert.equal(rate.parseEthUsd(null), null);
  });

  it('returns null, not a guess, when the source fails', async () => {
    const usd = await rate.ethUsd(async () => {
      throw new Error('down');
    }, 1);
    assert.equal(usd, null);
  });
});
