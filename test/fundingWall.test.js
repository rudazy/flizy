/**
 * The funding wall: what a user is told when they cannot afford something.
 *
 * This is funnel copy, not decoration. Fourteen sites used to end on a bare hex
 * address, which reads as a dead end at the exact moment a first-time user is
 * trying to send. What is protected here is that every one of them now carries
 * a way out, on both channels and on the site.
 *
 * Run: node --test test/fundingWall.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../lib/engine/fundingWall');
const { withFundHint } = require('../lib/commands/chat');

const ADDR = '0x1111111111111111111111111111111111111111';

/** Same inputs to both sides of the mirror. */
const VECTORS = [
  { kind: 'gas', address: ADDR },
  { kind: 'native', address: ADDR },
  { kind: 'native', address: ADDR, have: '0', need: '0.001' },
  { kind: 'token', address: ADDR, asset: 'FLZ' },
  { kind: 'token', address: ADDR, asset: 'FLZ', have: '2', need: '10' },
];

let web;
before(async () => {
  web = await import('../web/lib/fundingWall.ts');
});

describe('every wall names the way out', () => {
  it('points at the one fund path', () => {
    assert.match(bot.FUND_URL, /\/dashboard\/wallet\?s=fund$/);
  });

  it('carries the address and the fund page, whatever the shape', () => {
    for (const v of VECTORS) {
      const text = bot.fundingWallText(v);
      assert.ok(text.includes(ADDR), `no address in ${JSON.stringify(v)}`);
      assert.ok(text.includes(bot.FUND_URL), `no fund route in ${JSON.stringify(v)}`);
    }
  });

  it('reads correctly for each kind', () => {
    assert.equal(
      bot.fundingWallText({ kind: 'gas', address: ADDR }),
      [
        'Need a little ETH in your Flizy wallet for gas.',
        '',
        `Your wallet: ${ADDR}`,
        `Add funds: ${bot.FUND_URL}`,
      ].join('\n')
    );
    assert.equal(
      bot.fundingWallText({ kind: 'native', address: ADDR, have: '0', need: '0.001' }),
      [
        'Not enough ETH in your Flizy wallet (amount + gas).',
        'Have 0 ETH · Need ~0.001 ETH + gas',
        '',
        `Your wallet: ${ADDR}`,
        `Add funds: ${bot.FUND_URL}`,
      ].join('\n')
    );
    assert.equal(
      bot.fundingWallText({ kind: 'token', address: ADDR, asset: 'FLZ', have: '2', need: '10' }),
      [
        'Not enough FLZ in your Flizy wallet.',
        'Have 2 FLZ · Need 10 FLZ',
        '',
        `Your wallet: ${ADDR}`,
        `Add funds: ${bot.FUND_URL}`,
      ].join('\n')
    );
  });

  it('omits the have/need line when the caller has no formatted amounts', () => {
    const text = bot.fundingWallText({ kind: 'native', address: ADDR });
    assert.ok(!text.includes('Have '), text);
  });
});

/**
 * Not-held is not a funding wall. A user who does not own an NFT cannot fix
 * that by adding ETH, so this one must never grow a fund route.
 */
describe('not-held stays out of it', () => {
  it('shows the wallet and nothing to buy their way out with', () => {
    const text = bot.notHeldText({ line: 'giwaforge #12', address: ADDR });
    assert.equal(text, [`You do not hold giwaforge #12.`, `Your wallet: ${ADDR}`].join('\n'));
    assert.ok(!text.includes(bot.FUND_URL));
  });
});

/**
 * The engine cannot know how this channel types a command, so the second route
 * is added by the adapter. Only a refusal built by the wall earns it.
 */
describe('the chat half', () => {
  const tg = { channel: 'telegram' };
  const wa = { channel: 'whatsapp' };

  it('renders the command the way each channel types it', () => {
    const result = { reason: bot.FUND_REASON };
    assert.match(withFundHint(tg, result, 'wall'), /\nOr in chat: \/deposit$/);
    assert.match(withFundHint(wa, result, 'wall'), /\nOr in chat: flizy deposit$/);
  });

  it('leaves anything that is not a funding wall alone', () => {
    assert.equal(withFundHint(tg, { reason: 'something_else' }, 'wall'), 'wall');
    assert.equal(withFundHint(tg, {}, 'wall'), 'wall');
    assert.equal(withFundHint(tg, null, 'wall'), 'wall');
    assert.equal(withFundHint(tg, undefined, 'wall'), 'wall');
  });
});

/**
 * The reason a shared builder exists is that seventeen hand-written refusals
 * drift. A new one written the old way would too, so fail the suite instead.
 */
describe('no wall is hand-written any more', () => {
  const files = [
    ...fs
      .readdirSync(path.join(__dirname, '..', 'lib', 'engine'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join('lib', 'engine', f)),
    path.join('lib', 'listedNfts.js'),
  ];

  it('leaves no bare "Fund: <address>" line behind', () => {
    for (const rel of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(!/Fund: \$\{/.test(src), `hand-written funding wall in ${rel}`);
    }
  });

  it('writes the wall copy in exactly one place', () => {
    for (const rel of files) {
      if (rel.endsWith('fundingWall.js')) continue;
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(!/Need a little ETH in your Flizy wallet/.test(src), `copy duplicated in ${rel}`);
    }
  });
});

/**
 * lib/engine/fundingWall.js and web/lib/fundingWall.ts are a deliberate mirror:
 * the web bundle cannot reach into the bot package. Mirrors drift, so pin them.
 * The fund URL itself is normalised out — each side reads its own env, and what
 * is being protected here is the copy, not the deployment.
 */
describe('bot and site say the same thing', () => {
  const normalise = (text, url) => text.split(url).join('<FUND>');

  it('gives the same wall for every vector', () => {
    for (const v of VECTORS) {
      assert.equal(
        normalise(web.fundingWallText(v), web.fundUrl()),
        normalise(bot.fundingWallText(v), bot.FUND_URL),
        `drift on ${JSON.stringify(v)}`
      );
    }
  });

  it('agrees on the not-held line and the reason code', () => {
    const args = { line: 'giwaforge #12', address: ADDR };
    assert.equal(web.notHeldText(args), bot.notHeldText(args));
    assert.equal(web.FUND_REASON, bot.FUND_REASON);
  });
});
