/**
 * The browser half of error reporting.
 *
 * The bots (lib/sentry.js) and the server (web/instrumentation-node.ts) have
 * reported since August under three rules: off without a DSN and outside
 * production, no default instrumentation collecting request data, and nothing
 * sent that the scrubber has not seen. The browser had no reporting at all, so
 * a React render error was visible only to the person it happened to.
 *
 * None of these files can be imported here: instrumentation-client.ts calls
 * Sentry.init at module scope against a browser SDK, and global-error.tsx is
 * JSX. So this reads them, the same way errorScrubDrift.test.js reads the web
 * scrubber. What matters is that the browser is held to the rules the other two
 * halves already follow, and that nothing here quietly relaxes one.
 *
 * Run: node --test test/sentryClient.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');

const CLIENT = read('instrumentation-client.ts');
const SERVER = read('instrumentation-node.ts');
const GLOBAL_ERROR = read('app', 'global-error.tsx');
const NEXT_CONFIG = read('next.config.mjs');

describe('the client SDK is off unless it is wanted', () => {
  it('needs a DSN and production, the same switch as the other two halves', () => {
    assert.match(CLIENT, /if \(DSN && process\.env\.NODE_ENV === 'production'\)/);
  });

  it('reads its own public DSN, not the server one', () => {
    // SENTRY_DSN is server-only and must not be inlined into a client bundle,
    // even though a DSN is public: the two are separate so the server can
    // report while the browser does not.
    assert.match(CLIENT, /NEXT_PUBLIC_SENTRY_DSN/);
    assert.ok(
      !/process\.env\.SENTRY_DSN/.test(CLIENT),
      'the client must not reach for the server DSN'
    );
  });
});

describe('a preview deploy does not pose as production', () => {
  // Vercel builds a preview with NODE_ENV=production and gives it the
  // production variables, so without this both halves would tag preview errors
  // `production` and the production stream would stop meaning anything.
  it('the client takes its environment from the deploy, not a constant', () => {
    assert.match(CLIENT, /NEXT_PUBLIC_VERCEL_ENV/);
    assert.ok(
      !/environment: process\.env\.NEXT_PUBLIC_SENTRY_ENVIRONMENT \|\| 'production'/.test(CLIENT),
      'a hardcoded production fallback re-creates the bug'
    );
  });

  it('the server does the same, from its own variable', () => {
    assert.match(SERVER, /process\.env\.VERCEL_ENV/);
    assert.ok(
      !/environment: process\.env\.SENTRY_ENVIRONMENT \|\| 'production'/.test(SERVER),
      'a hardcoded production fallback re-creates the bug'
    );
  });

  it('an explicit override still wins in both', () => {
    for (const [name, src] of [['client', CLIENT], ['server', SERVER]]) {
      const explicit = src.indexOf('const explicit =');
      const fallback = src.indexOf('VERCEL_ENV');
      assert.ok(explicit > -1 && fallback > -1, `${name} lost the override`);
      assert.ok(explicit < fallback, `${name} checks the deploy before the override`);
    }
  });

  it('the template does not hardcode it back', () => {
    // An uncommented SENTRY_ENVIRONMENT=production in .env.example would be
    // copied into Vercel and win over the detection above, undoing all of it.
    const example = fs.readFileSync(path.join(WEB, '..', '.env.example'), 'utf8');
    assert.ok(
      !/^SENTRY_ENVIRONMENT=production/m.test(example),
      '.env.example pins the environment and defeats preview detection'
    );
  });
});

describe('the client sends no more than the server does', () => {
  it('scrubs every event', () => {
    assert.match(CLIENT, /beforeSend: \(event\) => scrubEvent\(event\)/);
    assert.match(CLIENT, /from '\.\/lib\/errorScrub'/);
  });

  it('drops breadcrumbs, which in a browser are URLs and console output', () => {
    assert.match(CLIENT, /beforeBreadcrumb: \(\) => null/);
  });

  it('sends no default PII', () => {
    assert.match(CLIENT, /sendDefaultPii: false/);
  });

  it('runs no tracing', () => {
    assert.match(CLIENT, /tracesSampleRate: 0/);
  });

  it('runs no session replay, explicitly rather than by default', () => {
    // Replay is a recording of the page. Clarity was just taken off the
    // dashboard for exactly that; re-adding it under another vendor would be
    // the same mistake with a different logo.
    assert.match(CLIENT, /replaysSessionSampleRate: 0/);
    assert.match(CLIENT, /replaysOnErrorSampleRate: 0/);
  });

  it('matches the server half on every shared setting', () => {
    for (const setting of [
      'sendDefaultPii: false',
      'tracesSampleRate: 0',
      'beforeBreadcrumb: () => null',
    ]) {
      assert.ok(SERVER.includes(setting), `server lost ${setting}`);
      assert.ok(CLIENT.includes(setting), `client lost ${setting}`);
    }
  });
});

describe('global-error reports without exposing anything', () => {
  it('exists, which is what carries a React render error to Sentry', () => {
    assert.match(GLOBAL_ERROR, /Sentry\.captureException\(error\)/);
  });

  it('renders its own document, since the root layout is gone by then', () => {
    assert.match(GLOBAL_ERROR, /<html/);
    assert.match(GLOBAL_ERROR, /<body/);
  });

  it('carries its own viewport, which the root layout can no longer supply', () => {
    // Replacing the document also discards the layout's viewport export, and
    // without the tag a phone renders this at desktop width.
    assert.match(GLOBAL_ERROR, /name="viewport"/);
    assert.match(GLOBAL_ERROR, /width=device-width/);
  });

  it('is not indexable', () => {
    assert.match(GLOBAL_ERROR, /name="robots" content="noindex"/);
  });

  it('never prints the error text to the visitor', () => {
    // error.message on a money app can hold an address, an amount, or whatever
    // a failed call echoed back, and this page is reachable signed out.
    assert.ok(
      !/\{error\.message\}/.test(GLOBAL_ERROR),
      'global-error must not render error.message'
    );
    assert.ok(
      !/\{error\.stack\}/.test(GLOBAL_ERROR),
      'global-error must not render a stack trace'
    );
    // The digest is Next's own correlation id and carries nothing of the error.
    assert.match(GLOBAL_ERROR, /error\.digest/);
  });
});

describe('the build is wired for it', () => {
  it('wraps the config, without which the client file is never bundled', () => {
    assert.match(NEXT_CONFIG, /export default withSentryConfig\(nextConfig,/);
  });

  it('imports the wrapper from /config, the path that survives v11', () => {
    assert.match(NEXT_CONFIG, /from '@sentry\/nextjs\/config'/);
    assert.ok(
      !/from '@sentry\/nextjs'/.test(NEXT_CONFIG),
      'the package-root re-export is deprecated and warns on every build'
    );
  });

  it('uses no build option that warns', () => {
    // disableLogger is deprecated in favour of webpack.treeshake. A build that
    // prints a deprecation on every run trains people to ignore build output.
    assert.ok(!/disableLogger/.test(NEXT_CONFIG));
    assert.match(NEXT_CONFIG, /removeDebugLogging: true/);
  });

  it('lets the browser reach the ingest host, or CSP would block every report', async () => {
    // The host is built in the policy module. The config's job is to pass the
    // public DSN through, or a deploy with reporting on would still be blocked.
    assert.match(
      NEXT_CONFIG,
      /contentSecurityPolicy\(\{[\s\S]*dsn: process\.env\.NEXT_PUBLIC_SENTRY_DSN/
    );
    const { contentSecurityPolicy } = await import('../web/lib/contentSecurityPolicy.mjs');
    const header = contentSecurityPolicy({
      dev: false,
      dsn: 'https://public@o123.ingest.sentry.io/1',
    });
    assert.match(header, /connect-src[^;]*https:\/\/o123\.ingest\.sentry\.io/);
  });

  it('derives that host from the DSN and adds nothing when there is none', async () => {
    const { contentSecurityPolicy } = await import('../web/lib/contentSecurityPolicy.mjs');
    const bare = contentSecurityPolicy({ dev: false, dsn: '' });
    const named = contentSecurityPolicy({
      dev: false,
      dsn: 'https://public@o123.ingest.sentry.io/1',
    });
    assert.doesNotMatch(bare, /ingest\.sentry\.io/);
    assert.match(named, /https:\/\/o123\.ingest\.sentry\.io/);
  });

  it('puts only an https origin in the header', async () => {
    // A javascript: or data: DSN parses and its origin is the string "null",
    // which would land in connect-src as a bare token. An http: one would name
    // a plaintext endpoint in a policy that ends in upgrade-insecure-requests.
    const { sentryIngestOrigin, contentSecurityPolicy } = await import(
      '../web/lib/contentSecurityPolicy.mjs'
    );
    assert.equal(sentryIngestOrigin('http://o123.ingest.sentry.io/1'), '');
    assert.equal(sentryIngestOrigin('javascript:alert(1)'), '');
    assert.equal(sentryIngestOrigin('data:text/plain,hi'), '');
    const header = contentSecurityPolicy({
      dev: false,
      dsn: 'http://o123.ingest.sentry.io/1',
    });
    assert.doesNotMatch(header, /o123\.ingest\.sentry\.io/);
  });

  it('cannot inject into the header, whatever the DSN says', () => {
    // Belt and braces on the reasoning above: a URL origin cannot hold a space
    // or a semicolon, so it cannot add a directive of its own.
    for (const dsn of [
      'https://k@host.example/1',
      'https://k@host.example:8443/1',
      'https://k@sub.domain.ingest.sentry.io/99',
    ]) {
      const origin = new URL(dsn).origin;
      assert.ok(!/[;\s]/.test(origin), `${origin} could break out of the directive`);
    }
  });

  it('only uploads source maps when it has all three credentials', () => {
    assert.match(NEXT_CONFIG, /disable: !hasUploadCredentials/);
    for (const v of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
      assert.ok(NEXT_CONFIG.includes(v), `${v} is not part of the upload check`);
    }
  });

  it('never leaves a source map on the deployment', () => {
    // hidden-source-map means nothing points at them, but the .map files still
    // sit at guessable paths under /_next and would hand over the full source.
    assert.match(NEXT_CONFIG, /deleteSourcemapsAfterUpload: true/);
  });

  it('does not tunnel reports through this app', () => {
    // The option, not the word: the config explains in prose why a tunnel was
    // rejected, and matching that prose would pass for the wrong reason.
    assert.ok(
      !/tunnelRoute\s*:/.test(NEXT_CONFIG),
      'a tunnel would stand up a public endpoint forwarding to a third party'
    );
  });
});

describe('the scrubber covers what the browser adds', () => {
  const scrub = require('../lib/errorScrub');

  it('redacts a claim token, which is 32 bare hex and lives in a page URL', () => {
    const out = scrub.scrubText('no hold for 9f3a1c2b4d5e60718293a4b5c6d7e8f0');
    assert.ok(!out.includes('9f3a1c2b4d5e60718293a4b5c6d7e8f0'));
    assert.match(out, /\[redacted\]/);
  });

  it('still removes the request, and with it the page URL', () => {
    const cleaned = scrub.scrubEvent({
      request: { url: 'https://flizy.app/claim/9f3a1c2b4d5e60718293a4b5c6d7e8f0' },
      message: 'boom',
    });
    assert.equal(cleaned.request, undefined);
    assert.equal(cleaned.message, 'boom');
  });

  it('leaves an ordinary short hex value alone, so reports stay useful', () => {
    assert.equal(scrub.scrubText('chain 91342 block 0x1a2b'), 'chain 91342 block 0x1a2b');
  });
});
