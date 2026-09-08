/**
 * What a brand-new chat is told to do first.
 *
 * The defect this fixes: the welcome opened with `send 0.001 to @friend on
 * telegram` for everybody. A brand-new account has an empty wallet and usually
 * no linked site account, so the first instruction Flizy gave was the one thing
 * that could not work -- straight into the funding wall, or into "link your
 * site account first". Production agreed, measured 2026-09-07: of 64 accounts,
 * 36 had a linked chat and 6 had ever completed a send, while every send that
 * was attempted succeeded. Nobody was failing at sending; almost nobody
 * reached it. Those counts are a dated observation, not a claim about today.
 *
 * The property worth pinning is therefore narrow and blunt:
 *
 *   never open by telling someone to send when they cannot send.
 *
 * welcomeText takes a ctx, so cmd() renders each channel's dialect inline. The
 * assertions read that rendered text rather than the {{cmd:...}} marker form,
 * which only appears in copy built without a ctx.
 *
 * Run: node --test test/firstRun.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { welcomeText } = require('../lib/router');

const WA = { channel: 'whatsapp' };
const TG = { channel: 'telegram' };
const USER = { balance_eth: 0 };

/** The opening instruction, before the "Then ..." block that is always there. */
function opening(text) {
  return text.split('Then')[0];
}

describe('the first line matches what this person can actually do', () => {
  it('sends an unlinked chat to link, not to send', () => {
    const t = welcomeText(WA, USER, { linked: false });
    assert.match(opening(t), /Connect your Flizy account/);
    assert.match(opening(t), /flizy link CODE/);
  });

  it('sends someone with money waiting to claim it', () => {
    const t = welcomeText(WA, USER, { linked: true, waitingCount: 2, waitingEth: 0.015 });
    assert.match(opening(t), /0\.015 ETH waiting/);
    assert.match(opening(t), /flizy claim/);
  });

  it('names the amount only when it knows it', () => {
    const t = welcomeText(WA, USER, { linked: true, waitingCount: 1, waitingEth: null });
    assert.match(opening(t), /money waiting/);
  });

  it('sends a funded account to send', () => {
    const t = welcomeText(WA, USER, { linked: true, waitingCount: 0, hasFunds: true });
    assert.match(opening(t), /Send money like a message/);
    assert.match(opening(t), /flizy send 0\.001 to @friend on telegram/);
  });

  it('sends a linked but empty account to deposit', () => {
    const t = welcomeText(WA, USER, { linked: true, waitingCount: 0, hasFunds: false });
    assert.match(opening(t), /Add funds first/);
    assert.match(opening(t), /flizy deposit/);
  });
});

/**
 * The whole point of the change. A send suggested to someone with no funds and
 * no linked account is the failure this replaced, so it is asserted directly
 * rather than left implied by the branch tests above.
 */
describe('never opens by suggesting a send that cannot work', () => {
  const cannotSend = [
    ['not linked', { linked: false }],
    ['linked, empty', { linked: true, waitingCount: 0, hasFunds: false }],
    ['money waiting', { linked: true, waitingCount: 1, waitingEth: 0.01 }],
    ['every lookup failed', {}],
  ];

  for (const [label, state] of cannotSend) {
    it(`does not lead with send: ${label}`, () => {
      assert.doesNotMatch(opening(welcomeText(WA, USER, state)), /flizy send /);
      assert.doesNotMatch(opening(welcomeText(TG, USER, state)), /\/send /);
    });
  }

  it('leads with send only when there are funds', () => {
    const t = welcomeText(WA, USER, { linked: true, waitingCount: 0, hasFunds: true });
    assert.match(opening(t), /flizy send /);
  });
});

/**
 * welcomeState returns nulls when a lookup throws, so an RPC outage must not
 * turn the greeting into a wrong instruction. Unknown has to degrade to the
 * safe wording, never to "send".
 */
describe('an unknown state degrades safely', () => {
  it('treats no information as the empty case', () => {
    const unknown = welcomeText(WA, USER, {});
    const empty = welcomeText(WA, USER, { linked: true, waitingCount: 0, hasFunds: false });
    assert.equal(unknown, empty);
  });

  it('treats a missing state argument the same way', () => {
    assert.equal(welcomeText(WA, USER), welcomeText(WA, USER, {}));
  });
});

describe('both channels get their own dialect', () => {
  it('renders the link instruction per channel', () => {
    assert.match(welcomeText(TG, USER, { linked: false }), /\/link CODE/);
    assert.match(welcomeText(WA, USER, { linked: false }), /flizy link CODE/);
  });

  it('still carries help and lock for someone who knows what they want', () => {
    const wa = welcomeText(WA, USER, { linked: true, waitingCount: 0, hasFunds: false });
    assert.match(wa, /flizy help/);
    assert.match(wa, /flizy lock/);

    const tg = welcomeText(TG, USER, { linked: true, waitingCount: 0, hasFunds: false });
    assert.match(tg, /\/help/);
    assert.match(tg, /\/lock/);
  });

  it('keeps the dashboard and docs links on every branch', () => {
    for (const state of [{ linked: false }, { linked: true, hasFunds: true }, {}]) {
      const t = welcomeText(WA, USER, state);
      assert.match(t, /\/dashboard/);
      assert.match(t, /\/docs/);
    }
  });
});
