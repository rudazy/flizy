/**
 * Layer-based collection generation: unique combinations, weights, rules,
 * and standard metadata.
 *
 * Run: node --test test/collectionGen.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let g;
before(async () => {
  g = await import('../web/lib/collectionGen.ts');
});

const opt = (id, weight = 1) => ({ id, name: id, weight });
const layer = (id, options) => ({ id, name: id, options });

const BG = layer('Background', [opt('Blue', 40), opt('Purple', 30), opt('Green', 20), opt('Gold', 10)]);
const EYES = layer('Eyes', [opt('Normal', 60), opt('Laser', 25), opt('Diamond', 10), opt('Legendary', 5)]);
const HAT = layer('Headwear', [opt('None'), opt('Cap'), opt('Crown')]);
const CLOTHES = layer('Clothes', [opt('Hoodie'), opt('Royal')]);

const keyOf = (layers, t) => layers.map((l) => t.picks[l.id]).join('|');

describe('counting combinations', () => {
  it('multiplies the trait counts, and ignores a trait with no weight', () => {
    assert.deepEqual(g.countCombinations([BG, EYES, HAT]), { count: 48, atLeast: false });
    const zero = layer('Eyes', [opt('Normal', 1), opt('Off', 0)]);
    assert.deepEqual(g.countCombinations([BG, zero]), { count: 4, atLeast: false });
    assert.deepEqual(g.countCombinations([]), { count: 0, atLeast: false });
  });

  it('counts what the rules leave', () => {
    const rules = [
      { id: 'r1', kind: 'requires', when: { layer: 'Headwear', option: 'Crown' }, then: { layer: 'Clothes', option: 'Royal' } },
      { id: 'r2', kind: 'excludes', when: { layer: 'Eyes', option: 'Laser' }, then: { layer: 'Headwear', option: 'Cap' } },
    ];
    // Brute force the same thing.
    let expected = 0;
    for (const e of EYES.options) for (const h of HAT.options) for (const c of CLOTHES.options) {
      if (h.id === 'Crown' && c.id !== 'Royal') continue;
      if (e.id === 'Laser' && h.id === 'Cap') continue;
      expected += 1;
    }
    assert.deepEqual(g.countCombinations([EYES, HAT, CLOTHES], rules), { count: expected, atLeast: false });
  });

  it('stops at the cap and says so', () => {
    const big = Array.from({ length: 7 }, (_, i) => layer(`L${i}`, Array.from({ length: 10 }, (_, j) => opt(`o${j}`))));
    assert.deepEqual(g.countCombinations(big), { count: g.COUNT_CAP, atLeast: true });
  });
});

describe('generating', () => {
  it('makes the supply, numbered from 1, every combination unique, the same for the same seed', () => {
    const run = g.generateCollection([BG, EYES, HAT], [], 40, 7);
    assert.equal(run.short, false);
    assert.deepEqual(run.tokens.map((t) => t.tokenId), Array.from({ length: 40 }, (_, i) => i + 1));
    assert.equal(new Set(run.tokens.map((t) => keyOf([BG, EYES, HAT], t))).size, 40);
    assert.deepEqual(g.generateCollection([BG, EYES, HAT], [], 40, 7), run);
    assert.notDeepEqual(g.generateCollection([BG, EYES, HAT], [], 40, 8).tokens, run.tokens);
  });

  it('says it is short instead of looping when the traits cannot make the supply', () => {
    const run = g.generateCollection([BG, HAT], [], 100, 1);
    assert.equal(run.short, true);
    assert.equal(run.tokens.length, 12);
  });

  it('follows the rules in either layer order', () => {
    const rules = [
      { id: 'r1', kind: 'requires', when: { layer: 'Headwear', option: 'Crown' }, then: { layer: 'Clothes', option: 'Royal' } },
      { id: 'r2', kind: 'excludes', when: { layer: 'Clothes', option: 'Royal' }, then: { layer: 'Eyes', option: 'Laser' } },
    ];
    for (const order of [[EYES, HAT, CLOTHES], [CLOTHES, HAT, EYES]]) {
      const run = g.generateCollection(order, rules, 15, 3);
      for (const t of run.tokens) {
        if (t.picks.Headwear === 'Crown') assert.equal(t.picks.Clothes, 'Royal');
        assert.ok(!(t.picks.Clothes === 'Royal' && t.picks.Eyes === 'Laser'));
      }
      assert.equal(run.tokens.length, g.countCombinations(order, rules).count >= 15 ? 15 : run.tokens.length);
    }
  });

  it('follows the weights over a large run', () => {
    // Plenty of room, so uniqueness never pushes a pick off its weight.
    const wide = layer('Pad', Array.from({ length: 2000 }, (_, j) => opt(`p${j}`)));
    const run = g.generateCollection([EYES, wide], [], 1000, 11);
    const counts = g.actualCounts(EYES, run.tokens);
    assert.ok(counts.get('Normal') > counts.get('Laser'));
    assert.ok(counts.get('Laser') > counts.get('Diamond'));
    assert.ok(Math.abs(counts.get('Normal') - 600) < 80, String(counts.get('Normal')));
  });
});

describe('rarity and labels', () => {
  it('turns weights into percentages and expected counts', () => {
    const rows = g.expectedCounts(EYES, 1000);
    assert.deepEqual(rows.map((r) => [r.option.id, r.percent, r.expected]), [
      ['Normal', 60, 600],
      ['Laser', 25, 250],
      ['Diamond', 10, 100],
      ['Legendary', 5, 50],
    ]);
  });

  it('pads token numbers to the supply', () => {
    assert.equal(g.tokenLabel(1, 1000), '#0001');
    assert.equal(g.tokenLabel(7, 50), '#007');
    assert.equal(g.tokenLabel(1000, 1000), '#1000');
  });
});

describe('metadata and validation', () => {
  it('writes standard metadata with every trait as an attribute', () => {
    const token = { tokenId: 1, picks: { Background: 'Blue', Eyes: 'Laser' } };
    assert.deepEqual(g.tokenMetadata({ name: 'Cyber Frogs', description: 'Frogs.' }, [BG, EYES], token, 'ipfs://cid/1.png'), {
      name: 'Cyber Frogs #1',
      description: 'Frogs.',
      image: 'ipfs://cid/1.png',
      attributes: [
        { trait_type: 'Background', value: 'Blue' },
        { trait_type: 'Eyes', value: 'Laser' },
      ],
    });
  });

  it('warns when the supply is more than the traits allow, and passes a good run', () => {
    const tooMany = g.validateCollection([BG, HAT], [], 100, null);
    assert.ok(tooMany.some((c) => !c.ok && /only 12 unique NFTs/.test(c.label)));
    const run = g.generateCollection([BG, EYES, HAT], [], 30, 2);
    assert.ok(g.validateCollection([BG, EYES, HAT], [], 30, run).every((c) => c.ok));
    const dupNames = g.validateCollection([BG, { ...EYES, name: 'background' }], [], 4, null);
    assert.ok(dupNames.some((c) => !c.ok && /unique names/.test(c.label)));
  });
});

describe('Create a Mint screens', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'web', 'components', f), 'utf8');
  const CREATE = read('MintCreate.tsx');
  const CREATOR = read('CollectionCreator.tsx');

  it('offers three ways and keeps the existing import and manual flows', () => {
    for (const s of ['title="Create with Flizy"', 'title="Generate with AI"', 'title="Import existing collection"', 'Create a collection manually']) {
      assert.ok(CREATE.includes(s), s);
    }
    assert.match(CREATE, /mode === 'existing' \? <ExistingCollection/);
    assert.match(CREATE, /mode === 'new' \? <NewCollection/);
    assert.match(CREATE, /fetch\('\/api\/mints\/import'/);
  });

  it('opens Generate with AI and hands its layers to the creator', () => {
    assert.match(CREATE, /action="Generate with AI"\s*onClick=\{\(\) => setMode\('ai'\)\}/);
    assert.match(CREATE, /<CollectionCreator start=\{start\}/);
  });

  it('launches only through the fee and storage steps, and says when they are not set up', () => {
    const LAUNCH = read('GeneratedLaunch.tsx');
    assert.match(CREATOR, /<GeneratedLaunch/);
    // The creator itself still calls no API: everything paid goes through GeneratedLaunch.
    assert.doesNotMatch(CREATOR, /fetch\(/);
    assert.match(LAUNCH, /url="\/api\/mints\/generated\/pay"/);
    assert.match(LAUNCH, /Network gas/);
    assert.match(LAUNCH, /not live yet: the collection contract for NFTs with their own art is not deployed/);
    assert.match(LAUNCH, /not live yet: image storage is not set up/);
    assert.match(LAUNCH, /disabled=\{!paid \|\| !canLaunch \|\| busy\}/);
  });
});
