/**
 * Claim amount display (ETH and listed tokens).
 * Run: node --test test/claimAmount.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  claimAssetSymbol,
  formatClaimAmount,
  isNativeClaim,
  isNftClaim,
} = require('../lib/claimAmount');
const { buildClaimPlan, formatClaimPlanPreview, assertPlanFunded } = require('../lib/engine/plan');
const { createSendIntent } = require('../lib/engine/intent');
const { formatClaimClaimedNotice, formatClaimsMenu } = require('../lib/claims');
const { formatClaimHistoryLabel } = require('../lib/claimHistoryLabel');
const { resolveListedSendAsset, listedSendSymbols } = require('../lib/dex');

const actor = {
  accountId: 'a1',
  waSenderId: '2348000000000',
  isAdmin: false,
  sessionUnlocked: true,
  hasPin: false,
};

describe('claimAssetSymbol / formatClaimAmount', () => {
  it('defaults to ETH', () => {
    assert.equal(claimAssetSymbol({}), 'ETH');
    assert.equal(formatClaimAmount({ amount_eth: '0.01' }), '0.01 ETH');
    assert.equal(isNativeClaim({ amount_eth: '0.01' }), true);
  });

  it('renders listed tokens from the row', () => {
    assert.equal(formatClaimAmount({ amount_eth: '10', asset: 'FLZ' }), '10 FLZ');
    assert.equal(
      isNativeClaim({ amount_eth: '10', asset: 'FLZ', token_address: '0x' + '11'.repeat(20) }),
      false
    );
  });

  it('renders NFT holds as ticker #id', () => {
    const row = {
      amount_eth: '1',
      asset: 'GIWAFORGE',
      token_address: '0x' + '11'.repeat(20),
      nft_token_id: '1842',
    };
    assert.equal(formatClaimAmount(row), 'giwaforge #1842');
    assert.equal(isNftClaim(row), true);
    assert.equal(isNativeClaim(row), false);
  });
});

describe('listed send assets', () => {
  it('lists ETH and FLZ only', () => {
    assert.deepEqual(listedSendSymbols(), ['ETH', 'FLZ']);
  });

  it('resolves ETH as native', () => {
    const a = resolveListedSendAsset('eth');
    assert.equal(a.native, true);
    assert.equal(a.symbol, 'ETH');
    assert.equal(a.tokenAddress, null);
  });

  it('resolves FLZ to the listed contract', () => {
    const a = resolveListedSendAsset('FLZ');
    assert.equal(a.native, false);
    assert.equal(a.symbol, 'FLZ');
    assert.match(a.tokenAddress, /^0x[a-fA-F0-9]{40}$/);
  });

  it('rejects unknown symbols and raw 0x paste', () => {
    const refused = /Only ETH and FLZ can be sent on socials/;
    assert.throws(() => resolveListedSendAsset('USDC'), refused);
    const raw = '0x308be8f71DA695f18E70D2243A446e1fD1566BA6';
    assert.throws(() => resolveListedSendAsset(raw), (err) => {
      assert.match(err.message, refused);
      assert.match(err.message, /Other tokens can be traded on the site./);
      assert.doesNotMatch(err.message, /308be8/i);
      return true;
    });
  });
});

describe('FLZ claim plan', () => {
  it('preview names FLZ, not ETH', () => {
    const { platformRecipient } = require('../lib/claimRecipient');
    const intent = createSendIntent({
      actor,
      amountEth: '10',
      toLabel: '@alice_crypto (Telegram)',
      asset: 'FLZ',
    });
    const recipient = platformRecipient('telegram', '111222333', 'alice_crypto');
    const tokenAddress = resolveListedSendAsset('FLZ').tokenAddress;
    const plan = buildClaimPlan({
      intent,
      policy: { decision: 'ALLOW_WITH_CONFIRM' },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      recipient,
      fromBalanceEth: '1',
      tokenAddress,
      tokenSymbol: 'FLZ',
      tokenBalance: '20',
    });
    assert.equal(plan.input.asset, 'FLZ');
    assert.equal(plan.route.tokenAddress, tokenAddress);
    const preview = formatClaimPlanPreview(plan);
    assert.match(preview, /10 FLZ/);
    assert.doesNotMatch(preview, /Amount:\s+10 ETH/);
    // Steps live on the plan record; the preview stopped printing them.
    assert.match(plan.steps.join(' '), /Hold 10 FLZ/);

    const funded = assertPlanFunded(plan, '1', '0.0001', { tokenBalance: '20' });
    assert.equal(funded.ok, true);
    const short = assertPlanFunded(plan, '1', '0.0001', { tokenBalance: '1' });
    assert.equal(short.ok, false);
    assert.match(short.message, /Not enough FLZ/);
  });
});

describe('NFT claim plan', () => {
  it('preview names the NFT, not 1 ETH', () => {
    const { platformRecipient } = require('../lib/claimRecipient');
    const intent = createSendIntent({
      actor,
      amountEth: '1',
      toLabel: '@bob (Telegram)',
      asset: 'GIWAFORGE',
    });
    const recipient = platformRecipient('telegram', '111222333', 'bob');
    const plan = buildClaimPlan({
      intent,
      policy: { decision: 'ALLOW_WITH_CONFIRM' },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      recipient,
      fromBalanceEth: '1',
      tokenAddress: '0x' + '11'.repeat(20),
      tokenSymbol: 'GIWAFORGE',
      nftTokenId: '1842',
    });
    assert.equal(plan.route.nftTokenId, '1842');
    const preview = formatClaimPlanPreview(plan);
    assert.match(preview, /giwaforge #1842/);
    assert.doesNotMatch(preview, /Amount:\s+1 ETH/);
    // The plan record still carries its steps; the preview no longer prints them.
    assert.match(plan.steps.join(' '), /Hold giwaforge #1842/);

    const funded = assertPlanFunded(plan, '1', '0.0001', { nftOwned: true });
    assert.equal(funded.ok, true);
    const missing = assertPlanFunded(plan, '1', '0.0001', { nftOwned: false });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /You do not hold giwaforge #1842/);
  });
});

describe('claim copy uses the row asset', () => {
  it('menu and claimed notice say FLZ', () => {
    const menu = formatClaimsMenu(
      [
        {
          to_channel: 'telegram',
          to_external_id: '1',
          to_display_handle: 'alice',
          amount_eth: '10',
          asset: 'FLZ',
          created_at: new Date().toISOString(),
        },
      ],
      'outgoing'
    );
    assert.match(menu, /10 FLZ/);
    assert.doesNotMatch(menu, /10 ETH/);

    const notice = formatClaimClaimedNotice({
      amountEth: '10',
      asset: 'FLZ',
      byLabel: '@bob',
      viaLine: 'Telegram @alice',
    });
    assert.match(notice, /10 FLZ claimed by @bob/);
    assert.doesNotMatch(notice, /10 ETH claimed/);
  });

  it('history label uses FLZ', () => {
    const t = formatClaimHistoryLabel(
      {
        amount_eth: '10',
        asset: 'FLZ',
        status: 'claimed',
        to_channel: 'telegram',
        to_display_handle: 'alice',
        to_external_id: '1',
      },
      { role: 'sender', status: 'claimed' }
    );
    assert.match(t, /10 FLZ/);
    assert.doesNotMatch(t, /10 ETH/);
  });

  it('menu and claimed notice say giwaforge #1842', () => {
    const menu = formatClaimsMenu(
      [
        {
          to_channel: 'telegram',
          to_external_id: '1',
          to_display_handle: 'bob',
          amount_eth: '1',
          asset: 'GIWAFORGE',
          nft_token_id: '1842',
          created_at: new Date().toISOString(),
        },
      ],
      'outgoing'
    );
    assert.match(menu, /giwaforge #1842/);
    assert.doesNotMatch(menu, /1 GIWAFORGE/);

    const notice = formatClaimClaimedNotice({
      amountEth: '1',
      asset: 'GIWAFORGE',
      nftTokenId: '1842',
      byLabel: '@bob',
      viaLine: 'Telegram @bob',
    });
    assert.match(notice, /giwaforge #1842 claimed by @bob/);
  });
});
