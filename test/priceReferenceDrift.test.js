/**
 * Chat and site decide a swap's price check the same way.
 *
 * web/ cannot import root lib/ on Vercel, so web/lib/priceReference.ts mirrors
 * lib/priceReference.js. Both read the same table; this pins the numbers and
 * the rule as identical.
 *
 * Run: node --test test/priceReferenceDrift.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const chat = require('../lib/priceReference');
let site;

before(async () => {
  site = await import('../web/lib/priceReference.ts');
});

const E18 = 10n ** 18n;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-19T12:07:00.000Z');
const show = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x));

describe('price reference, chat and site', () => {
  it('share every constant', () => {
    for (const name of ['PRICE_GUARD_BPS', 'SNAPSHOT_BUCKET_MS', 'REFERENCE_SNAPSHOTS', 'NEWEST_MAX_AGE_MS', 'OLDEST_MAX_AGE_MS', 'PRICE_SCALE']) {
      assert.equal(chat[name], site[name], name);
    }
  });

  it('bucket time and price reserves identically', () => {
    for (const t of [0, NOW, NOW + 8 * MIN, Date.parse('2026-12-31T23:59:59.999Z')]) {
      assert.equal(chat.bucketStart(t), site.bucketStart(t));
    }
    for (const [e, k] of [[0n, 1n], [1n, 0n], [E18, 1000n * E18], [E18, 3000n * 10n ** 6n], ['x', 1n], [-1n, 5n]]) {
      assert.equal(chat.priceFromReserves(e, k), site.priceFromReserves(e, k), show([e, k]));
    }
  });

  it('take the same reference from the same snapshots', () => {
    const bucket = Date.parse(chat.bucketStart(NOW));
    const row = (m, eth) => ({ bucket: new Date(bucket - m * MIN).toISOString(), reserve_eth: String(eth * E18), reserve_token: String(1000n * E18) });
    const cases = [
      [],
      [row(0, 1n), row(15, 1n), row(30, 1n)],
      [row(0, 1n), row(15, 2n), row(30, 3n), row(45, 40n)],
      [row(30, 1n), row(45, 1n), row(60, 1n), row(75, 1n)],
      [row(0, 1n), row(15, 1n), row(30, 1n), row(95, 1n)],
      [row(-60, 9n), row(0, 1n), row(15, 1n), row(30, 1n), row(45, 1n)],
      [{ bucket: 'nope', reserve_eth: 'x', reserve_token: '0' }, row(0, 1n)],
    ];
    for (const rows of cases) assert.equal(chat.referencePrice(rows, NOW), site.referencePrice(rows, NOW), show(rows));
  });

  it('check pools and swaps identically', () => {
    const ref = chat.priceFromReserves(100n * E18, 100_000n * E18);
    const spots = [null, ref, ref + (ref * 500n) / 10000n, ref + (ref * 501n) / 10000n, ref - (ref * 501n) / 10000n, ref * 10n];
    for (const reference of [null, ref]) {
      for (const spot of spots) {
        assert.deepEqual(chat.checkPoolPrice({ reference, spot }), site.checkPoolPrice({ reference, spot }));
        for (const inIsNative of [true, false]) {
          for (const amountIn of [0n, 1n, E18, 1000n * E18]) {
            for (const amountOutMin of [0n, 1n, (95n * E18) / 100n, 950n * E18, 990n * E18]) {
              const args = { reference, spot, inIsNative, amountIn, amountOutMin };
              assert.deepEqual(chat.checkSwapPrice(args), site.checkSwapPrice(args), show(args));
            }
          }
        }
      }
    }
  });

  it('both read reserves as text, never as a JSON number', () => {
    const fs = require('fs');
    const path = require('path');
    for (const rel of ['lib/priceReference.js', 'web/lib/priceReference.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.match(src, /\.select\('bucket, reserve_eth::text, reserve_token::text'\)/, rel);
    }
  });

  it('list the same pools', () => {
    const dex = { flz: '0x' + 'A'.repeat(40), pair: '0x' + 'B'.repeat(40) };
    const listed = [{ address: '0x' + 'C'.repeat(40), pair: '0x' + 'D'.repeat(40) }];
    assert.deepEqual(chat.verifiedPools(dex, listed), site.verifiedPools(dex, listed));
    assert.deepEqual(chat.verifiedPools({ flz: '', pair: '' }, []), site.verifiedPools({ flz: '', pair: '' }, []));
  });
});
