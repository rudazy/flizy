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

/**
 * The sweep above catches a hardcoded dialect. It does not catch the other way
 * to get this wrong, which is calling cmd(ctx, ...) inside a body that is about
 * to be fanned out: that renders correctly, for the wrong channel.
 *
 * It happened in handleLink. A Telegram user linking sent the account's
 * WhatsApp an instruction reading "/lock", which does nothing there, in a
 * message whose entire purpose was to let the owner react quickly. The existing
 * sweep missed it twice over: it does not read router.js, and the text it looks
 * for is a literal, not a call.
 */
describe('no fan-out body picks a channel at composition time', () => {
  const FILES = ['lib/router.js', 'lib/notify.js', 'lib/paymentRequests.js', 'lib/holdings.js'];

  /** Source of one call's arguments, by balancing parens from the call site. */
  function callArgs(src, index) {
    let depth = 0;
    for (let i = index; i < src.length && i < index + 4000; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) return src.slice(index, i + 1);
      }
    }
    return src.slice(index, index + 4000);
  }

  /**
   * Comments are not code. The first run of this guard failed on the comment
   * explaining why the marker is used, which named the very call it was warning
   * against. A check that fires on prose about itself is one somebody deletes
   * instead of reading.
   */
  function withoutComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('every notifyAccount body uses the marker, never cmd(ctx, ...)', () => {
    for (const rel of FILES) {
      const full = path.join(__dirname, '..', rel);
      if (!fs.existsSync(full)) continue;
      const src = fs.readFileSync(full, 'utf8');

      let from = 0;
      for (;;) {
        const at = src.indexOf('notifyAccount(', from);
        if (at === -1) break;
        from = at + 1;
        const args = withoutComments(callArgs(src, at + 'notifyAccount'.length));
        assert.equal(
          /\bcmd\(\s*ctx\b/.test(args),
          false,
          `${rel}: a notifyAccount body renders a command for the sender's channel. ` +
            'Use {{cmd:...}} so renderCommands can resolve it per recipient.'
        );
      }
    }
  });

  it('the guard can actually see a violation', () => {
    // Without this the test above passes just as well when callArgs returns
    // nothing useful, which is how a structural sweep quietly stops working.
    const sample = "await notifyAccount(id, ['x', `go: ${cmd(ctx, 'lock')}`].join('\\n'), {});";
    const args = withoutComments(
      callArgs(sample, sample.indexOf('notifyAccount(') + 'notifyAccount'.length)
    );
    assert.match(args, /cmd\(\s*ctx/, 'the slicer must reach into the body it is checking');
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
