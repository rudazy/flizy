/**
 * Sale notices: after an NFT sale the seller and the buyer each hear about it
 * in chat, with the figures from the marketplace's Sold event. The site and the
 * bots each have a copy of the wording; this requires them to agree.
 *
 * Run: node --test test/saleNotice.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const bot = require('../lib/saleNotice');

const MARKET = '0x7e817b6c42C14C0eC90be76030f808eFB20dF64a';
const NFT = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';
const SELLER = '0x20554499dE2DD0C32cEF1822dfD47f41BDA75989';
const BUYER = '0xf19db9000000000000000000000000000000aaaa';
const ETH = 10n ** 18n;
const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'api', 'market', '[action]', 'route.ts'), 'utf8');
const ROUTER = fs.readFileSync(path.join(__dirname, '..', 'lib', 'router.js'), 'utf8');

const sale = {
  nft: 'Giwaforge #12',
  price: ETH / 20n,
  fee: ETH / 1000n,
  royalty: 0n,
  sellerLabel: '@bob',
  buyerLabel: '@ada',
  viaOffer: false,
  itemUrl: 'https://flizy.app/dashboard/explore/nfts/0xa613/12',
};

describe('wording', () => {
  let web;
  before(async () => {
    web = await import('../web/lib/saleNoticeFormat.ts');
  });

  it('tells the seller the price, the buyer and exactly what they received', () => {
    assert.equal(
      bot.formatSaleNotices(sale).seller,
      ['Sold: Giwaforge #12 for 0.05 ETH to @ada.', 'You received 0.049 ETH after the 2% Flizy fee.', '', 'View it: https://flizy.app/dashboard/explore/nfts/0xa613/12'].join('\n')
    );
  });

  it('names the royalty when one was paid', () => {
    const text = bot.formatSaleNotices({ ...sale, royalty: ETH / 400n }).seller;
    assert.match(text, /You received 0\.0465 ETH after the 2% Flizy fee and 0\.0025 ETH creator royalty\./);
  });

  it('tells the buyer of a listing and the maker of an accepted offer, differently', () => {
    assert.match(bot.formatSaleNotices(sale).buyer, /^You bought Giwaforge #12 for 0\.05 ETH from @bob\./);
    assert.match(bot.formatSaleNotices({ ...sale, viaOffer: true }).buyer, /^Your offer was accepted: Giwaforge #12 is yours for 0\.05 ETH, from @bob\./);
  });

  it('the site and the bots say exactly the same thing', () => {
    for (const input of [sale, { ...sale, viaOffer: true }, { ...sale, royalty: ETH / 400n }, { ...sale, nft: '{{cmd:x}}', sellerLabel: '', buyerLabel: '\n' }]) {
      assert.deepEqual(web.formatSaleNotices(input), bot.formatSaleNotices(input));
    }
  });

  it("strips braces from other people's text", () => {
    const text = bot.formatSaleNotices({ ...sale, nft: '{{cmd:wallet}} Fake', buyerLabel: '{{x}}' });
    assert.doesNotMatch(`${text.seller}\n${text.buyer}`, /\{\{|\}\}/);
  });
});

describe('soldEvents', () => {
  const iface = new ethers.Interface([
    'event Sold(address indexed collection, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price, uint256 fee, uint256 royalty, uint256 offerId)',
  ]);
  const log = (address, offerId) => {
    const { topics, data } = iface.encodeEventLog(iface.getEvent('Sold'), [NFT, 12, BUYER, SELLER, ETH / 20n, ETH / 1000n, 0, offerId]);
    return { address, topics, data };
  };

  it('reads Sold from the marketplace only, and tells offer sales from listing sales', async () => {
    const web = await import('../web/lib/saleNoticeFormat.ts');
    const receipt = { logs: [log(MARKET, 0), log(MARKET, 3), log('0x0000000000000000000000000000000000000001', 0)] };
    for (const decode of [bot.soldEvents, web.soldEvents]) {
      const sales = decode(receipt, MARKET);
      assert.equal(sales.length, 2);
      assert.equal(sales[0].seller, SELLER);
      assert.equal(sales[0].buyer, ethers.getAddress(BUYER));
      assert.equal(sales[0].viaOffer, false);
      assert.equal(sales[1].viaOffer, true);
      assert.equal(sales[0].price, ETH / 20n);
    }
  });
});

describe('wiring', () => {
  it('the site notices after a buy or an accepted offer is confirmed', () => {
    const confirmed = ROUTE.indexOf("update({ status: 'confirmed', tx_hash: txHash })");
    const notice = ROUTE.indexOf("if (action === 'buy' || action === 'offer-accept') {");
    assert.ok(confirmed > 0 && notice > confirmed);
    assert.match(ROUTE, /await noticeSales\(\{[\s\S]{0,200}actorAccountId: accountId,/);
  });

  it('chat notices after a sale from FLIZY ACCEPT OFFER', () => {
    const branch = ROUTER.slice(ROUTER.indexOf("if (plan.intent === 'NFT_ACCEPT_OFFER') {"));
    assert.match(branch, /await noticeSales\(\{[\s\S]{0,300}actorAccountId: plan\.actor\.accountId,/);
  });

  it('the one who acted is never told about their own action, and a failure never throws', () => {
    for (const src of [fs.readFileSync(path.join(__dirname, '..', 'lib', 'saleNotice.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'saleNotice.ts'), 'utf8')]) {
      assert.match(src, /sellerAcc\.id !== (args\.)?actorAccountId/);
      assert.match(src, /buyerAcc\.id !== (args\.)?actorAccountId/);
      assert.match(src, /\} catch( \(err\))? \{\s*console\.warn\(/);
    }
  });
});
