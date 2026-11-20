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

const ANDROID_REDUCED =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ANDROID_TABLET_REDUCED =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ANDROID_WITH_MODEL =
  'Mozilla/5.0 (Linux; Android 13; TECNO KI5 Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const FIREFOX_ANDROID_TABLET = 'Mozilla/5.0 (Android 13; Tablet; rv:120.0) Gecko/120.0 Firefox/120.0';
const IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

describe('clientKind', () => {
  it('tells a phone, a tablet and a computer apart', () => {
    assert.equal(client.clientKind(IPHONE), 'phone');
    assert.equal(client.clientKind(ANDROID_REDUCED), 'phone');
    assert.equal(client.clientKind(ANDROID_TABLET_REDUCED), 'tablet');
    assert.equal(client.clientKind(FIREFOX_ANDROID_TABLET), 'tablet');
    assert.equal(client.clientKind(IPAD), 'tablet');
    assert.equal(client.clientKind(CHROME_WINDOWS), 'computer');
    assert.equal(client.clientKind(''), null);
  });

  it('believes the mobile hint for an Android user agent without "Mobile"', () => {
    assert.equal(client.clientKind(ANDROID_TABLET_REDUCED, '?1'), 'phone');
    assert.equal(client.clientKind(ANDROID_TABLET_REDUCED, '?0'), 'tablet');
  });
});

describe('clientModel', () => {
  it('takes the model hint first, and names a Samsung code', () => {
    assert.equal(client.clientModel(ANDROID_REDUCED, '"SM-A155F"'), 'Samsung SM-A155F');
    assert.equal(client.clientModel(ANDROID_REDUCED, '"Infinix X6831"'), 'Infinix X6831');
  });

  it('reads the model from an older Android user agent', () => {
    assert.equal(client.clientModel(ANDROID_WITH_MODEL), 'TECNO KI5');
  });

  it('has nothing for a reduced user agent, an iPhone, or a computer', () => {
    assert.equal(client.clientModel(ANDROID_REDUCED), null);
    assert.equal(client.clientModel(ANDROID_REDUCED, '""'), null);
    assert.equal(client.clientModel(IPHONE), null);
    assert.equal(client.clientModel(CHROME_WINDOWS), null);
    assert.equal(client.clientModel(FIREFOX_ANDROID_TABLET), null);
  });

  it('drops a hint that is not shaped like a model', () => {
    assert.equal(client.clientModel(ANDROID_REDUCED, '"<img src=x>"'), null);
    assert.equal(client.clientModel(ANDROID_REDUCED, `"${'A'.repeat(60)}"`), null);
  });
});

describe('placeFor', () => {
  const nairobi = headers({ 'x-vercel-ip-city': 'Nairobi', 'x-vercel-ip-country': 'KE' });

  it('names the time zone when the network puts the device in another country', () => {
    assert.deepEqual(client.placeFor(nairobi, 'Africa/Lagos'), { place: 'Lagos, NG', networkPlace: 'Nairobi, KE' });
  });

  it('keeps the network city when both agree on the country', () => {
    const ibadan = headers({ 'x-vercel-ip-city': 'Ibadan', 'x-vercel-ip-country': 'NG' });
    assert.deepEqual(client.placeFor(ibadan, 'Africa/Lagos'), { place: 'Ibadan, NG', networkPlace: null });
  });

  it('uses the time zone when the network sent nothing', () => {
    assert.deepEqual(client.placeFor(headers({}), 'Africa/Lagos'), { place: 'Lagos, NG', networkPlace: null });
  });

  it('falls back to the network for a missing, unknown or malformed zone', () => {
    const networkOnly = { place: 'Nairobi, KE', networkPlace: null };
    assert.deepEqual(client.placeFor(nairobi, null), networkOnly);
    assert.deepEqual(client.placeFor(nairobi, 'Antarctica/Troll'), networkOnly);
    assert.deepEqual(client.placeFor(nairobi, '../../etc'), networkOnly);
    assert.deepEqual(client.placeFor(nairobi, 'Africa/Lagos<script>'), networkOnly);
  });
});

describe('sessionClientFrom', () => {
  it('reads every field from one request', () => {
    const seen = client.sessionClientFrom(
      headers({
        'user-agent': ANDROID_REDUCED,
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-model': '"SM-A155F"',
        'x-vercel-ip-city': 'Nairobi',
        'x-vercel-ip-country': 'KE',
      }),
      'Africa/Lagos'
    );
    assert.deepEqual(seen, {
      label: 'Chrome on Android',
      kind: 'phone',
      model: 'Samsung SM-A155F',
      place: 'Lagos, NG',
      networkPlace: 'Nairobi, KE',
    });
  });
});

describe('presentSessions, device fields', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const base = { token_hash: 'h', created_at: '2026-11-20T09:00:00Z', expires_at: '2026-12-20T09:00:00Z' };

  it('passes the new fields through', () => {
    const [row] = client.presentSessions(
      [
        {
          ...base,
          id: 'a',
          client_label: 'Chrome on Android',
          client_kind: 'phone',
          client_model: 'Samsung SM-A155F',
          client_place: 'Lagos, NG',
          client_network_place: 'Nairobi, KE',
          last_seen_at: '2026-11-20T11:50:00Z',
        },
      ],
      'other',
      now
    );
    assert.equal(row.kind, 'phone');
    assert.equal(row.model, 'Samsung SM-A155F');
    assert.equal(row.networkPlace, 'Nairobi, KE');
    assert.equal(row.lastSeenAt, '2026-11-20T11:50:00Z');
  });

  it('works out the kind of an older row from its label, and rejects a bad kind', () => {
    const rows = client.presentSessions(
      [
        { ...base, id: 'a', client_label: 'Safari on iPhone' },
        { ...base, id: 'b', client_label: 'Chrome on Windows', client_kind: 'toaster' },
        { ...base, id: 'c', client_label: 'Safari on iPad' },
        { ...base, id: 'd', client_label: null, last_seen_at: 'not a date' },
      ],
      'other',
      now
    );
    const kinds = Object.fromEntries(rows.map((r) => [r.id, r.kind]));
    assert.deepEqual(kinds, { a: 'phone', b: 'computer', c: 'tablet', d: null });
    assert.equal(rows.find((r) => r.id === 'd').lastSeenAt, null);
  });
});

describe('isMissingSessionColumn, device columns', () => {
  it('recognises each column the device migration adds', () => {
    for (const column of ['client_kind', 'client_model', 'client_network_place', 'last_seen_at']) {
      assert.equal(client.isMissingSessionColumn({ code: '', message: `column ${column} not found` }), true, column);
    }
  });
});
