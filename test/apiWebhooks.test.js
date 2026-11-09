/**
 * Flizy Pay API, phase 2c: webhook endpoints and delivery, and large-payout
 * emails.
 *
 * What is pinned:
 * - an endpoint secret is shown once and stored only encrypted, bound to its
 *   endpoint: the site's encryption and the VPS's decryption agree, and a
 *   ciphertext moved to another endpoint, or changed, does not decrypt;
 * - the VPS signs exactly as the site documents and verifies;
 * - a webhook is never sent to Flizy's own network: https, port 443, no
 *   credentials, every DNS answer public, the connection pinned to the address
 *   checked, no redirect followed, a timeout and a read cap;
 * - the worker fans events out only to enabled endpoints that want them, once,
 *   signs each delivery, records every attempt, backs off, gives up after 24
 *   hours, never sends one delivery twice, and never touches a payout;
 * - the Developers endpoints keep their rules; a large payout is mailed.
 *
 * Run: node --test test/apiWebhooks.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const LS = require('../lib/api/webhookSecret');
const LSign = require('../lib/api/webhookSign');
const Send = require('../lib/api/webhookSend');
const Wk = require('../lib/api/webhookWorker');

const KEY_HEX = crypto.randomBytes(32).toString('hex');
const KEY = Buffer.from(KEY_HEX, 'hex');

let WS;
let WSign;
let WH;
let P;
before(async () => {
  WS = await import('../web/lib/apiWebhookSecret.ts');
  WSign = await import('../web/lib/apiWebhookSign.ts');
  WH = await import('../web/lib/apiWebhooks.ts');
  P = await import('../web/lib/apiPayouts.ts');
});

describe('endpoint secrets', () => {
  it('are whsec_ and 256 random bits, with a short hint', () => {
    const a = WS.generateWebhookSecret();
    assert.match(a.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
    assert.equal(a.hint, a.secret.slice(-4));
    assert.notEqual(WS.generateWebhookSecret().secret, a.secret);
  });

  it('encrypted on the site, decrypted on the VPS, and the other way round', () => {
    const id = crypto.randomUUID();
    const { secret } = WS.generateWebhookSecret();
    const stored = WS.encryptWebhookSecret(secret, id, KEY);
    assert.match(stored, /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    assert.ok(!stored.includes(secret.slice(6, 20)), 'not stored in the clear');
    assert.equal(LS.decryptWebhookSecret(stored, id, KEY), secret);
    assert.equal(WS.decryptWebhookSecret(LS.encryptWebhookSecret(secret, id, KEY), id, KEY), secret);
  });

  it('moved onto another endpoint, changed, or under another key: does not decrypt', () => {
    const id = crypto.randomUUID();
    const stored = WS.encryptWebhookSecret('whsec_x', id, KEY);
    assert.throws(() => LS.decryptWebhookSecret(stored, crypto.randomUUID(), KEY));
    const parts = stored.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => LS.decryptWebhookSecret(parts.join(':'), id, KEY));
    assert.throws(() => LS.decryptWebhookSecret(stored, id, crypto.randomBytes(32)));
  });

  it('the key must be 64 hex characters; unset on the VPS means wait, on the site means refuse', () => {
    assert.equal(LS.webhookKey({}), null);
    assert.throws(() => LS.webhookKey({ API_WEBHOOK_KEY: 'short' }), /64 hex/);
    assert.throws(() => WS.webhookKey({}), WS.WebhookKeyMissing);
    assert.deepEqual(LS.webhookKey({ API_WEBHOOK_KEY: KEY_HEX }), KEY);
  });
});

describe('signing', () => {
  it('the VPS signs exactly as the site verifies', () => {
    const body = '{"id":"evt","type":"payout.confirmed"}';
    const header = LSign.signWebhook('whsec_one', body, 1_800_000_000);
    assert.equal(header, WSign.signWebhook('whsec_one', body, 1_800_000_000));
    assert.equal(WSign.verifyWebhookSignature('whsec_one', body, header, 1_800_000_010), true);
    assert.equal(LSign.SIGNATURE_HEADER, WSign.SIGNATURE_HEADER);
  });
});

describe('never Flizy\'s own network', () => {
  it('refuses private, loopback, link-local, CGNAT, multicast, reserved and mapped addresses', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '172.16.5.5', '192.168.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.1.1.1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
      assert.equal(Send.isPublicAddress(ip), false, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(Send.isPublicAddress(ip), true, ip);
    assert.equal(Send.isPublicAddress('not-an-ip'), false);
  });

  it('takes https on 443 only, without credentials, and never a private literal', () => {
    assert.equal(Send.checkWebhookUrl('https://hooks.example.com/f?x=1').ok, true);
    for (const u of ['http://hooks.example.com', 'https://a:b@hooks.example.com', 'https://hooks.example.com:8443', 'https://127.0.0.1/', 'https://[::1]/', 'ftp://x', '', 'https://' + 'a'.repeat(2001) + '.com']) {
      assert.equal(Send.checkWebhookUrl(u).ok, false, u);
    }
  });

  it('a host with even one private answer is refused', async () => {
    const lookup = (answers) => async () => answers;
    assert.equal((await Send.resolvePublic('h.example', lookup([{ address: '8.8.8.8', family: 4 }]))).ok, true);
    assert.equal((await Send.resolvePublic('h.example', lookup([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]))).ok, false);
    assert.equal((await Send.resolvePublic('h.example', lookup([]))).ok, false);
    assert.equal((await Send.resolvePublic('h.example', async () => { throw new Error('ENOTFOUND'); })).ok, false);
  });

  /** A stand-in for https.request: records its options and answers as told. */
  function fakeRequest({ status = 200, chunks = [], hang = false } = {}) {
    const calls = [];
    const request = (opts, onRes) => {
      calls.push(opts);
      const req = new EventEmitter();
      req.destroy = (err) => req.emit('error', err || new Error('destroyed'));
      req.end = (body) => {
        req.body = body;
        if (hang) return;
        const res = new EventEmitter();
        res.statusCode = status;
        res.destroy = () => res.emit('close');
        setImmediate(() => {
          onRes(res);
          for (const c of chunks) res.emit('data', c);
          res.emit('end');
        });
      };
      return req;
    };
    return { request, calls };
  }
  const resolve = async () => ({ ok: true, address: '93.184.216.34', family: 4 });

  it('connects only to the address checked, keeps the host name for TLS, and sends the body as JSON', async () => {
    const f = fakeRequest();
    const out = await Send.sendWebhook({ url: 'https://hooks.example.com/flizy?a=1', body: '{"x":1}', headers: { 'Flizy-Signature': 't=1,v1=ab' }, request: f.request, resolve });
    assert.deepEqual(out, { ok: true, status: 200 });
    const o = f.calls[0];
    assert.deepEqual([o.hostname, o.port, o.path, o.method], ['hooks.example.com', 443, '/flizy?a=1', 'POST']);
    assert.equal(o.headers['Flizy-Signature'], 't=1,v1=ab');
    assert.equal(o.headers['content-type'], 'application/json');
    const got = [];
    o.lookup('hooks.example.com', {}, (err, address, family) => got.push([address, family]));
    o.lookup('hooks.example.com', { all: true }, (err, list) => got.push(list));
    assert.deepEqual(got, [['93.184.216.34', 4], [{ address: '93.184.216.34', family: 4 }]]);
  });

  it('a private answer, a redirect, an error status or a hang is not delivered; a long answer is cut', async () => {
    const priv = await Send.sendWebhook({ url: 'https://hooks.example.com/', body: '{}', request: fakeRequest().request, resolve: async () => ({ ok: false, error: 'host resolves to a private address' }) });
    assert.deepEqual([priv.ok, priv.error], [false, 'host resolves to a private address']);
    assert.equal((await Send.sendWebhook({ url: 'https://hooks.example.com/', body: '{}', request: fakeRequest({ status: 302 }).request, resolve })).ok, false);
    assert.equal((await Send.sendWebhook({ url: 'https://hooks.example.com/', body: '{}', request: fakeRequest({ status: 500 }).request, resolve })).error, 'http 500');
    const hung = await Send.sendWebhook({ url: 'https://hooks.example.com/', body: '{}', request: fakeRequest({ hang: true }).request, resolve, timeoutMs: 30 });
    assert.deepEqual([hung.ok, hung.error], [false, 'timeout']);
    const big = await Send.sendWebhook({ url: 'https://hooks.example.com/', body: '{}', request: fakeRequest({ chunks: [Buffer.alloc(70 * 1024)] }).request, resolve });
    assert.equal(big.ok, true, 'cut at 64 KB, still answered 200');
  });
});

describe('the delivery worker', () => {
  const PLATFORM = 'plat-1';
  let fake;
  let sends;
  let sendImpl;
  let clock;
  const ep = (id, over = {}) => {
    const eid = id;
    return { id: eid, platform_id: PLATFORM, url: `https://${id}.example.com/h`, events: [], enabled: true, secret_ciphertext: WS.encryptWebhookSecret(`whsec_${id}`, eid, KEY), ...over };
  };
  const worker = () => Wk.makeWebhookWorker({ supabase: fake.client, env: { API_WEBHOOK_KEY: KEY_HEX }, send: (a) => (sends.push(a), sendImpl(a)), now: () => clock, log: { warn() {}, info() {} } });
  beforeEach(() => {
    clock = Date.parse('2026-11-09T12:00:00Z');
    const e1 = crypto.randomUUID();
    const e2 = crypto.randomUUID();
    const e3 = crypto.randomUUID();
    fake = createFakeSupabase({
      api_webhook_endpoints: [ep(e1), ep(e2, { events: ['payout.failed'] }), ep(e3, { enabled: false }), { ...ep(crypto.randomUUID()), platform_id: 'other' }],
      api_webhook_events: [{ id: 'evt-1', platform_id: PLATFORM, type: 'payout.confirmed', status: 'pending', payload: { id: 'po-1', state: 'confirmed' }, created_at: new Date(clock).toISOString() }],
      api_webhook_deliveries: [],
      api_webhook_attempts: [],
      api_transactions: [{ id: 'po-1', state: 'confirmed' }],
    });
    fake.ids = { e1, e2, e3 };
    sends = [];
    sendImpl = async () => ({ ok: true, status: 200 });
  });
  const deliveries = () => fake.db.tables.api_webhook_deliveries;
  const stamp = () => {
    // The fake applies no column defaults; fill the ones the migration declares.
    for (const d of deliveries()) {
      d.id ??= crypto.randomUUID();
      d.status ??= 'pending';
      d.attempts ??= 0;
      d.next_attempt_at ??= new Date(clock).toISOString();
    }
  };

  it('fans an event out to this platform\'s enabled endpoints that want it, once', async () => {
    const w = worker();
    await w.dispatch();
    await w.dispatch();
    assert.deepEqual(deliveries().map((d) => d.endpoint_id), [fake.ids.e1], 'not the disabled one, not one that wants other events, not another platform\'s');
    assert.equal(fake.db.tables.api_webhook_events[0].status, 'dispatched');
  });

  it('delivers it signed with that endpoint\'s secret, records the attempt, and never touches the payout', async () => {
    const w = worker();
    await w.dispatch();
    stamp();
    assert.equal(await w.deliverDue(), 1);
    const s = sends[0];
    assert.equal(s.url, `https://${fake.ids.e1}.example.com/h`);
    assert.equal(WSign.verifyWebhookSignature(`whsec_${fake.ids.e1}`, s.body, s.headers['Flizy-Signature'], Math.floor(Date.now() / 1000)), true);
    assert.deepEqual(JSON.parse(s.body), { id: 'evt-1', type: 'payout.confirmed', created_at: new Date(clock).toISOString(), data: { id: 'po-1', state: 'confirmed' } });
    assert.equal(s.headers['Flizy-Event-Id'], 'evt-1');
    assert.equal(deliveries()[0].status, 'delivered');
    assert.equal(fake.db.tables.api_webhook_attempts[0].http_status, 200);
    assert.deepEqual(fake.db.tables.api_transactions, [{ id: 'po-1', state: 'confirmed' }]);
    assert.doesNotMatch(read('lib/api/webhookWorker.js'), /api_transactions|api_transition/);
  });

  it('a failure backs off, doubling; past 24 hours after the event it gives up', async () => {
    sendImpl = async () => ({ ok: false, status: 503, error: 'http 503' });
    const w = worker();
    await w.dispatch();
    stamp();
    await w.deliverDue();
    assert.deepEqual([deliveries()[0].status, deliveries()[0].attempts, deliveries()[0].last_error], ['pending', 1, 'http 503']);
    assert.equal(Date.parse(deliveries()[0].next_attempt_at) - clock, 30 * 1000);
    assert.deepEqual([1, 2, 3, 20].map(Wk.backoffMs), [30e3, 60e3, 120e3, 6 * 3600e3]);
    clock += 25 * 3600 * 1000;
    deliveries()[0].next_attempt_at = new Date(clock - 1000).toISOString();
    await w.deliverDue();
    assert.equal(deliveries()[0].status, 'failed');
    assert.equal(fake.db.tables.api_webhook_attempts.length, 2, 'every attempt recorded');
  });

  it('an endpoint removed or disabled since: failed, nothing sent', async () => {
    const w = worker();
    await w.dispatch();
    stamp();
    fake.db.tables.api_webhook_endpoints[0].enabled = false;
    await w.deliverDue();
    assert.equal(sends.length, 0);
    assert.equal(deliveries()[0].status, 'failed');
  });

  it('two passes at once never send the same delivery twice', async () => {
    const w = worker();
    await w.dispatch();
    stamp();
    await Promise.all([w.deliverDue(), w.deliverDue()]);
    assert.equal(sends.length, 1);
  });

  it('a slow endpoint does not hold up another one: a batch goes out together', async () => {
    fake.db.tables.api_webhook_endpoints[1].events = [];
    const w = worker();
    await w.dispatch();
    stamp();
    const marks = [];
    sendImpl = async (a) => {
      marks.push(`start ${a.url.slice(8, 14)}`);
      if (a.url.includes(fake.ids.e1)) await new Promise((r) => setTimeout(r, 60));
      marks.push(`end ${a.url.slice(8, 14)}`);
      return { ok: true, status: 200 };
    };
    assert.equal(await w.deliverDue(), 2);
    assert.equal(marks.indexOf(`start ${fake.ids.e2.slice(0, 6)}`) < marks.indexOf(`end ${fake.ids.e1.slice(0, 6)}`), true, 'the second started before the slow one ended');
  });

  it('without API_WEBHOOK_KEY, deliveries wait', async () => {
    const w = Wk.makeWebhookWorker({ supabase: fake.client, env: {}, send: (a) => (sends.push(a), sendImpl(a)), log: { warn() {}, info() {} } });
    await w.dispatch();
    stamp();
    assert.equal(await w.deliverDue(), 0);
    assert.equal(deliveries()[0].status, 'pending');
  });
});

describe('endpoints on the Developers page', () => {
  const platform = { id: 'plat-1', account_id: 'acc-1', display_name: 'Acme', wallet_address: '0x' + 'ab'.repeat(20), enabled: true, fee_bps: 0, claim_expiry_default_days: 30, claim_expiry_max_days: 30 };
  let fake;
  beforeEach(() => {
    fake = createFakeSupabase({ api_webhook_endpoints: [], api_webhook_deliveries: [], api_webhook_events: [] });
  });

  it('take a public https host name on 443, never an IP or a local name', () => {
    assert.equal(WH.cleanWebhookUrl('https://hooks.example.com/f#x'), 'https://hooks.example.com/f');
    for (const u of ['http://hooks.example.com', 'https://1.2.3.4/', 'https://[2606:4700::1111]/', 'https://localhost/', 'https://printer.local/', 'https://intranet/', 'https://u:p@hooks.example.com', 'https://hooks.example.com:444', 'nope']) {
      assert.throws(() => WH.cleanWebhookUrl(u), WH.WebhookRequestError, u);
    }
  });

  it('take known events only, all when none are chosen', () => {
    assert.deepEqual(WH.cleanWebhookEvents([]), []);
    assert.deepEqual(WH.cleanWebhookEvents(['payout.refunded', 'payout.confirmed']), ['payout.confirmed', 'payout.refunded']);
    assert.throws(() => WH.cleanWebhookEvents(['payout.everything']), /Unknown event/);
    for (const e of WH.WEBHOOK_EVENTS) assert.match(e, /^payout\.(queued|submitted|confirmed|claim_pending|failed|expired|refund_pending|refunded)$/);
  });

  it('store the secret only encrypted to the new endpoint, and return it once', async () => {
    const made = await WH.createEndpoint(fake.client, platform, { url: 'https://hooks.example.com/f', label: 'Main\nhook', events: [] }, { API_WEBHOOK_KEY: KEY_HEX });
    const row = fake.db.tables.api_webhook_endpoints[0];
    assert.match(made.secret, /^whsec_/);
    assert.ok(!JSON.stringify(row).includes(made.secret));
    assert.equal(LS.decryptWebhookSecret(row.secret_ciphertext, row.id, KEY), made.secret);
    assert.equal(row.label, 'Main hook');
    assert.equal(made.endpoint.secretHint, made.secret.slice(-4));
    assert.equal('secret_ciphertext' in made.endpoint, false, 'the page never sees the ciphertext');
  });

  it('two adds at once cannot pass the cap together', async () => {
    for (let i = 0; i < WH.MAX_ENDPOINTS - 1; i += 1) await WH.createEndpoint(fake.client, platform, { url: `https://h${i}.example.com/`, label: '', events: [] }, { API_WEBHOOK_KEY: KEY_HEX });
    await Promise.allSettled([1, 2].map((n) => WH.createEndpoint(fake.client, platform, { url: `https://race${n}.example.com/`, label: '', events: [] }, { API_WEBHOOK_KEY: KEY_HEX })));
    assert.ok(fake.db.tables.api_webhook_endpoints.length <= WH.MAX_ENDPOINTS, String(fake.db.tables.api_webhook_endpoints.length));
  });

  it('refuse a sixth endpoint, and refuse all when the key is not set', async () => {
    for (let i = 0; i < WH.MAX_ENDPOINTS; i += 1) await WH.createEndpoint(fake.client, platform, { url: `https://h${i}.example.com/`, label: '', events: [] }, { API_WEBHOOK_KEY: KEY_HEX });
    await assert.rejects(WH.createEndpoint(fake.client, platform, { url: 'https://h9.example.com/', label: '', events: [] }, { API_WEBHOOK_KEY: KEY_HEX }), /webhook endpoints/);
    fake.db.tables.api_webhook_endpoints = [];
    await assert.rejects(WH.createEndpoint(fake.client, platform, { url: 'https://h.example.com/', label: '', events: [] }, {}), /not available yet/);
  });

  it('delete and retry only this platform\'s, and retry only what was not delivered', async () => {
    fake.db.tables.api_webhook_endpoints = [{ id: 'e1', platform_id: 'other' }];
    assert.equal(await WH.deleteEndpoint(fake.client, platform, 'e1'), false);
    fake.db.tables.api_webhook_deliveries = [
      { id: 'd1', platform_id: 'plat-1', status: 'failed' },
      { id: 'd2', platform_id: 'plat-1', status: 'delivered' },
      { id: 'd3', platform_id: 'other', status: 'failed' },
    ];
    assert.equal(await WH.retryDelivery(fake.client, 'plat-1', 'd1'), true);
    assert.equal(fake.db.tables.api_webhook_deliveries[0].status, 'pending');
    assert.equal(await WH.retryDelivery(fake.client, 'plat-1', 'd2'), false);
    assert.equal(await WH.retryDelivery(fake.client, 'plat-1', 'd3'), false);
  });

  it('the routes: add and remove take the password; retry takes the session and the same-origin check', () => {
    for (const rel of ['web/app/api/developers/webhooks/route.ts', 'web/app/api/developers/webhooks/[id]/delete/route.ts']) {
      const src = read(rel);
      assert.match(src, /rejectIfCrossOrigin\(req\)/, rel);
      assert.match(src, /requirePassword\(/, rel);
      assert.match(src, /platformForAccount\(db, accountId\)/, rel);
    }
    const retry = read('web/app/api/developers/webhooks/deliveries/[id]/retry/route.ts');
    assert.match(retry, /rejectIfCrossOrigin\(req\)/);
    assert.match(retry, /retryDelivery\(db, platform\.id, id\)/);
  });
});

describe('large-payout email', () => {
  it('names the payout and how to stop a key, never a key or secret', () => {
    const view = { id: 'po-1', amount: '500', asset: 'tUSD', recipient: { type: 'email', value: 'ada@example.com' }, reference: 'order 7', created_at: '2026-11-09T12:00:00Z' };
    const mail = P.largePayoutMail(view, 'Acme', 'https://flizy.app/');
    assert.equal(mail.subject, 'Flizy API payout of 500 tUSD accepted');
    assert.match(mail.text, /^A payout of 500 tUSD from Acme was accepted/);
    assert.match(mail.text, /To: email ada@example.com\nReference: order 7\nPayout: po-1/);
    assert.match(mail.text, /https:\/\/flizy\.app\/dashboard\/account\?s=developers/);
    assert.doesNotMatch(mail.text, /fz_(test|live)_|whsec_/);
  });

  it('is sent after the payout is recorded, only for a new one, and never changes the answer', () => {
    const src = read('web/app/api/v1/payouts/route.ts');
    const finish = src.indexOf('await finishIdempotent(db, caller.keyId, idemKey, 202, body);');
    const notice = src.indexOf('if (limits.notice_at && parsed.amount >= BigInt(limits.notice_at))');
    assert.ok(finish > 0 && notice > finish);
    assert.ok(src.indexOf("if (idem.kind === 'replay')") < finish, 'a replay returns before it');
    assert.match(src.slice(notice, notice + 600), /try \{[\s\S]*\} catch \{/);
  });
});

describe('the migration', () => {
  const SQL = read('supabase/migrations/20261109120000_api_webhooks.sql');
  it('one delivery per event and endpoint, service role only, and secrets only in the v1 form', () => {
    assert.match(SQL, /constraint api_webhook_deliveries_once unique \(event_id, endpoint_id\)/);
    assert.match(SQL, /alter table public\.api_webhook_deliveries enable row level security;/);
    assert.match(SQL, /secret_ciphertext ~ '\^v1:/);
    assert.match(SQL, /add constraint api_webhook_events_dispatch_status_check check \(status in \('pending', 'dispatched', 'delivered', 'failed'\)\)/);
    assert.ok(SQL.indexOf('add column if not exists notice_at') < SQL.indexOf('api_platform_limits_notice_check'), 'the column before its check');
  });
});
