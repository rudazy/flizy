/**
 * Pay identity URLs: which one is printed, and what it routes on.
 *
 * The rule this file defends: a QR gets printed and taped to a counter, and
 * paper cannot be recalled. So the printed URL routes on the permanent pay
 * code, never on the username. A QR keyed on a name that later moves is either
 * dead or -- if that name is ever reissued -- pointing at a stranger, and the
 * payer has no way to tell.
 *
 * The shareable link is the opposite case: typed, pasted and read aloud, never
 * printed, so it stays the pretty username form on purpose. If someone
 * "simplifies" these two into one URL again, this file is what should stop it.
 *
 * The QR also uses /pay/c/{code}, which resolves codes only, rather than
 * /pay/{ref}, which accepts a username too and tries usernames first. Nine
 * digits already make a code impossible to register as a name, so this is the
 * second lock rather than the only one: printed paper should not depend on two
 * namespaces staying disjoint forever.
 *
 * And the QR carries no name at all. The printed sheet shows the pay code
 * alone -- the bank-account model, where you hand out the number and the payer
 * reads whose account it is off the confirm screen. Nothing printed can go
 * stale because nothing printed is a name.
 *
 * The rule behind it: the routing identifier is permanent and never typed by a
 * human; the username is a label that may move.
 * Run: node --test test/payUrls.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../lib/payCode');

const SITE = 'https://flizy.app';
const CODE = '012345678';

/** Same inputs both sides must agree on. Junk is in here deliberately. */
const VECTORS = [
  [SITE, CODE, 'ludarep'],
  [SITE, CODE, null],
  [SITE + '/', CODE, 'ludarep'],
  ['', CODE, 'ludarep'],
  ['', CODE, null],
  [SITE, CODE, ''],
  [SITE, '', 'ludarep'],
  [SITE, '', null],
  [SITE, CODE, 'UPPER'],
];

let web;
before(async () => {
  web = await import('../web/lib/payCode.ts');
});

describe('the printed QR routes on the pay code', () => {
  it('never puts the username in the path', () => {
    const { qrUrl } = bot.buildPayUrls(SITE, CODE, 'ludarep');
    assert.equal(qrUrl.startsWith('https://flizy.app/pay/c/012345678'), true);
    assert.equal(qrUrl.includes('/pay/ludarep'), false);
  });

  it('uses the code-only route, not the one a username can shadow', () => {
    // /pay/{ref} resolves usernames first, and a pay code lowercased is a valid
    // username. Anyone could read a shop's code off its QR, register it, and
    // collect payments meant for the shop. /pay/c/{code} has no name fallback.
    const { qrUrl } = bot.buildPayUrls(SITE, CODE, 'ludarep');
    assert.equal(qrUrl.includes('/pay/c/'), true);
    assert.equal(/\/pay\/[^c]/.test(new URL(qrUrl).pathname), false);
  });

  it('is the same URL whether or not the account has a username', () => {
    // The QR must not depend on the name in any way, or it starts going stale
    // the moment the name moves.
    const withName = bot.buildPayUrls(SITE, CODE, 'ludarep').qrUrl;
    const without = bot.buildPayUrls(SITE, CODE, null).qrUrl;
    assert.equal(withName, 'https://flizy.app/pay/c/012345678');
    assert.equal(without, withName);
  });

  it('leaks no name into the URL, whatever it is handed', () => {
    for (const name of ['ludarep', 'lu da rep', 'UPPER', '']) {
      const { qrUrl } = bot.buildPayUrls(SITE, CODE, name);
      assert.equal(qrUrl, 'https://flizy.app/pay/c/012345678', `leaked on ${JSON.stringify(name)}`);
    }
  });

  it('falls back to the name only when there is no code at all', () => {
    // An account mid-issue has no code yet. A link that resolves beats none.
    assert.equal(bot.buildPayUrls(SITE, '', 'ludarep').qrUrl, 'https://flizy.app/pay/ludarep');
    assert.equal(bot.buildPayUrls(SITE, '', null).qrUrl, '');
  });
});

describe('the shareable link stays the pretty one', () => {
  it('uses the username, because it is typed and pasted rather than printed', () => {
    assert.equal(bot.buildPayUrls(SITE, CODE, 'ludarep').shareUrl, 'https://flizy.app/pay/ludarep');
  });

  it('falls back to the code when there is no username', () => {
    assert.equal(bot.buildPayUrls(SITE, CODE, null).shareUrl, 'https://flizy.app/pay/012345678');
  });

  it('is not the same URL as the QR when a username exists', () => {
    const { shareUrl, qrUrl } = bot.buildPayUrls(SITE, CODE, 'ludarep');
    assert.notEqual(shareUrl, qrUrl);
  });
});

describe('base URL handling', () => {
  it('does not double the slash', () => {
    assert.equal(bot.buildPayUrls(SITE + '/', CODE, 'ludarep').shareUrl, 'https://flizy.app/pay/ludarep');
    assert.equal(bot.buildPayUrls(SITE + '/', CODE, 'ludarep').qrUrl, 'https://flizy.app/pay/c/012345678');
  });

  it('returns relative paths when there is no site URL', () => {
    const { shareUrl, qrUrl } = bot.buildPayUrls('', CODE, 'ludarep');
    assert.equal(shareUrl, '/pay/ludarep');
    assert.equal(qrUrl, '/pay/c/012345678');
  });
});

/**
 * lib/payCode.js and web/lib/payCode.ts are a mirror pair: the web bundle
 * cannot reach into the bot package. Mirrors drift, so pin them on the vectors.
 */
describe('bot and site build the same URLs', () => {
  it('agrees on every vector', () => {
    for (const [base, code, name] of VECTORS) {
      const a = bot.buildPayUrls(base, code, name);
      const b = web.buildPayUrls(base, code, name);
      const label = JSON.stringify([base, code, name]);
      assert.equal(b.shareUrl, a.shareUrl, `shareUrl drift on ${label}`);
      assert.equal(b.qrUrl, a.qrUrl, `qrUrl drift on ${label}`);
    }
  });
});
