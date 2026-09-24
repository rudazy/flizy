/**
 * The bot and web copies of the ticket module must agree.
 *
 * `web/lib/trustedTicket.ts` is a copy of `lib/trustedTicket.js` for the reason
 * `web/lib/errorScrub.ts` is a copy: the Vercel root is `web`, so `../lib` is
 * not uploaded with the deploy. Same pattern, same risk, so the same guard.
 *
 * What drift costs here is specific. The bot mints a code and the site is the
 * only half that can spend it, so the two must normalise a code identically --
 * if they disagree by one character class, every ticket the bot writes is a
 * code the site cannot find, and the add flow dead-ends at "invalid" with
 * nothing in the logs to say why.
 *
 * Run: node --test test/trustedTicketDrift.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const bot = require('../lib/trustedTicket');

const WEB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'lib', 'trustedTicket.ts'),
  'utf8'
);

/** Codes as they actually arrive: from a URL, pasted, retyped, mangled. */
const CASES = [
  'ABCD2345',
  'abcd2345',
  '  ABCD2345  ',
  'ABCD-2345',
  'ABCD 2345',
  'abcd_2345',
  'ABCD2345?add=x',
  '',
  '   ',
  '!!!!',
  // Built rather than typed, so this file stays pure ASCII. Sharp s is the
  // interesting one: toUpperCase expands it to two characters, so a copy that
  // uppercased in a different order would disagree here and nowhere else.
  String.fromCharCode(0xdf) + 'BCD2345',
  String.fromCharCode(0xc5) + 'BCD2345',
];

/**
 * Run the web copy without a TypeScript step, the same way the scrubber guard
 * does. Narrow on purpose: if the web copy grows syntax this cannot handle the
 * test fails loudly rather than quietly skipping.
 */
function loadWebNormalize() {
  const start = WEB_SRC.indexOf('export function normalizeTicketCode');
  assert.notEqual(start, -1, 'web copy must still export normalizeTicketCode');
  const body = WEB_SRC.slice(start, WEB_SRC.indexOf('\n}', start) + 2);
  const js = body
    .replace('export function', 'function')
    .replace(/: unknown\b/g, '')
    .replace(/\)\s*:\s*string\s*\{/, ') {');
  // eslint-disable-next-line no-new-func
  return new Function(`${js}; return normalizeTicketCode;`)();
}

describe('the two ticket halves normalise codes identically', () => {
  const web = loadWebNormalize();

  for (const input of CASES) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      assert.equal(
        bot.normalizeTicketCode(input),
        web(input),
        'a code the bot mints must be a code the site can find'
      );
    });
  }

  it('a minted code survives its own normalisation', () => {
    // Minting is bot-only, so this is the one direction that matters: whatever
    // generateTicketCode produces has to pass through both halves unchanged,
    // and has to satisfy the check constraint on the column.
    for (let i = 0; i < 200; i += 1) {
      const code = bot.generateTicketCode();
      assert.match(code, /^[A-Z0-9]{6,12}$/, 'must satisfy trusted_add_tickets_code_format');
      assert.equal(bot.normalizeTicketCode(code), code);
      assert.equal(web(code), code);
    }
  });

  it('codes are drawn from crypto, not Math.random', () => {
    // Not because a guessed ticket grants anything -- it does not, the password
    // still gates the add -- but because this function is the one the next
    // person copies, and lib/linkCode.js is the shape being copied.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trustedTicket.js'), 'utf8');
    assert.match(src, /crypto\.randomBytes\(/, 'ticket codes must come from crypto');
    assert.doesNotMatch(src, /Math\.random/, 'Math.random is not a code source here');
  });
});

describe('the security properties hold in both copies', () => {
  const BOT_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'trustedTicket.js'), 'utf8');

  it('every lookup and spend is bound to an account', () => {
    // A ticket that is not account-scoped could prefill somebody else's form.
    for (const [name, src] of [
      ['bot', BOT_SRC],
      ['web', WEB_SRC],
    ]) {
      const reads = src.split('trusted_add_tickets').slice(1);
      assert.ok(reads.length >= 2, `${name} copy should touch the table at least twice`);
      for (const chunk of reads) {
        const stmt = chunk.slice(0, chunk.indexOf(';'));
        if (!/\.eq\(|\.insert\(/.test(stmt)) continue;
        assert.match(
          stmt,
          /account_id/,
          `${name} copy touches trusted_add_tickets without scoping to an account`
        );
      }
    }
  });

  it('spending a ticket only ever moves it from unspent', () => {
    // Without the null guard a replay could re-stamp a spent ticket and the
    // single-use property would be a comment rather than a rule.
    assert.match(BOT_SRC, /\.is\('used_at', null\)/);
    assert.match(WEB_SRC, /\.is\('used_at', null\)/);
  });

  it('neither copy can write to the trusted list', () => {
    // The whole point of the ticket is that it is not authority. A copy that
    // could reach trusted_addresses would be authority.
    assert.doesNotMatch(BOT_SRC, /trusted_addresses/);
    assert.doesNotMatch(WEB_SRC, /trusted_addresses/);
  });
});
