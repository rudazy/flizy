/**
 * What may leave this machine when an error is reported.
 *
 * Sentry sends error data to a third party, so this is the file that decides
 * whether a crash report is a debugging aid or a data leak. The standing rule
 * forbids sending user PII of any kind, wallet keys, API keys or request
 * bodies, and the 2026-08-31 identity decision forbids an account id in a log
 * -- an account id in a Sentry event is a log that left the building.
 *
 * The tests are written as "this exact string must not survive", because the
 * PII in this app arrives inside error *messages* ("no account for
 * 2348012345678") rather than in tidy named fields.
 *
 * Run: node --test test/errorScrub.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { scrubText, scrubValue, scrubEvent } = require('../lib/errorScrub');

describe('nothing that identifies a person survives a message', () => {
  const cases = [
    ['a phone number', 'no account for 2348012345678', '2348012345678', '[phone]'],
    ['a phone with country code', 'sent to +2348099999999', '2348099999999', '[phone]'],
    // An error can echo back what a user typed, so the separated forms matter
    // as much as the bare digits this app actually stores.
    ['a spaced phone', 'call 234 801 234 5678 now', '234 801 234 5678', '[phone]'],
    ['a dashed phone', 'call 234-801-234-5678 now', '234-801-234-5678', '[phone]'],
    ['an account id', 'account 52488385-1234-4000-8000-abcdefabcdef missing', '52488385-1234-4000-8000-abcdefabcdef', '[id]'],
    ['an email', 'no user with ada@example.com here', 'ada@example.com', '[email]'],
    ['a wallet address', 'send to 0x1111111111111111111111111111111111111111 failed', '0x1111111111111111111111111111111111111111', '[address]'],
  ];

  for (const [what, input, mustNotSurvive, replacement] of cases) {
    it(`redacts ${what}`, () => {
      const out = scrubText(input);
      assert.doesNotMatch(out, new RegExp(mustNotSurvive.replace(/[+.]/g, '\\$&')));
      assert.match(out, new RegExp(replacement.replace(/[[\]]/g, '\\$&')));
    });
  }

  it('redacts a private key before it can be mistaken for an address', () => {
    // Both start 0x. The 64-hex form is a key and must never be labelled as a
    // mere address, so the longer pattern has to win.
    const key = `0x${'a'.repeat(64)}`;
    const out = scrubText(`key ${key} leaked`);
    assert.doesNotMatch(out, /aaaa/);
    assert.match(out, /\[redacted\]/);
    assert.doesNotMatch(out, /\[address\]/);
  });

  it('does not eat the parts of an error worth reading', () => {
    // A scrubber that removes everything makes the monitoring useless. Amounts,
    // chain ids and the actual failure have to come through.
    const out = scrubText('insufficient balance: 0.025 ETH on chain 91342');
    assert.match(out, /insufficient balance/);
    assert.match(out, /0\.025 ETH/);
    assert.match(out, /91342/);
  });
});

describe('fields that are PII by name are dropped, not scrubbed', () => {
  it('drops the whole value', () => {
    const out = scrubValue({
      accountId: '52488385-1234-4000-8000-abcdefabcdef',
      external_id: '2348012345678',
      agent_wallet_address: '0x1111111111111111111111111111111111111111',
      amount: '0.02',
    });
    assert.deepEqual(Object.keys(out), ['amount']);
  });

  it('drops request bodies, headers and cookies wherever they appear', () => {
    const out = scrubValue({ request: { headers: { cookie: 'session=x' }, data: { pin: '1234' } } });
    assert.equal(JSON.stringify(out).includes('1234'), false);
    assert.equal(JSON.stringify(out).includes('session'), false);
  });

  it('reaches PII nested inside arrays and objects', () => {
    const out = scrubValue({ steps: [{ note: 'paid 2348012345678' }] });
    assert.equal(out.steps[0].note, 'paid [phone]');
  });

  it('stops at a depth rather than following a deep structure forever', () => {
    let deep = { v: 'paid 2348012345678' };
    for (let i = 0; i < 30; i += 1) deep = { nested: deep };
    // The point is that it terminates and says so, not what the value is.
    assert.equal(JSON.stringify(scrubValue(deep)).includes('2348012345678'), false);
  });
});

/**
 * The one that actually proves it.
 *
 * Everything above tests the scrubber in isolation, which says nothing about
 * whether the SDK is wired to use it. This drives the real @sentry/node with a
 * transport that intercepts the envelope, so it asserts what would leave the
 * machine rather than what a function returns.
 */
describe('what the SDK would actually transmit', () => {
  it('sends the redacted form, never the original', async () => {
    const Sentry = require('@sentry/node');
    const { scrubEvent: scrub } = require('../lib/errorScrub');

    let envelope = null;
    Sentry.init({
      dsn: 'https://abc123@o0.ingest.sentry.io/0',
      sendDefaultPii: false,
      defaultIntegrations: false,
      integrations: [],
      tracesSampleRate: 0,
      beforeSend: (e) => scrub(e),
      beforeBreadcrumb: () => null,
      transport: () => ({
        send: async (env) => {
          envelope = JSON.stringify(env);
          return {};
        },
        flush: async () => true,
      }),
    });

    Sentry.captureException(
      new Error('pay failed for 2348012345678 on 52488385-1234-4000-8000-abcdefabcdef')
    );
    await Sentry.flush(2000);

    assert.ok(envelope, 'nothing was transmitted, so nothing was proven');
    assert.equal(envelope.includes('2348012345678'), false, 'a phone number left the machine');
    assert.equal(
      envelope.includes('52488385-1234-4000-8000-abcdefabcdef'),
      false,
      'an account id left the machine'
    );
    assert.ok(envelope.includes('[phone]') && envelope.includes('[id]'));
  });
});

describe('the event Sentry would send', () => {
  const event = () => ({
    message: 'pay failed for 2348012345678',
    user: { id: 'acc-1', email: 'a@b.com', ip_address: '1.2.3.4' },
    request: { headers: { cookie: 'session=abc' }, data: { pin: '1234' } },
    server_name: 'flizy-vps-1',
    extra: { accountId: '52488385-1234-4000-8000-abcdefabcdef', amount: '0.02' },
  });

  it('carries no user, request or hostname at all', () => {
    const out = scrubEvent(event());
    assert.equal(out.user, undefined);
    assert.equal(out.request, undefined);
    assert.equal(out.server_name, undefined, 'the machine name is infrastructure detail');
  });

  it('keeps what makes the report useful', () => {
    const out = scrubEvent(event());
    assert.match(out.message, /pay failed/);
    assert.equal(out.extra.amount, '0.02');
  });

  it('leaks nothing anywhere in the serialized result', () => {
    // The blunt check: whatever the shape, none of these may appear.
    const json = JSON.stringify(scrubEvent(event()));
    for (const secret of ['2348012345678', 'a@b.com', '1.2.3.4', 'session=abc', '1234', '52488385-1234-4000-8000-abcdefabcdef']) {
      assert.equal(json.includes(secret), false, `${secret} survived into the event`);
    }
  });

  it('does not mutate the event it was given', () => {
    // beforeSend runs on the live object; mutating it would change what the
    // application itself goes on to log.
    const original = event();
    scrubEvent(original);
    assert.equal(original.message, 'pay failed for 2348012345678');
    assert.ok(original.user, 'the caller lost its own data');
  });

  it('reports that it could not clean, rather than dropping silently', () => {
    // Returning null here would make the monitoring under-report failures,
    // which is a worse failure than a vague report.
    const hostile = {};
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    const out = scrubEvent(hostile);
    assert.ok(out, 'a report was dropped instead of being sent');
    assert.match(out.message, /could not be scrubbed/);
  });
});
