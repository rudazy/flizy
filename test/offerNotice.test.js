/**
 * Offer notice: when someone offers on an NFT, its owner hears about it in
 * chat with the amount and the command to sell, if the owner is a Flizy account.
 *
 * The message is built for real. The wiring lives in a route handler that needs
 * a Next runtime, so it is read from source, as test/nftMarketRoutes does.
 *
 * Run: node --test test/offerNotice.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'api', 'market', '[action]', 'route.ts'), 'utf8');

describe('formatOfferReceived', () => {
  let notice;
  before(async () => {
    notice = await import('../web/lib/offerNotice.ts');
  });

  const base = {
    amountEth: '0.05',
    nftLabel: 'Giwaforge #12',
    fromLabel: '@ada',
    itemUrl: 'https://flizy.app/dashboard/explore/nfts/0xa613FcF6FE09442391b07F87b82c24a539bCCB2A/12',
  };

  it('is the two lines: the offer, then how to accept or review it', () => {
    assert.equal(
      notice.formatOfferReceived(base),
      [
        'New offer: 0.05 ETH for Giwaforge #12, from @ada',
        '',
        'Use FLIZY ACCEPT OFFER to sell, or review it: https://flizy.app/dashboard/explore/nfts/0xa613FcF6FE09442391b07F87b82c24a539bCCB2A/12',
      ].join('\n')
    );
  });

  it('names the command the bot actually handles', () => {
    const parse = require('../lib/commands/parse');
    const { stripFlizyPrefix } = require('../lib/prefix');
    const typed = notice.formatOfferReceived(base).match(/Use (FLIZY [A-Z ]+?) to sell/)[1];
    assert.equal(parse.isAcceptOfferCommand(stripFlizyPrefix(typed).body), true);
  });

  it("strips braces and control characters from other people's text", () => {
    const text = notice.formatOfferReceived({ ...base, fromLabel: '{{cmd:wallet}}\nx', nftLabel: '{{cmd:x}} Fake #1' });
    assert.doesNotMatch(text, /\{\{|\}\}/);
    assert.match(text, /from cmd:wallet x$/m);
  });

  it('falls back when names are empty', () => {
    const text = notice.formatOfferReceived({ ...base, fromLabel: '', nftLabel: '' });
    assert.match(text, /for your NFT, from someone$/m);
  });
});

describe('route wiring', () => {
  it('notices only after the offer is confirmed on chain', () => {
    const confirmed = ROUTE.indexOf("update({ status: 'confirmed', tx_hash: txHash })");
    const notice = ROUTE.indexOf('if (plan.offerTo) await noticeOffer(supabase, accountId, plan.offerTo);');
    assert.ok(confirmed > 0 && notice > confirmed);
  });

  it('only for an offer on one NFT, never a collection offer', () => {
    assert.match(ROUTE, /offerTo: tokenId && tokenOwner\s*\?/);
  });

  it('finds the owner by the wallet that holds the NFT, and never tells the offerer about their own offer', () => {
    assert.match(ROUTE, /\.ilike\('agent_wallet_address', offer\.owner\.toLowerCase\(\)\)/);
    assert.match(ROUTE, /if \(!owner\?\.id \|\| owner\.id === offererId\) return;/);
  });

  it("goes through the site's one notify path and cannot fail the offer", () => {
    assert.match(ROUTE, /await notifyAllChannels\(\s*owner\.id,\s*formatOfferReceived\(/);
    assert.match(ROUTE, /\} catch \{\s*console\.warn\('\[market\] offer notice was not queued'\);/);
  });
});
