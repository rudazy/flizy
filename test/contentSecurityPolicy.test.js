/**
 * The dev server's bundle uses eval. Production must not allow it.
 * Run: node --test test/contentSecurityPolicy.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

describe('contentSecurityPolicy', () => {
  let policy;

  before(async () => {
    policy = await import('../web/lib/contentSecurityPolicy.mjs');
  });

  it('allows eval only for the development server', () => {
    const dev = policy.contentSecurityPolicy({ dev: true, dsn: '' });
    const prod = policy.contentSecurityPolicy({ dev: false, dsn: '' });
    assert.match(dev, /script-src[^;]*'unsafe-eval'/);
    assert.doesNotMatch(prod, /unsafe-eval/);
    assert.match(prod, /script-src 'self' 'unsafe-inline' https:\/\/www\.googletagmanager\.com https:\/\/www\.clarity\.ms/);
  });

  it('names an https Sentry ingest host and refuses anything else', () => {
    const withSentry = policy.contentSecurityPolicy({
      dev: false,
      dsn: 'https://abc@o123.ingest.sentry.io/456',
    });
    assert.match(withSentry, /connect-src[^;]*https:\/\/o123\.ingest\.sentry\.io/);
    assert.equal(policy.sentryIngestOrigin('http://o123.ingest.sentry.io/456'), '');
    assert.equal(policy.sentryIngestOrigin('javascript:alert(1)'), '');
    assert.equal(policy.sentryIngestOrigin('not a url'), '');
  });
});
