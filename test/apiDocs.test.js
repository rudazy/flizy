/**
 * The public API docs (docs-site/) against the code they describe, so the two
 * cannot drift: every /api/v1 route and method is in the OpenAPI spec and the
 * spec has nothing else; the error codes, payout failure codes, states,
 * permissions, recipient types, request fields, response fields and webhook
 * events are exactly the code's; the numbers the pages quote are the code's;
 * the JavaScript signature check in the webhooks guide accepts a real Flizy
 * signature and refuses a tampered or stale one.
 *
 * Run: node --test test/apiDocs.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs-site');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const page = (name) => fs.readFileSync(path.join(DOCS, `${name}.mdx`), 'utf8');
const spec = JSON.parse(read('docs-site/openapi.json'));
const config = JSON.parse(read('docs-site/docs.json'));
const schemas = spec.components.schemas;
const sorted = (xs) => [...new Set(xs)].sort();
const all = (re, text) => [...text.matchAll(re)].map((m) => m[1]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}
const routeFiles = walk('web/app/api/v1').filter((f) => f.endsWith('/route.ts'));
const docFiles = walk('docs-site');

describe('the docs site', () => {
  it('has the required config, and every page it lists exists', () => {
    assert.equal(typeof config.name, 'string');
    assert.equal(typeof config.theme, 'string');
    assert.match(config.colors.primary, /^#[0-9a-f]{6}$/i);
    const pages = config.navigation.tabs.flatMap((t) => t.groups.flatMap((g) => g.pages || []));
    assert.ok(pages.length >= 10);
    for (const p of pages) assert.ok(fs.existsSync(path.join(DOCS, `${p}.mdx`)), p);
    const openapi = config.navigation.tabs.flatMap((t) => t.groups.map((g) => g.openapi).filter(Boolean));
    assert.deepEqual(openapi, ['openapi.json']);
    for (const f of [config.logo.light, config.logo.dark, config.favicon]) assert.ok(fs.existsSync(path.join(DOCS, f)), f);
  });

  it('every page links only to pages that exist', () => {
    const pages = new Set(config.navigation.tabs.flatMap((t) => t.groups.flatMap((g) => g.pages || [])));
    for (const f of docFiles.filter((x) => x.endsWith('.mdx'))) {
      const text = read(f);
      // Markdown links and component hrefs to other pages of the site.
      for (const href of [...all(/\]\((\/[a-z/-]+)\)/g, text), ...all(/href="(\/[a-z/-]+)"/g, text)]) {
        assert.ok(pages.has(href.slice(1)), `${f}: ${href}`);
      }
    }
  });

  it('names no hosting provider, private file, project ref or secret, and stays ASCII', () => {
    for (const f of docFiles) {
      const text = read(f);
      assert.doesNotMatch(text, /mintlify/i, f);
      assert.doesNotMatch(text, /docs\/private|DECISIONS\.md|tasks\/|(?<!process)\.env\b|wbqhvmtiocoozjgwdsiq|tkkxcmrmtzpplydbksfe/, f);
      assert.doesNotMatch(text, /fz_(test|live)_[A-Za-z0-9_-]{43}|whsec_[A-Za-z0-9_-]{20,}/, f);
      if (!f.endsWith('.svg')) assert.doesNotMatch(text, /[^\x00-\x7f]/, f);
    }
  });
});

describe('the spec is the routes', () => {
  it('every /api/v1 route and method, and nothing else', () => {
    const fromCode = [];
    for (const f of routeFiles) {
      const p = '/' + f.slice('web/app/api/v1/'.length, -'/route.ts'.length).replace(/\[([a-z]+)\]/g, '{$1}');
      for (const m of all(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g, read(f))) fromCode.push(`${m} ${p}`);
    }
    const fromSpec = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
    assert.deepEqual(sorted(fromSpec), sorted(fromCode));
    assert.equal(spec.servers[0].url, 'https://flizy.app/api/v1');
  });

  it('each operation asks for the permission its route checks', () => {
    for (const f of routeFiles) {
      const p = '/' + f.slice('web/app/api/v1/'.length, -'/route.ts'.length).replace(/\[([a-z]+)\]/g, '{$1}');
      const src = read(f);
      for (const [, method, body] of src.matchAll(/export async function (GET|POST)\(([\s\S]*?)\n\}/g)) {
        const scope = /authenticateApiRequest\(req, db, '([a-z]+)'\)/.exec(body)[1];
        const op = spec.paths[p][method.toLowerCase()];
        assert.match(op.description, new RegExp(`\`${scope}\` permission`), `${method} ${p}`);
        const idem = /idempotency-key/.test(body);
        assert.equal(op.parameters?.some((x) => x.$ref === '#/components/parameters/IdempotencyKey') ?? false, idem, `${method} ${p}`);
      }
    }
  });

  it('each operation lists every status its route and the key check can answer, and no other', () => {
    // The key check answers 401, 403, 429 and 503 on every route.
    const fromAuth = all(/deny\((\d{3}),/g, read('web/lib/apiAuth.ts'));
    for (const f of routeFiles) {
      const p = '/' + f.slice('web/app/api/v1/'.length, -'/route.ts'.length).replace(/\[([a-z]+)\]/g, '{$1}');
      for (const [, method, body] of read(f).matchAll(/export async function (GET|POST)\(([\s\S]*?)\n\}/g)) {
        const fromRoute = [
          ...all(/apiError\((\d{3}),/g, body),
          ...all(/apiJson\([^;]*?, caller\.requestId, (\d{3})\)/g, body),
          // A parser error is a 400; an answer with no status is a 200.
          ...(/PayoutRequestError/.test(body) ? ['400'] : []),
          ...(/apiJson\([^;]*?caller\.requestId\)\)?;/.test(body) ? ['200'] : []),
        ];
        const documented = Object.keys(spec.paths[p][method.toLowerCase()].responses);
        assert.deepEqual(sorted(documented), sorted([...fromAuth, ...fromRoute]), `${method} ${p}`);
      }
    }
  });

  it('the success status of each operation is the route\'s', () => {
    assert.ok(spec.paths['/payouts'].post.responses['202']);
    assert.ok(spec.paths['/payments'].post.responses['201']);
    assert.ok(spec.paths['/payouts/{id}/cancel'].post.responses['202']);
    assert.match(read('web/app/api/v1/payouts/route.ts'), /apiJson\(body, caller\.requestId, 202\)/);
    assert.match(read('web/app/api/v1/payments/route.ts'), /apiJson\(body, caller\.requestId, 201\)/);
    assert.match(read('web/app/api/v1/payouts/[id]/cancel/route.ts'), /caller\.requestId, 202\)\);/);
  });
});

describe('the lists are the code\'s', () => {
  let states, keys, webhooks, payouts, payments;
  before(async () => {
    states = await import('../web/lib/apiStates.ts');
    keys = await import('../web/lib/apiKeys.ts');
    webhooks = await import('../web/lib/apiWebhooks.ts');
    payouts = await import('../web/lib/apiPayouts.ts');
    payments = await import('../web/lib/apiPayments.ts');
  });

  it('HTTP error codes: every code a route or parser can answer, documented in the spec and on the errors page', () => {
    const sources = [...routeFiles, 'web/lib/apiAuth.ts', 'web/lib/apiPayouts.ts', 'web/lib/apiPayments.ts'].map(read).join('\n');
    const fromCode = [
      ...all(/apiError\(\d{3}, '([a-z_]+)'/g, sources),
      ...all(/new PayoutRequestError\('([a-z_]+)'/g, sources),
      // deny(status, code, ...) in the auth module.
      ...all(/deny\(\d{3}, '([a-z_]+)'/g, sources),
    ];
    assert.deepEqual(sorted(schemas.Error.properties.error.properties.code.enum), sorted(fromCode));
    const errorsPage = page('errors');
    for (const code of fromCode) assert.match(errorsPage, new RegExp(`\\| \`${code}\` \\|`), code);
  });

  it('payout failure codes: every code the worker and the cancel route write', () => {
    const worker = read('lib/api/payoutWorker.js');
    const allowance = read('lib/api/allowanceSend.js');
    const decisions = /const DECISION_CODES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(allowance)[1];
    const fromCode = [
      ...all(/fail\(row, '([a-z_]+)'/g, worker),
      ...all(/error_code: '([a-z_]+)'/g, worker),
      ...all(/: '([a-z_]+)'/g, decisions),
      ...all(/error_code: '([a-z_]+)'/g, read('web/app/api/v1/payouts/[id]/cancel/route.ts')),
    ];
    const documented = schemas.Payout.properties.error_code.enum.filter((c) => c !== null);
    assert.deepEqual(sorted(documented), sorted(fromCode));
    const errorsPage = page('errors');
    for (const code of fromCode) assert.match(errorsPage, new RegExp(`\\| \`${code}\` \\|`), code);
  });

  it('states, permissions, recipient types and webhook events', () => {
    assert.deepEqual(sorted(schemas.State.enum), sorted(states.API_STATES));
    assert.deepEqual(sorted(schemas.Platform.properties.key.properties.permissions.items.enum), sorted(keys.API_SCOPES));
    const auth = page('authentication');
    for (const s of keys.API_SCOPES) assert.match(auth, new RegExp(`\\| \`${s}\` \\|`), s);
    const types = ['username', 'address', ...payouts.CLAIM_TYPES];
    assert.deepEqual(sorted(schemas.Recipient.properties.type.enum), sorted(types));
    const hooks = page('guides/webhooks');
    assert.deepEqual(sorted(all(/^\| `((?:payout|payment)\.[a-z_]+)` \|/gm, hooks)), sorted(webhooks.WEBHOOK_EVENTS));
    const guide = page('guides/payouts');
    for (const s of states.API_STATES) assert.match(guide, new RegExp(`\\| \`${s}\` \\|`), s);
  });

  it('request fields are exactly what the parsers take', () => {
    const fields = (fn) => JSON.parse('[' + /\.filter\(\(k\) => !\[([^\]]+)\]\.includes\(k\)\)/.exec(fn)[1].replace(/'/g, '"') + ']');
    assert.deepEqual(sorted(Object.keys(schemas.PayoutRequest.properties)), sorted(fields(read('web/lib/apiPayouts.ts'))));
    assert.deepEqual(sorted(Object.keys(schemas.PaymentRequest.properties)), sorted(fields(read('web/lib/apiPayments.ts'))));
    assert.equal(schemas.PayoutRequest.additionalProperties, false);
    assert.equal(schemas.PaymentRequest.additionalProperties, false);
  });

  it('response fields are exactly what the views answer', () => {
    const at = '2026-11-09T12:00:00.000Z';
    const payout = payouts.payoutView({
      id: 'x', state: 'accepted', amount: '1', asset: 'TUSD', recipient_kind: 'email', recipient_ref: 'a@b.co', reference: null, metadata: null,
      tx_hash: null, error_code: null, claim_url: null, claim_expires_at: null, refund_tx_hash: null, cancel_requested_at: null, created_at: at, updated_at: at,
    });
    assert.deepEqual(sorted(Object.keys(schemas.Payout.properties)), sorted(Object.keys(payout)));
    assert.deepEqual(sorted(Object.keys(schemas.Payout.properties.claim.properties)), sorted(Object.keys(payout.claim)));
    assert.deepEqual(sorted(Object.keys(schemas.Payout.example)), sorted(Object.keys(payout)));
    const payment = payments.paymentView(
      { id: 'x', state: 'accepted', amount: '1', asset: 'TUSD', reference: null, metadata: null, received_units: '0', overpaid: false, expires_at: at, return_url: null, tx_hash: null, settled_at: null, created_at: at, updated_at: at },
      'https://flizy.app'
    );
    assert.deepEqual(sorted(Object.keys(schemas.Payment.properties)), sorted(Object.keys(payment)));
    assert.deepEqual(sorted(Object.keys(schemas.Payment.example)), sorted(Object.keys(payment)));
    assert.equal(payment.checkout_url, schemas.Payment.example.checkout_url.replace(schemas.Payment.example.id, 'x'));
    const me = read('web/app/api/v1/me/route.ts');
    for (const k of Object.keys(schemas.Platform.properties)) assert.match(me, new RegExp(`\\b${k}:`), k);
  });

  it('the numbers the pages quote are the code\'s', async () => {
    const auth = await import('../web/lib/apiAuth.ts');
    const sign = await import('../web/lib/apiWebhookSign.ts');
    assert.equal(auth.RATE_PER_MINUTE, 120);
    assert.match(page('rate-limits'), /\*\*120 calls a minute\*\*/);
    assert.match(spec.components.responses.RateLimited.description, /120 calls a minute/);
    assert.equal(sign.REPLAY_WINDOW_SEC, 300);
    assert.match(page('guides/webhooks'), /const TOLERANCE_SECONDS = 300;/);
    assert.match(page('guides/webhooks'), /TOLERANCE_SECONDS = 300\n/);
    assert.equal(webhooks.MAX_ENDPOINTS, 5);
    assert.match(page('guides/webhooks'), /up to 5, each an https URL/);
    assert.equal(payments.MAX_ORIGINS, 5);
    assert.match(page('guides/checkouts'), /Developers page \(up to 5\)/);
    const pay = read('web/lib/apiPayments.ts');
    assert.match(pay, /const EXPIRY_MIN_MINUTES = 5;\s*const EXPIRY_MAX_MINUTES = 7 \* 24 \* 60;\s*const EXPIRY_DEFAULT_MINUTES = 60;/);
    const exp = schemas.PaymentRequest.properties.expires_in_minutes;
    assert.deepEqual([exp.minimum, exp.maximum, exp.default], [5, 7 * 24 * 60, 60]);
    assert.match(read('web/lib/apiIdempotency.ts'), /IDEMPOTENCY_KEY_RE = \/\^\[\\x21-\\x7e\]\{1,255\}\$\//);
    assert.match(read('web/app/api/v1/payouts/route.ts'), /const BODY_MAX_BYTES = 16 \* 1024;/);
    const worker = read('lib/api/webhookWorker.js');
    assert.match(worker, /const FIRST_RETRY_MS = 30 \* 1000;\s*const MAX_RETRY_MS = 6 \* 3600 \* 1000;\s*const GIVE_UP_MS = 24 \* 3600 \* 1000;/);
    assert.match(page('guides/webhooks'), /30 seconds, then doubling each time, at most 6 hours apart, until 24 hours after the event/);
    assert.match(read('lib/api/webhookSend.js'), /const TIMEOUT_MS = 10 \* 1000;/);
    assert.match(read('lib/api/webhookSend.js'), /'user-agent': 'Flizy-Webhooks\/1'/);
    assert.match(worker, /'Flizy-Event-Id': ev\.id, 'Flizy-Event-Type': ev\.type/);
    assert.match(worker, /JSON\.stringify\(\{ id: ev\.id, type: ev\.type, created_at: ev\.created_at, data: ev\.payload \}\)/);
  });
});

describe('the signature check in the webhooks guide', () => {
  let verify, sign, dir;
  before(async () => {
    const guide = page('guides/webhooks');
    const js = /```javascript JavaScript\n([\s\S]*?)```/.exec(guide.slice(guide.indexOf('## Check the signature')))[1];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flizy-docs-'));
    const file = path.join(dir, 'verify.mjs');
    fs.writeFileSync(file, js);
    verify = (await import(pathToFileURL(file).href)).verifyFlizySignature;
    sign = (await import('../web/lib/apiWebhookSign.ts')).signWebhook;
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('accepts what Flizy signs', () => {
    const body = JSON.stringify({ id: 'e1', type: 'payout.confirmed', data: { state: 'confirmed' } });
    const t = Math.floor(Date.now() / 1000);
    assert.equal(verify('whsec_test', body, sign('whsec_test', body, t)), true);
  });

  it('refuses a changed body, another secret, a stale or future time, and junk', () => {
    const body = '{"id":"e1"}';
    const t = Math.floor(Date.now() / 1000);
    const header = sign('whsec_test', body, t);
    assert.equal(verify('whsec_test', '{"id":"e2"}', header), false);
    assert.equal(verify('whsec_other', body, header), false);
    assert.equal(verify('whsec_test', body, sign('whsec_test', body, t - 301)), false);
    assert.equal(verify('whsec_test', body, sign('whsec_test', body, t + 301)), false);
    for (const junk of ['', 't=1', 'v1=abc', `t=${t},v1=zz`, null]) assert.equal(verify('whsec_test', body, junk), false);
  });

  it('the Python check signs the same message, compares in constant time and keeps the same window', () => {
    const guide = page('guides/webhooks');
    const py = /```python Python\n([\s\S]*?)```/.exec(guide.slice(guide.indexOf('## Check the signature')))[1];
    assert.match(py, /hmac\.new\(secret\.encode\(\), str\(t\)\.encode\(\) \+ b"\." \+ raw_body, hashlib\.sha256\)\.hexdigest\(\)/);
    assert.match(py, /return hmac\.compare_digest\(expected, v1\)/);
    assert.match(py, /TOLERANCE_SECONDS = 300/);
    assert.match(py, /if abs\(\(int\(time\.time\(\)\) if now is None else now\) - t\) > TOLERANCE_SECONDS:/);
  });
});
