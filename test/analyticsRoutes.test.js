/**
 * Where analytics is allowed to run.
 *
 * `<Analytics />` lives in the root layout, so before the allowlist it covered
 * every route: Clarity session replay over `/dashboard`, which renders emails,
 * phone numbers, the agent wallet address and balances as page text, and
 * `/claim/<token>` in a path GA4 and Clarity both transmit, while the route
 * handler for that token calls it the credential for the claim.
 *
 * The cases that matter here are the refusals. An allowlist that lets one
 * private route through is not a smaller version of this fix, it is the bug.
 *
 * Run: node --test test/analyticsRoutes.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let routes;

before(async () => {
  routes = await import('../web/lib/analyticsRoutes.ts');
});

const APP_DIR = path.join(__dirname, '..', 'web', 'app');
const SCRIPTS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'components', 'AnalyticsScripts.tsx'),
  'utf8'
);

/** Every route that renders a page, read off the filesystem. */
function realRoutes(dir = APP_DIR, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...realRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      out.push(prefix || '/');
    }
  }
  return out;
}

/** `/claim/[token]` is not a path a browser ever reports; fill the segments. */
function concreteUrl(route) {
  return route.replace(/\[([^\]]+)\]/g, (_m, name) => `sample-${name}`);
}

describe('public paths are allowed', () => {
  it('allows each one exactly as listed', () => {
    for (const p of routes.ANALYTICS_PUBLIC_PATHS) {
      assert.equal(routes.analyticsAllowedPath(p), true, `${p} should be allowed`);
    }
  });

  it('ignores a trailing slash', () => {
    assert.equal(routes.analyticsAllowedPath('/docs/'), true);
    assert.equal(routes.analyticsAllowedPath('/'), true);
    assert.equal(routes.analyticsAllowedPath(''), true);
  });

  it('every entry still points at a page that exists', () => {
    const real = new Set(realRoutes());
    for (const p of routes.ANALYTICS_PUBLIC_PATHS) {
      assert.ok(real.has(p), `${p} is allowlisted but no page.tsx serves it`);
    }
  });
});

describe('private paths are refused', () => {
  it('refuses the whole dashboard', () => {
    for (const p of [
      '/dashboard',
      '/dashboard/',
      '/dashboard/account',
      '/dashboard/wallet',
      '/dashboard/history',
      '/dashboard/swap',
    ]) {
      assert.equal(routes.analyticsAllowedPath(p), false, `${p} must not be measured`);
    }
  });

  it('refuses a claim URL, which carries the credential in the path', () => {
    assert.equal(routes.analyticsAllowedPath('/claim/9f3a1c2b4d5e'), false);
    assert.equal(routes.analyticsAllowedPath('/claim/9f3a1c2b4d5e/ref-1'), false);
  });

  it('refuses pay pages', () => {
    assert.equal(routes.analyticsAllowedPath('/pay/591568668'), false);
    assert.equal(routes.analyticsAllowedPath('/pay/c/591568668'), false);
  });

  it('does not let a child inherit its parent permission', () => {
    assert.equal(routes.analyticsAllowedPath('/docs'), true);
    assert.equal(routes.analyticsAllowedPath('/docs/internal'), false);
    assert.equal(routes.analyticsAllowedPath('/privacy/export'), false);
  });

  it('refuses anything nobody has thought about', () => {
    for (const p of ['/admin', '/api/dashboard', '/whatever', '/dashboard/../privacy']) {
      assert.equal(routes.analyticsAllowedPath(p), false, `${p} must default to refused`);
    }
  });

  it('refuses a missing or non-string path rather than defaulting open', () => {
    for (const p of [null, undefined, 42, {}, []]) {
      assert.equal(routes.analyticsAllowedPath(p), false);
    }
  });
});

describe('a credential in the query of an allowed page', () => {
  it('refuses the claim flow that sends a signed-out visitor to login', () => {
    // claim/[token]/page.tsx does exactly this, in five places.
    const token = '9f3a1c2b4d5e';
    const search = `next=${encodeURIComponent(`/claim/${token}`)}`;
    assert.equal(routes.analyticsAllowedPath('/login'), true, 'the path alone is allowed');
    assert.equal(
      routes.analyticsAllowedUrl('/login', search),
      false,
      'the URL carrying the token must not be'
    );
    assert.equal(routes.analyticsAllowedUrl('/signup', search), false);
  });

  it('refuses a next pointing anywhere else private', () => {
    for (const next of ['/dashboard', '/dashboard/wallet', '/pay/591568668']) {
      assert.equal(
        routes.analyticsAllowedUrl('/login', `next=${encodeURIComponent(next)}`),
        false,
        `next=${next} must not be measured`
      );
    }
  });

  it('refuses a double-encoded private path', () => {
    assert.equal(routes.analyticsAllowedUrl('/login', 'next=%252Fclaim%252Fabc'), false);
  });

  it('refuses an absolute URL smuggling the same path', () => {
    assert.equal(
      routes.analyticsAllowedUrl('/login', 'next=https://flizy.app/claim/abc'),
      false
    );
  });

  it('refuses a private path under any parameter name, not just next', () => {
    assert.equal(routes.analyticsAllowedUrl('/login', 'r=/claim/abc'), false);
    assert.equal(routes.analyticsAllowedUrl('/', 'anything=/dashboard/account'), false);
  });

  it('still measures an ordinary campaign query', () => {
    assert.equal(
      routes.analyticsAllowedUrl('/', 'utm_source=x&utm_medium=cpc&utm_campaign=launch'),
      true
    );
    assert.equal(routes.analyticsAllowedUrl('/signup', 'invite=someone'), true);
    assert.equal(routes.analyticsAllowedUrl('/login', 'next=%2Fdocs'), true);
  });

  it('measures an allowed path with no query at all', () => {
    for (const search of ['', null, undefined]) {
      assert.equal(routes.analyticsAllowedUrl('/docs', search), true);
    }
  });

  it('never rescues a path the allowlist already refused', () => {
    assert.equal(routes.analyticsAllowedUrl('/dashboard', ''), false);
    assert.equal(routes.analyticsAllowedUrl('/claim/abc', 'utm_source=x'), false);
  });
});

describe('the real route tree', () => {
  it('measures only the public pages and nothing under dashboard, claim or pay', () => {
    const measured = realRoutes()
      .map(concreteUrl)
      .filter((url) => routes.analyticsAllowedPath(url))
      .sort();

    assert.deepEqual(measured, [...routes.ANALYTICS_PUBLIC_PATHS].sort());
    for (const url of measured) {
      assert.ok(
        !url.startsWith('/dashboard') && !url.startsWith('/claim') && !url.startsWith('/pay'),
        `${url} is measured and should not be`
      );
    }
  });
});

describe('AnalyticsScripts enforces it', () => {
  it('decides on the live pathname, not on where the document was opened', () => {
    assert.match(SCRIPTS_SRC, /usePathname\(\)/);
  });

  it('decides on the query too, not the path alone', () => {
    assert.match(SCRIPTS_SRC, /useSearchParams\(\)/);
    assert.match(SCRIPTS_SRC, /analyticsAllowedUrl\(pathname, searchParams/);
    assert.ok(
      !/analyticsAllowedPath\(/.test(SCRIPTS_SRC),
      'the path-only check would miss /login?next=/claim/<token>'
    );
  });

  it('is rendered behind a Suspense boundary, which useSearchParams requires', () => {
    const layout = fs.readFileSync(
      path.join(__dirname, '..', 'web', 'app', 'layout.tsx'),
      'utf8'
    );
    assert.match(layout, /<Suspense fallback=\{null\}>\s*<Analytics \/>\s*<\/Suspense>/);
  });

  it('renders nothing off the allowlist', () => {
    assert.match(SCRIPTS_SRC, /if \(!allowed \|\| stopped\) return null;/);
  });

  it('switches running tags off, because unmounting a script does not unload it', () => {
    assert.match(SCRIPTS_SRC, /ga-disable-/);
    assert.match(SCRIPTS_SRC, /clarity\?\.\('stop'\)/);
  });

  it('does that before paint', () => {
    assert.match(SCRIPTS_SRC, /useBeforePaint\(\(\) => \{/);
    assert.match(SCRIPTS_SRC, /useLayoutEffect/);
  });

  it('never lets a tag choose its own pageview path', () => {
    // Both would otherwise track history changes themselves and send
    // /claim/<token> on a soft navigation, governed by a dashboard setting
    // rather than by this code.
    assert.match(SCRIPTS_SRC, /send_page_view: false/);
    assert.match(SCRIPTS_SRC, /data-auto-track="false"/);
  });

  it('sends a pageview only while the path is allowed', () => {
    const guard = SCRIPTS_SRC.indexOf('if (!allowed || stopped || !pathname) return;');
    const send = SCRIPTS_SRC.indexOf("'page_view'");
    assert.ok(guard > -1 && send > -1);
    assert.ok(guard < send, 'the pageview must be behind the allowlist check');
  });
});
