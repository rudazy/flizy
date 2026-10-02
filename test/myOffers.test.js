/**
 * Offers on both sides: the offers a wallet made (expired ones included, each
 * cancellable for its full amount), the offers it can accept, declining, the
 * My NFTs page, and the numbered list in chat.
 *
 * Routes, screens and the chat handler need a runtime, so they are read from
 * source, the same way test/nftMarketRoutes does.
 *
 * Run: node --test test/myOffers.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');
const ROUTE = read('app', 'api', 'nfts', 'offers', 'route.ts');
const BOOK = read('lib', 'offerBook.ts');
const DECLINE = read('app', 'api', 'nfts', 'offers', 'decline', 'route.ts');
const CARD = read('components', 'WalletOffers.tsx');
const PROFILE = read('components', 'NftProfile.tsx');
const SHEET = read('components', 'NftTradeSheet.tsx');
const ITEM_ROUTE = read('app', 'api', 'nfts', 'collections', '[address]', 'tokens', '[tokenId]', 'route.ts');
const ITEM = read('components', 'NftItem.tsx');
const BALANCES = read('components', 'WalletBalances.tsx');
const ROUTER = fs.readFileSync(path.join(__dirname, '..', 'lib', 'router.js'), 'utf8');
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20261002140000_nft_offer_declines.sql'),
  'utf8'
);

describe('GET /api/nfts/offers', () => {
  it('needs a session, hides internal errors, and answers with both sides of the book', () => {
    assert.match(ROUTE, /if \(!accountId\) return NextResponse\.json\(\{ error: 'Not logged in' \}, \{ status: 401 \}\)/);
    assert.match(ROUTE, /apiErrorBody\(ROUTE, err\)/);
    assert.match(ROUTE, /offerBook\(ctx, accountId, viewer\.address\)/);
  });
});

describe('offer book', () => {
  it("made: only the wallet's own offers, expired ones kept", () => {
    assert.match(BOOK, /all\.filter\(\(o\) => o\.maker === wallet\)/);
    assert.match(BOOK, /expired: Number\(onChain\.expiry\) < nowSec,/);
  });

  it('received: unexpired, not declined, on NFTs the wallet holds, never its own', () => {
    for (const rule of ['o.maker !== wallet', 'o.expiry >= nowSec', '!declined.has(o.offerId)', 'heldTokens.has(listingKey(o.collection, o.tokenId))', 'heldByCollection.has(o.collection)']) {
      assert.ok(BOOK.includes(rule), rule);
    }
  });

  it('re-reads every offer, and the ownership of a received one, from the chain', () => {
    assert.match(BOOK, /const onChain = await market\.getOffer\(o\.offerId\)/);
    assert.match(BOOK, /if \(!onChain \|\| onChain\.maker === ethers\.ZeroAddress\) return null;/);
    assert.match(BOOK, /if \(owner !== wallet\) return null;/);
  });

  it('carries the royalty rate, rounded up, so accepting can pass a ceiling that covers it', () => {
    assert.match(BOOK, /royaltyBps = amount > 0n \? Number\(\(BigInt\(due\) \* 10_000n \+ amount - 1n\) \/ amount\) : 0;/);
  });

  it('is bounded', () => {
    assert.match(BOOK, /const MAX_OFFERS = 100;/);
    assert.match(BOOK, /const WALLET_PAGES = 3;/);
  });
});

describe('declining', () => {
  it('keeps one row per account, marketplace and offer, service role only', () => {
    assert.match(MIGRATION, /primary key \(account_id, marketplace, offer_id\)/);
    assert.match(MIGRATION, /revoke all on table public\.nft_offer_declines from anon, authenticated;/);
    assert.match(MIGRATION, /raise exception/);
  });

  it('is same-origin, needs a session, and only the one who could accept may decline', () => {
    assert.ok(DECLINE.indexOf('rejectIfCrossOrigin(req)') < DECLINE.indexOf('getAccountIdFromCookie()'));
    assert.match(DECLINE, /nft\.ownerOf\(tokenId\)\.then\(\(o: string\) => ethers\.getAddress\(o\) === viewer\.address\)/);
    assert.match(DECLINE, /nft\.balanceOf\(viewer\.address\)\.then\(\(b: bigint\) => BigInt\(b\) > 0n\)/);
    assert.match(DECLINE, /if \(!canAccept\) return NextResponse\.json\(\{ error: 'Only the owner can decline this offer\.' \}, \{ status: 403 \}\);/);
  });

  it('tells the maker once, and a failed notice never fails the decline', () => {
    assert.match(DECLINE, /if \(error\?\.code === '23505'\) return NextResponse\.json\(\{ ok: true, declined: true \}\);/);
    assert.match(DECLINE, /await notifyAllChannels\(\s*makerAccount\.id,\s*formatOfferDeclined\(/);
    assert.match(DECLINE, /\} catch \{\s*console\.warn\(`\[\$\{ROUTE\}\] decline notice was not queued`\);/);
  });

  it('declined offers leave the item page too', () => {
    assert.match(ITEM_ROUTE, /\.filter\(\(o\) => !declined\.has\(o\.offerId\)\)/);
  });
});

describe('My NFTs page', () => {
  it('has items, offers received and offers made', () => {
    for (const label of ["label: 'Items'", "label: 'Offers received'", "label: 'Offers made'"]) assert.ok(PROFILE.includes(label), label);
  });

  it('accepts through the password sheet with the royalty ceiling, and lets a collection offer pick the NFT', () => {
    assert.match(PROFILE, /action: 'offer-accept',/);
    assert.match(PROFILE, /royaltyBps: o\.royaltyBps,/);
    assert.match(PROFILE, /offer\.myTokenIds\.map\(\(id\) =>/);
  });

  it('declines only after a second tap, and says what declining does', () => {
    assert.ok(PROFILE.includes("confirming ? 'Sure?' : 'Decline'"));
    assert.ok(PROFILE.includes('Their ETH stays theirs until they cancel.'));
  });

  it('cancels its own offers through the password sheet', () => {
    assert.match(PROFILE, /action: 'offer-cancel', offerId: o\.offerId, name: what, amountWei: o\.amountWei/);
  });
});

describe('Your offers card', () => {
  it('sits in the wallet under the NFTs, behind the same eye, and links to My NFTs', () => {
    assert.match(BALANCES, /<WalletNfts chainName=\{chainName\} hidden=\{hidden\} \/>\s*<WalletOffers hidden=\{hidden\} \/>/);
    assert.match(CARD, /hidden \? HIDDEN : `\$\{ethFromWei\(o\.amountWei\)\} ETH`/);
    assert.match(CARD, /href="\/dashboard\/explore\/nfts\/me\?tab=made"/);
    assert.match(CARD, /body\.made/);
  });

  it('tells the maker an expired offer still holds their ETH, and cancels through the sheet', () => {
    assert.ok(CARD.includes('Expired. Cancel it to get your ETH back.'));
    assert.match(CARD, /setIntent\(\{ action: 'offer-cancel', offerId: o\.offerId, name: what, amountWei: o\.amountWei \}\)/);
  });
});

describe('cancel sheet', () => {
  it('shows a full refund, not a sale breakdown', () => {
    assert.match(SHEET, /intent\.action !== 'offer-cancel' \? \(/);
    assert.ok(SHEET.includes('label="Back to your wallet"'));
    assert.ok(SHEET.includes('No fee is taken.'));
  });
});

describe('item page', () => {
  it("keeps the viewer's own expired offers so they can cancel them", () => {
    assert.match(ITEM_ROUTE, /\(o\.expiry >= nowSec \|\| o\.maker === viewer\.address\)/);
    assert.ok(ITEM.includes("{o.expiry * 1000 < Date.now() ? ' · expired' : ''}"));
  });

  it('only counts offers that can still be accepted as the best offer', () => {
    assert.match(ITEM, /const liveOffers = data\.offers\.filter\(\(o\) => o\.expiry \* 1000 >= Date\.now\(\)\);/);
  });
});

describe('chat list', () => {
  const list = ROUTER.slice(ROUTER.indexOf('async function handleAcceptOffer'), ROUTER.indexOf('async function previewAcceptOffer'));

  it('lists the offers numbered, leaves out declined ones, and points to the site to decline', () => {
    assert.match(list, /\.from\('nft_offer_declines'\)/);
    assert.match(list, /declined: new Set\(/);
    assert.match(list, /options\.map\(\(o, i\) => `\$\{i \+ 1\}\. \$\{o\.label\}`\)/);
    assert.ok(list.includes('To decline an offer or see them all:'));
    assert.match(list, /buttons: numberButtons\(options\.length\)/);
  });

  it('a picked number opens the sale preview, which still needs CONFIRM and the PIN', () => {
    assert.match(ROUTER, /if \(choice\.kind === 'acceptOffer' && picked\.offer\) \{\s*await previewAcceptOffer\(ctx, user, choice, picked\);/);
    const preview = ROUTER.slice(ROUTER.indexOf('async function previewAcceptOffer'));
    assert.match(preview, /pendingSends\.set\(ctx\.key, \{ plan, createdAt: Date\.now\(\), needsSecret: true \}\);/);
  });
});
