/**
 * Explore, NFTs: every tab opens something, the cards show only what the chain
 * says, and the artwork the card points at is there.
 *
 * The component needs a browser to render, so this reads its source, the same
 * way test/exploreTasksUi does.
 *
 * Run: node --test test/exploreNftsUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');
const NFTS = read('components', 'ExploreNfts.tsx');

describe('tabs', () => {
  it('has Listed, Trending, New, Top and Copy Mint, the unbuilt ones saying Coming soon', () => {
    assert.match(NFTS, /const \[LISTED, COPY_MINT\] = NFT_VIEWS;/);
    for (const id of ['trending', 'new', 'top']) {
      assert.match(NFTS, new RegExp(`\\{ id: '${id}', label: '[A-Z][a-z]+' \\}`), id);
      assert.match(NFTS, new RegExp(`tab === '${id}' \\? <ComingSoonPanel`), id);
    }
    assert.match(NFTS, /tab === 'mint' \? <CopySetupPanel kind="mint" \/>/);
  });
});

describe('collection cards', () => {
  it('lists only what /api/nfts returns, with no made-up collections or prices', () => {
    assert.match(NFTS, /fetch\('\/api\/nfts'\)/);
    for (const invented of ['Flizy Pals', 'Flizy Pass', 'Flizy Genesis', 'Floor Price']) {
      assert.ok(!NFTS.includes(invented), `${invented} is on the page`);
    }
    assert.match(NFTS, /label="Mint price"/);
  });

  it('reads items and owners from the chain, with a bounded fallback when logs are refused', () => {
    const lib = read('lib', 'listedNfts.ts');
    assert.match(lib, /nft\.queryFilter\(nft\.filters\.Transfer\(\)\)\.catch\(\(\) => null\)/);
    assert.match(lib, /const OWNER_SCAN_MAX = 1000;/);
    assert.match(lib, /if \(owners == null && supply != null && Number\(supply\) <= OWNER_SCAN_MAX\)/);
    // A figure that could not be read stays empty rather than becoming a zero.
    assert.match(lib, /owners = readAll \? holders\.size : null;/);
  });

  it('still lists a collection whose stats could not be read', () => {
    const route = read('app', 'api', 'nfts', 'route.ts');
    assert.match(route, /loadCollectionStats\(provider, col\)\.catch\(\(\) => \(\{[\s\S]{0,160}items: null,\s*owners: null,/);
  });

  it('ships the GiwaForge artwork the card points at', () => {
    const rel = 'public/explore/nft-giwaforge.png';
    const b = fs.readFileSync(path.join(WEB, rel));
    assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20)], [378, 187]);
    assert.match(NFTS, /giwaforge: '\/explore\/nft-giwaforge\.png'/);
  });

  it('keeps the card menu where it is drawn: .hit-44 would make the button relative', () => {
    assert.match(NFTS, /<span className="absolute right-\[8px\] top-\[8px\]">\s*<button[\s\S]{0,200}className="hit-44 flex h-\[20px\]/);
  });
});

describe('the mint warning', () => {
  it('opens short, and Read Guide shows it in full', () => {
    assert.match(NFTS, /const \[guideOpen, setGuideOpen\] = useState\(false\);/);
    assert.match(NFTS, /onClick=\{\(\) => setGuideOpen\(\(open\) => !open\)\}\s+aria-expanded=\{guideOpen\}/);
    assert.match(NFTS, /\{guideOpen \? 'Show less' : 'Read Guide'\}/);
    assert.match(NFTS, /className=\{`m-0 \$\{guideOpen \? '' : 'line-clamp-2'\}`\}/);
    // Every line of the warning is still there once opened.
    for (const line of ['The name proves nothing.', 'compare its contract', 'never ask you to approve a contract']) {
      assert.ok(NFTS.includes(line), line);
    }
  });
});
