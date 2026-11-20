/**
 * A place from the browser's time zone.
 *
 * Run: node --test test/timeZonePlace.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let zones;

before(async () => {
  zones = await import('../web/lib/timeZonePlace.ts');
});

describe('placeFromTimeZone', () => {
  it('names the zone city and its country', () => {
    assert.deepEqual(zones.placeFromTimeZone('Africa/Lagos'), { city: 'Lagos', country: 'NG' });
    assert.deepEqual(zones.placeFromTimeZone('Africa/Nairobi'), { city: 'Nairobi', country: 'KE' });
    assert.deepEqual(zones.placeFromTimeZone('Africa/Dar_es_Salaam'), { city: 'Dar es Salaam', country: 'TZ' });
    assert.deepEqual(zones.placeFromTimeZone('America/Argentina/Buenos_Aires'), { city: 'Buenos Aires', country: 'AR' });
    assert.deepEqual(zones.placeFromTimeZone('Europe/Kiev'), { city: 'Kiev', country: 'UA' });
  });

  it('returns null for a zone it does not know or a value that is not a zone', () => {
    assert.equal(zones.placeFromTimeZone('Antarctica/Troll'), null);
    assert.equal(zones.placeFromTimeZone('UTC'), null);
    assert.equal(zones.placeFromTimeZone(''), null);
    assert.equal(zones.placeFromTimeZone(null), null);
    assert.equal(zones.placeFromTimeZone('Africa/constructor'), null);
    assert.equal(zones.placeFromTimeZone('Africa/hasOwnProperty'), null);
  });
});

describe('ZONE_COUNTRY', () => {
  it('holds only real time zones and two-letter countries', () => {
    for (const [zone, country] of Object.entries(zones.ZONE_COUNTRY)) {
      assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: zone }), zone);
      assert.match(country, /^[A-Z]{2}$/, zone);
    }
  });
});
