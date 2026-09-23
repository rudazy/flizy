/**
 * Where an onboarding gate shows its refusal.
 *
 * Reported as "the continue button wasn't working" during signup. It was
 * working: the request ran, the server answered, and the answer rendered above
 * the page heading while the person was at the bottom of the form with the
 * keyboard open. A refusal nobody can see is indistinguishable from a dead
 * button, and it cost a real signup.
 *
 * The database side was never at fault. Verified against dev: a username saves,
 * a duplicate is refused with 23505, a reserved name with FZ002, and the route
 * turns both into the one unavailable message, which says to choose another and
 * deliberately does not say which of the two it was.
 *
 * These tests pin the placement, because it is the kind of thing a later tidy-up
 * moves back to the top of the component without realising what it costs.
 *
 * Run: node --test test/signupGateErrors.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');

const PROFILE = read('components', 'ProfileCompleteGate.tsx');
const EMAIL = read('components', 'EmailVerifyGate.tsx');
const SIGNUP = read('app', 'signup', 'SignupForm.tsx');
const LOGIN = read('app', 'login', 'LoginForm.tsx');

/** Index of the alert that carries a refusal, and of the submit button. */
function positions(src) {
  return {
    error: src.indexOf('alert-error'),
    submit: src.indexOf('type="submit"'),
  };
}

describe('a refusal renders below the heading, not above it', () => {
  // The regression that caused this: the alert was a sibling of the heading
  // block, so it sat at the very top of the page, a scroll away from the
  // button on a phone with the keyboard open.
  for (const [name, src] of [
    ['ProfileCompleteGate', PROFILE],
    ['EmailVerifyGate', EMAIL],
    ['SignupForm', SIGNUP],
    ['LoginForm', LOGIN],
  ]) {
    it(`${name} keeps the error below the heading and before the button`, () => {
      const { error, submit } = positions(src);
      const heading = src.indexOf('<h1');
      assert.ok(error > -1, `${name} has no error alert at all`);
      assert.ok(submit > -1, `${name} has no submit button`);
      if (heading > -1) {
        assert.ok(error > heading, `${name}: the error is above the heading again`);
      }
      assert.ok(error < submit, `${name}: the error must come before the submit button`);
    });
  }

  // Single-action forms get the stricter rule: nothing between the message and
  // the button that produced it. EmailVerifyGate is excluded on purpose, it has
  // two actions (send a code, verify a code) sharing one slot, so its alert
  // sits at the top of the card that holds both rather than beside either.
  for (const [name, src] of [
    ['ProfileCompleteGate', PROFILE],
    ['SignupForm', SIGNUP],
    ['LoginForm', LOGIN],
  ]) {
    it(`${name} puts nothing between the error and the button`, () => {
      const { error, submit } = positions(src);
      assert.ok(
        !src.slice(error, submit).includes('<input'),
        `${name}: a field sits between the error and the button, pushing the error out of view`
      );
    });
  }

  it('EmailVerifyGate keeps its alert inside the card with the buttons', () => {
    const cardAt = EMAIL.indexOf('rounded-md border border-border');
    const { error } = positions(EMAIL);
    assert.ok(cardAt > -1, 'the action card is gone');
    assert.ok(error > cardAt, 'the alert drifted back outside the card');
  });

  it('both gates announce the refusal to a screen reader', () => {
    assert.match(PROFILE, /role="alert"/);
    assert.match(EMAIL, /role="alert"/);
  });
});

describe('the username gate helps before it refuses', () => {
  it('moves focus back to the field it refused', () => {
    assert.match(PROFILE, /usernameRef\.current\?\.focus\(\)/);
    assert.match(PROFILE, /ref=\{usernameRef\}/);
  });

  it('shows the problem live, not only after a submit', () => {
    assert.match(PROFILE, /liveProblem/);
    assert.match(PROFILE, /const liveCheck = validateUsername\(username\)/);
  });

  it('stays quiet on an empty field', () => {
    // Nagging someone who has not typed yet is noise. The live hint is gated on
    // there being something to judge.
    assert.match(PROFILE, /!trimmed \|\| liveCheck\.ok/);
  });

  it('clears a stale refusal as soon as the value changes', () => {
    assert.match(PROFILE, /if \(error\) setError\(''\)/);
  });

  it('marks the field invalid for assistive tech', () => {
    assert.match(PROFILE, /aria-invalid=\{error \? true : undefined\}/);
  });
});

describe('the email gate explains its disabled button', () => {
  it('still requires six digits', () => {
    assert.match(EMAIL, /code\.length !== 6/);
  });

  it('but says how many are missing, so the dead button is legible', () => {
    // A disabled control with no explanation is the same complaint in a
    // different costume.
    assert.match(EMAIL, /more digit/);
    assert.match(EMAIL, /gate-code-hint/);
    assert.match(EMAIL, /aria-describedby="gate-code-hint"/);
  });
});

describe('the picker says a name is taken before Continue is pressed', () => {
  const CHECK = read('app', 'api', 'account', 'username', 'check', 'route.ts');
  const PROFILE_ROUTE = read('app', 'api', 'account', 'profile', 'route.ts');

  it('the lookup is signed in only', () => {
    // Username existence is already public via /pay/{username}, so this leaks
    // nothing new, but a session stops it being a comfortable way to walk the
    // whole table.
    assert.match(CHECK, /getAccountIdFromCookie\(\)/);
    assert.match(CHECK, /status: 401/);
  });

  it('it asks the same two questions the save path asks', () => {
    // If these drift, the picker can promise a name that POST then refuses.
    for (const src of [CHECK, PROFILE_ROUTE]) {
      assert.match(src, /isUsernameReserved\(/);
      assert.match(src, /USERNAME_UNAVAILABLE/);
    }
    assert.match(CHECK, /\.eq\('username', check\.username\)/);
  });

  it('it does not call your own current name unavailable', () => {
    assert.match(CHECK, /holder\.id !== accountId/);
  });

  it('it never says which of reserved or taken it was', () => {
    // Assert what the route can actually put in `reason`, rather than scanning
    // source text: `isUsernameReserved` is a function name and reaches nobody.
    const reasons = [...CHECK.matchAll(/reason:\s*([A-Za-z_.]+)/g)].map((m) => m[1]);
    assert.ok(reasons.length > 0, 'the route returns no reason at all');
    for (const r of reasons) {
      assert.ok(
        r === 'USERNAME_UNAVAILABLE' || r === 'check.error',
        `unexpected reason source "${r}": it may leak which check failed`
      );
    }
  });

  it('the picker debounces and ignores a stale answer', () => {
    // Without the name tag, a slow reply for an earlier keystroke overwrites
    // the verdict for whatever is in the box now.
    assert.match(PROFILE, /setTimeout\(/);
    assert.match(PROFILE, /taken\.name !== liveCheck\.username/);
    assert.match(PROFILE, /if \(cancelled\) return;/);
  });

  it('a failed lookup stays quiet rather than blocking the person', () => {
    assert.match(PROFILE, /A failed lookup is not a refusal/);
  });
});
