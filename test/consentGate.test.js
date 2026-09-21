/**
 * Analytics consent.
 *
 * GA4 and Microsoft Clarity were loading for every production visitor with
 * nothing asked, and Clarity replays the session. The gate has one job and one
 * direction that matters: anything other than an explicit yes must mean the
 * tracker is not in the document at all.
 *
 * components/Analytics.tsx cannot be imported here (it is a server component
 * and calls next/headers), so the decision function it delegates to is tested
 * directly, the same way pinRouteGate.test.js tests the gate rather than the
 * route. The last block reads the component source and proves the gate is
 * actually wired, and wired before the ids are read.
 *
 * Run: node --test test/consentGate.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let consent;

before(async () => {
  consent = await import('../web/lib/consent.ts');
});

const componentsDir = path.join(__dirname, '..', 'web', 'components');
const ANALYTICS_SRC = fs.readFileSync(path.join(componentsDir, 'Analytics.tsx'), 'utf8');
const BANNER_SRC = fs.readFileSync(path.join(componentsDir, 'CookieConsent.tsx'), 'utf8');
const LAYOUT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'app', 'layout.tsx'),
  'utf8'
);

describe('readConsent', () => {
  it('reads the two real answers', () => {
    assert.equal(consent.readConsent('granted'), 'granted');
    assert.equal(consent.readConsent('denied'), 'denied');
  });

  it('treats an absent cookie as undecided, not as yes', () => {
    assert.equal(consent.readConsent(undefined), null);
    assert.equal(consent.readConsent(null), null);
    assert.equal(consent.readConsent(''), null);
  });

  it('treats anything hand-edited as undecided', () => {
    for (const junk of ['GRANTED', 'true', '1', 'yes', 'granted ', 'accepted', '{}']) {
      assert.equal(consent.readConsent(junk), null, `"${junk}" must not read as a choice`);
    }
  });
});

describe('analyticsAllowed', () => {
  it('is true only for an explicit yes', () => {
    assert.equal(consent.analyticsAllowed('granted'), true);
  });

  it('is false for a no, for undecided, and for junk', () => {
    for (const value of ['denied', undefined, null, '', 'GRANTED', 'true', '1']) {
      assert.equal(consent.analyticsAllowed(value), false, `"${value}" must not allow analytics`);
    }
  });
});

describe('the consent cookie', () => {
  it('lasts six months, not a year and not a session', () => {
    const days = consent.CONSENT_MAX_AGE_SECONDS / 60 / 60 / 24;
    assert.equal(days, 182);
  });

  it('names itself distinctly enough not to collide with the session cookie', () => {
    const cookiesSrc = fs.readFileSync(
      path.join(__dirname, '..', 'web', 'lib', 'cookies.ts'),
      'utf8'
    );
    const names = [...cookiesSrc.matchAll(/=\s*'([a-z0-9_]+)'/gi)].map((m) => m[1]);
    assert.ok(!names.includes(consent.CONSENT_COOKIE));
  });
});

describe('Analytics refuses before it renders', () => {
  it('asks the gate, and asks it about the cookie', () => {
    assert.match(ANALYTICS_SRC, /analyticsAllowed\(cookies\(\)\.get\(CONSENT_COOKIE\)\?\.value\)/);
  });

  it('returns nothing when the answer is not yes', () => {
    // `.*` rather than a negated class: the argument is a cookies() call, so
    // the expression has parentheses of its own.
    assert.match(ANALYTICS_SRC, /if \(!analyticsAllowed\(.*\)\) return null;/);
  });

  it('decides before it touches an id, so nothing can be emitted first', () => {
    // The tags moved to AnalyticsScripts when the route allowlist was added.
    // What this still has to prove is that the consent gate returns before the
    // server component hands any id to the client half.
    const gate = ANALYTICS_SRC.indexOf('if (!analyticsAllowed');
    const handoff = ANALYTICS_SRC.indexOf('<AnalyticsScripts');
    assert.ok(gate > -1 && handoff > -1);
    assert.ok(gate < handoff, 'the consent check must run before the tags are handed over');
  });

  it('keeps the tags out of the server component entirely', () => {
    // If a <Script> comes back here it bypasses the pathname allowlist, which
    // only the client half can apply.
    assert.ok(!ANALYTICS_SRC.includes('<Script'), 'tags belong in AnalyticsScripts.tsx');
  });

  it('still refuses outside production and on preview deploys', () => {
    // The consent gate is added protection, not a replacement for the env
    // guard. Losing that would start reporting preview traffic into the live
    // property the moment someone accepted on a preview URL.
    assert.match(ANALYTICS_SRC, /if \(!isMeasurableEnv\(\)\) return null;/);
    const env = ANALYTICS_SRC.indexOf('if (!isMeasurableEnv())');
    const gate = ANALYTICS_SRC.indexOf('if (!analyticsAllowed');
    assert.ok(env > -1 && env < gate);
  });
});

describe('the banner offers a real choice', () => {
  it('gives Accept and Reject the same control, not one styled as the quiet option', () => {
    const buttons = [...BANNER_SRC.matchAll(/className="(btn[^"]*)"/g)].map((m) => m[1]);
    assert.equal(buttons.length, 2, 'expected exactly two buttons in the banner');
    assert.equal(buttons[0], buttons[1], 'Accept and Reject must carry identical styling');
    assert.ok(!BANNER_SRC.includes('btn-primary'), 'neither answer may be the primary action');
  });

  it('offers Reject before Accept in the markup, so it is never the afterthought', () => {
    const reject = BANNER_SRC.indexOf('CONSENT_DENIED)');
    const accept = BANNER_SRC.indexOf('CONSENT_GRANTED)}');
    assert.ok(reject > -1 && accept > -1);
    assert.ok(reject < accept);
  });

  it('writes the choice as a cookie the server can read, not to localStorage', () => {
    assert.match(BANNER_SRC, /document\.cookie\s*=/);
    assert.ok(!/localStorage/.test(BANNER_SRC));
  });

  it('links out to what accepting actually collects', () => {
    assert.match(BANNER_SRC, /\/privacy#analytics/);
  });
});

describe('the layout asks once, and only when there is something to ask', () => {
  it('shows the banner only while the choice is undecided', () => {
    assert.match(LAYOUT_SRC, /readConsent\(cookies\(\)\.get\(CONSENT_COOKIE\)\?\.value\) === null/);
  });

  it('does not ask when no analytics is configured at all', () => {
    assert.match(LAYOUT_SRC, /analyticsConfigured\(\) &&/);
  });

  it('renders the banner', () => {
    assert.match(LAYOUT_SRC, /askConsent \? <CookieConsent \/> : null/);
  });
});

describe('the privacy policy matches what the code does', () => {
  const PRIVACY_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'app', 'privacy', 'page.tsx'),
    'utf8'
  );

  it('has the section the banner links to', () => {
    assert.match(PRIVACY_SRC, /<LegalH id="analytics">/);
  });

  it('names every service the component can load', () => {
    for (const name of ['Google Analytics', 'Clarity', 'Umami']) {
      assert.ok(PRIVACY_SRC.includes(name), `privacy policy does not mention ${name}`);
    }
  });

  it('offers a way to change the answer, since the banner stops appearing', () => {
    assert.match(PRIVACY_SRC, /<ConsentReset \/>/);
  });
});
