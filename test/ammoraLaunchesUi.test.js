/**
 * Ammora launches is its own Explore view. It never borrows a dollar price.
 *
 * Run: node --test test/ammoraLaunchesUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('ammora launches view', () => {
  const ui = read('web/components/AmmoraTokens.tsx');
  const explore = read('web/components/ExploreTokens.tsx');

  it('is its own view, and Discover no longer appends it', () => {
    assert.match(explore, /view === 'ammora' && ammoraOn \? 'ammora'/);
    assert.match(explore, /tab === 'ammora' \? <AmmoraTokens \/>/);
    assert.doesNotMatch(explore, /tab === 'discover' \? <AmmoraTokens/);
    assert.match(ui, /if \(!enabled\) return;[\s\S]*if \(!enabled\) return null;/);
  });

  it('says what the venue is, and never Verified, Graduated, or a dollar figure', () => {
    assert.match(ui, /Learn about Ammora/);
    assert.match(ui, /External venue/);
    assert.match(ui, /https:\/\/ammora\.org/);
    assert.match(ui, /Not tradable yet/);
    assert.match(ui, /Flizy has not reviewed these tokens/);
    assert.doesNotMatch(ui, /Verified|Graduated|\$\d|USD/);
    assert.match(ui, /token\.image/);
    assert.match(ui, /onError=\{\(\) => setFailed\(true\)\}/);
    assert.match(ui, /Price unavailable/);
    assert.match(ui, /Market cap unavailable/);
  });

  it('Trade opens the token page, and Buy there uses the Ammora venue', () => {
    assert.match(ui, /\/dashboard\/explore\/tokens\/\$\{token\.address\}/);
    assert.doesNotMatch(ui, /\/dashboard\/swap\?venue=ammora/);
    const detail = read('web/components/TokenDetail.tsx');
    assert.match(detail, /\/api\/ammora\/tokens/);
    assert.match(detail, /aria-label="Ammora token"/);
    assert.match(detail, /venue=\{ammora \? 'ammora' : null\}/);
    assert.match(detail, /Priced from the Ammora pool/);
    assert.match(detail, /Back to Ammora launches/);
    assert.match(detail, /const canTrade = ammora \? ammora\.tradable === true : poolTrade;/);
    const sheet = read('web/components/TokenTradeSheet.tsx');
    assert.match(sheet, /params\.set\('venue', 'ammora'\)/);
    assert.match(sheet, /venue: 'ammora'/);
    assert.match(sheet, /!amount \|\| venue === 'ammora'\) return;/);
    assert.match(sheet, /minOut: quote\?\.amountOutMin,\s*pin,/);
  });

  it('ships the coin artwork the hero points at', () => {
    const bytes = fs.readFileSync(path.join(ROOT, 'web/public/explore/ammora-coin.jpg'));
    assert.equal(bytes.toString('hex', 0, 3), 'ffd8ff');
    assert.match(ui, /src="\/explore\/ammora-coin\.jpg"/);
  });
});

describe('launch list', () => {
  const rows = [
    { address: '0xaaa', symbol: 'ZZ', name: 'Zed', status: 'active', tradable: true },
    { address: '0xbbb', symbol: 'AA', name: 'Alpha', status: 'ready to migrate', tradable: false },
    { address: '0xccc', symbol: 'MM', name: 'Moved', status: 'migrated', tradable: false },
  ];

  it('splits active, upcoming and not tradable, and leaves a price out of the sort', async () => {
    const list = await import('../web/lib/ammora/launchList.ts');
    assert.equal(list.launchPhase(rows[0]), 'active');
    assert.equal(list.launchPhase(rows[1]), 'upcoming');
    assert.equal(list.launchPhase(rows[2]), 'not_tradable');
    assert.deepEqual(
      list.filterLaunches(rows, { phase: 'all', query: '', sort: 'active' }).map((row) => row.symbol),
      ['ZZ', 'AA', 'MM']
    );
    assert.deepEqual(
      list.filterLaunches(rows, { phase: 'all', query: '', sort: 'name' }).map((row) => row.symbol),
      ['AA', 'MM', 'ZZ']
    );
    assert.deepEqual(
      list.filterLaunches(rows, { phase: 'upcoming', query: 'alpha', sort: 'name' }).map((row) => row.symbol),
      ['AA']
    );
    assert.deepEqual(list.filterLaunches(rows, { phase: 'active', query: '0xccc', sort: 'name' }), []);
    assert.deepEqual(
      list.filterLaunches(rows, { phase: 'not_tradable', query: '0xccc', sort: 'name' }).map((row) => row.symbol),
      ['MM']
    );
  });
});
