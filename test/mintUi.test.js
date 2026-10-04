/**
 * Flizy Mint screens, read from source as the other UI tests do:
 *   - NFTs is Discover | Mint | Collections and Copy Mint stays under Discover;
 *   - every paid Flizy-managed price shows the Flizy fee and what the creator
 *     receives, and a free mint says it has no fee;
 *   - Contract-managed mints say plainly that the contract sets the rules;
 *   - unverified collections are labelled;
 *   - every on-chain action goes through the password sheet;
 *   - no blue in any new screen.
 *
 * Run: node --test test/mintUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const C = path.join(__dirname, '..', 'web', 'components');
const read = (f) => fs.readFileSync(path.join(C, f), 'utf8');
const NEW = ['MintPanel.tsx', 'MintList.tsx', 'MintCollections.tsx', 'MintCreate.tsx', 'MintManage.tsx', 'MyMints.tsx', 'MintActionSheet.tsx'];

describe('NFT sections', () => {
  const src = read('ExploreNfts.tsx');
  it('Discover, Mint and Collections, with Copy Mint kept under Discover', () => {
    for (const label of ['Discover', 'Mint', 'Collections']) assert.match(src, new RegExp(`label: '${label}'`));
    assert.match(src, /tab === 'mint' \? <CopySetupPanel kind="mint" \/>/);
    assert.match(src, /section === 'mint' \? <MintList \/> : <MintCollections \/>/);
  });

  it('existing ?view= links still pick the Discover tab', () => {
    assert.match(src, /search\.get\('view'\)/);
    assert.match(src, /search\.get\('nft'\)/);
  });
});

describe('no hidden fee', () => {
  it('the creator sees price, Flizy fee and what they receive', () => {
    const src = read('MintManage.tsx');
    assert.match(src, /Mint price <span/);
    assert.match(src, /Flizy fee \(2%\) <span/);
    assert.match(src, /You receive <span/);
    assert.match(src, /Free mint: no Flizy fee/);
  });

  it('the minter sees the fee inside the price and what the creator gets', () => {
    const src = read('MintPanel.tsx');
    assert.match(src, /Flizy fee \(\$\{bpsLabel\(d\.feeBps\)\}, included\)/);
    assert.match(src, /label="Creator receives"/);
    assert.match(src, /label="You pay"/);
  });
});

describe('honest labels', () => {
  it('Contract-managed mints say the contract sets the rules and Flizy takes no fee', () => {
    const src = read('MintPanel.tsx');
    assert.match(src, /set by the contract, not by Flizy, and Flizy takes no fee on this mint/);
    assert.match(read('MintCreate.tsx'), /Flizy cannot add phases or an allowlist to it/);
  });

  it('unverified collections are labelled where they are shown', () => {
    assert.match(read('MintPanel.tsx'), /Not verified by Flizy/);
    assert.match(read('MintList.tsx'), /Not verified/);
    assert.match(read('MintCollections.tsx'), /'Not verified'/);
  });
});

describe('every on-chain action takes the password', () => {
  it('the sheet posts the password with the body', () => {
    const src = read('MintActionSheet.tsx');
    assert.match(src, /<PasswordField label="Account password"/);
    assert.match(src, /body: JSON\.stringify\(\{ \.\.\.body, password \}\)/);
  });

  it('mint, create, configure, publish and pause go through the sheet', () => {
    assert.match(read('MintPanel.tsx'), /url=\{`\/api\/mints\/\$\{d\.collection\}\/mint`\}/);
    assert.match(read('MintCreate.tsx'), /url="\/api\/mints\/collections"/);
    const manage = read('MintManage.tsx');
    for (const action of ['configure', 'publish', 'pause']) {
      assert.match(manage, new RegExp(`url=\\{\`/api/mints/\\$\\{drop\\.collection\\}/${action}\`\\}`), action);
    }
  });
});

describe('palette', () => {
  it('no blue in any new screen', () => {
    for (const f of NEW) {
      const src = read(f);
      assert.doesNotMatch(src, /\b(blue|sky|cyan|indigo|teal|navy)-\d{2,3}\b/i, f);
      assert.doesNotMatch(src, /#(44dcea|8c8fe8|3b82f6|0ea5e9|06b6d4|6366f1)/i, f);
    }
  });
});
