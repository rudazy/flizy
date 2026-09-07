/**
 * Refusals speak the language of the channel they land on.
 *
 * Twenty-six engine and notification messages used to hardcode the WhatsApp
 * form — `flizy unlock your-pin`, `flizy deposit`, `flizy claim`. Every one of
 * them told a Telegram user to type a command that does not exist there. The
 * engine has no ctx by design, so it could not have known better.
 *
 * Notifications are the sharper half. `notifyAccount` composes **one** body and
 * fans it out to every channel an account has linked, so there is no correct
 * wording at the moment the message is written. Passing a ctx would have picked
 * the *sender's* channel, which is wrong for the recipient twice over.
 *
 * What is protected here: the marker renders per channel, and no engine or
 * handler message goes back to writing the dialect by hand.
 *
 * Run: node --test test/failureCopy.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderCommand, renderCommands } = require('../lib/commands/render');
const { config } = require('../lib/config');
const { rejectUntrustedMessage } = require('../lib/trusted');

describe('rendering a command for one channel', () => {
  it('writes the dialect each channel actually reads', () => {
    assert.equal(renderCommand('unlock your-pin', 'whatsapp'), 'flizy unlock your-pin');
    assert.equal(renderCommand('unlock your-pin', 'telegram'), '/unlock your-pin');
  });

  it('expands every marker in a body, not just the first', () => {
    const body = 'Example: {{cmd:send 0.001 to john}}\nOr: {{cmd:send 10 FLZ to john}}';
    assert.equal(
      renderCommands(body, 'telegram'),
      'Example: /send 0.001 to john\nOr: /send 10 FLZ to john'
    );
    assert.equal(
      renderCommands(body, 'whatsapp'),
      'Example: flizy send 0.001 to john\nOr: flizy send 10 FLZ to john'
    );
  });

  it('leaves a message with no marker exactly as it was', () => {
    const plain = 'Sent.\n0.01 ETH -> john';
    assert.equal(renderCommands(plain, 'telegram'), plain);
    assert.equal(renderCommands(plain, 'whatsapp'), plain);
  });

  it('never throws on something that is not a string', () => {
    assert.equal(renderCommands(null, 'telegram'), '');
    assert.equal(renderCommands(undefined, 'whatsapp'), '');
    assert.equal(renderCommands(42, 'telegram'), '42');
  });

  it('treats an unknown channel as the WhatsApp form rather than failing', () => {
    // deliver() refuses unknown channels outright; this is only about never
    // emitting a half-rendered marker if one slips through.
    assert.equal(renderCommands('{{cmd:balance}}', 'nonsense'), 'flizy balance');
  });
});

/**
 * The reason a marker exists at all is that twenty-six messages drifted into
 * one channel's dialect. Five of those this sweep found on its own, after two
 * hand greps had already missed them. The twenty-seventh should fail the suite.
 */
describe('no refusal writes the dialect by hand', () => {
  const files = [
    ...fs
      .readdirSync(path.join(__dirname, '..', 'lib', 'engine'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join('lib', 'engine', f)),
    ...fs
      .readdirSync(path.join(__dirname, '..', 'lib', 'handlers'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join('lib', 'handlers', f)),
  ];

  /** Prose about the product, not a command someone is told to type. */
  const PROSE = /flizy (wallet|account|site|username|dashboard)/i;

  it('leaves no hardcoded "flizy <command>" in engine or handler copy', () => {
    for (const rel of files) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      for (const line of src.split('\n')) {
        const hit = /flizy [a-z]/.test(line) && !PROSE.test(line);
        assert.equal(hit, false, `${rel}: ${line.trim()}`);
      }
    }
  });
});

describe('a refusal names a way forward', () => {
  it('the not-trusted copy carries a route, not just a rule', () => {
    const said = rejectUntrustedMessage();
    assert.match(said, /https?:\/\//);
    // The rule is env-overridable; the route is appended, so rewording the rule
    // cannot ship a refusal with nowhere to go.
    assert.match(said, new RegExp(config.rejectUntrustedCopy.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('the daily limit says where to change it', () => {
    // Built from a live balance, so check the source carries the URL rather
    // than standing up a database to read one sentence back.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dailyLimits.js'), 'utf8');
    assert.match(src, /Change limit on the site: \$\{config\.siteUrl\}/);
  });
});
