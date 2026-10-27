/**
 * What a site session may say about the browser that opened it.
 *
 * Run: node --test test/sessionClient.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let client;

before(async () => {
  client = await import('../web/lib/sessionClient.ts');
});

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function headers(map) {
  return { get: (name) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null) };
}

describe('clientLabel', () => {
  it('names the browser and the device', () => {
    assert.equal(client.clientLabel(CHROME_WINDOWS), 'Chrome on Windows');
    assert.equal(client.clientLabel(IPHONE), 'Safari on iPhone');
    assert.equal(client.clientLabel(''), null);
    assert.equal(client.clientLabel(null), null);
  });
});

describe('clientPlace', () => {
  it('keeps a city and a country code, and drops anything that is not that', () => {
    assert.equal(client.clientPlace(headers({ 'x-vercel-ip-city': 'Lagos', 'x-vercel-ip-country': 'NG' })), 'Lagos, NG');
    assert.equal(client.clientPlace(headers({ 'x-vercel-ip-city': 'Lagos', 'x-vercel-ip-country': 'nigeria' })), 'Lagos');
    assert.equal(client.clientPlace(headers({ 'x-vercel-ip-country': 'NGA' })), null);
    assert.equal(client.clientPlace(headers({ 'x-vercel-ip-city': '<script>', 'x-vercel-ip-country': 'NG' })), 'NG');
    assert.equal(client.clientPlace(headers({})), null);
  });
});

describe('presentSessions', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');

  it('hides the token hash, marks this browser, and drops an expired row', () => {
    const shown = client.presentSessions(
      [
        {
          id: 'old',
          token_hash: 'hash-old',
          created_at: '2026-10-26T12:00:00Z',
          expires_at: '2026-10-27T11:00:00Z',
          client_label: 'Chrome on Windows',
          client_place: 'Lagos, NG',
        },
        {
          id: 'here',
          token_hash: 'hash-here',
          created_at: '2026-10-27T09:00:00Z',
          expires_at: '2026-11-27T09:00:00Z',
          client_label: 'Chrome on Windows',
          client_place: 'Lagos, NG',
        },
        {
          id: 'other',
          token_hash: 'hash-other',
          created_at: '2026-10-27T08:00:00Z',
          expires_at: '2026-11-27T08:00:00Z',
          client_label: 'Safari on iPhone',
          client_place: null,
        },
      ],
      'hash-here',
      now
    );

    assert.equal(shown.length, 2);
    assert.equal(shown[0].id, 'here');
    assert.equal(shown[0].current, true);
    assert.equal(shown[1].current, false);
    assert.equal(JSON.stringify(shown).includes('hash-'), false);
    assert.equal(shown[0].place, 'Lagos, NG');
    assert.equal(shown[1].place, null);
  });
});

describe('isMissingSessionColumn', () => {
  it('recognises a database that has not had the place columns added', () => {
    assert.equal(client.isMissingSessionColumn({ code: '42703', message: 'column does not exist' }), true);
    assert.equal(client.isMissingSessionColumn({ code: 'PGRST204', message: '' }), true);
    assert.equal(client.isMissingSessionColumn({ code: '', message: 'client_label missing' }), true);
    assert.equal(client.isMissingSessionColumn({ code: '23505', message: 'duplicate' }), false);
  });
});
