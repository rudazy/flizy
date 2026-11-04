/**
 * Flizy Pay API, phase 1: platforms, keys, authentication, rate limits,
 * idempotency, the state machine, webhook signing and the key notices.
 *
 * What is pinned: a key is shown once and stored only as its digest; the site
 * can never grant payout; every way of failing to prove identity looks the
 * same to the caller; permissions, IP allowlists and the rate limit hold; an
 * Idempotency-Key replays the first answer and refuses a different request;
 * the state machine in the app equals the one in the database, and `accepted`
 * is never completed; webhook signatures fail on any tamper or replay; both
 * halves of the payout switch must be on; key changes, including ones made by
 * hand in the database, are emailed; and no money moves anywhere in phase 1.
 *
 * Run: node --test test/apiFoundation.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SQL = read('supabase/migrations/20261104120000_api_foundation.sql');

let K;
let S;
let W;
let A;
let I;
let P;
before(async () => {
  K = await import('../web/lib/apiKeys.ts');
  S = await import('../web/lib/apiStates.ts');
  W = await import('../web/lib/apiWebhookSign.ts');
  A = await import('../web/lib/apiAuth.ts');
  I = await import('../web/lib/apiIdempotency.ts');
  P = await import('../web/lib/apiPlatforms.ts');
});

describe('keys', () => {
  it('are a mode prefix and 256 random bits, shown once and stored as a digest', () => {
    const k = K.generateApiKey('test');
    assert.match(k.secret, /^fz_test_[A-Za-z0-9_-]{43}$/);
    assert.equal(k.hash, K.hashApiKey(k.secret));
    assert.match(k.hash, /^[0-9a-f]{64}$/);
    assert.equal(k.prefix, k.secret.slice(0, 14));
    assert.notEqual(K.generateApiKey('test').secret, k.secret);
    assert.match(K.generateApiKey('live').secret, /^fz_live_/);
  });

  it('read the mode from a well-formed key only, and a bearer header strictly', () => {
    const k = K.generateApiKey('test').secret;
    assert.equal(K.apiKeyMode(k), 'test');
    assert.equal(K.apiKeyMode('fz_test_short'), null);
    assert.equal(K.apiKeyMode(`sk_test_${'a'.repeat(43)}`), null);
    assert.equal(K.bearerApiKey(`Bearer ${k}`), k);
    assert.equal(K.bearerApiKey(k), null);
    assert.equal(K.bearerApiKey(`Bearer ${k} extra`), null);
  });

  it('can never be given payout from the site, and refuses unknown permissions instead of dropping them', () => {
    assert.deepEqual(K.cleanScopes(['collect', 'read', 'read']), ['read', 'collect']);
    assert.equal(K.cleanScopes(['read', 'payout']), null);
    assert.equal(K.cleanScopes(['admin']), null);
    assert.equal(K.cleanScopes([]), null);
    assert.deepEqual(K.SITE_GRANTABLE_SCOPES, ['read', 'collect']);
  });

  it('take an IP allowlist of real addresses, at most 20', () => {
    assert.deepEqual(K.cleanIpAllowlist('1.2.3.4, 2001:db8::1'), ['1.2.3.4', '2001:db8::1']);
    assert.deepEqual(K.cleanIpAllowlist(''), []);
    assert.equal(K.cleanIpAllowlist('1.2.3.999'), null);
    assert.equal(K.cleanIpAllowlist('example.com'), null);
    assert.equal(K.cleanIpAllowlist(Array.from({ length: 21 }, (_, i) => `10.0.0.${i}`)), null);
  });
});

describe('the state machine', () => {
  it('in the app equals the one the database enforces', () => {
    const sqlCase = SQL.slice(SQL.indexOf('allowed := case current_state'), SQL.indexOf('end;', SQL.indexOf('allowed := case current_state')));
    const fromSql = {};
    for (const m of sqlCase.matchAll(/when '([a-z_]+)' then array\[([^\]]*)\]/g)) {
      fromSql[m[1]] = [...m[2].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    }
    for (const state of S.API_STATES) {
      assert.deepEqual(fromSql[state] || [], [...S.API_TRANSITIONS[state]], state);
    }
    for (const state of S.API_STATES) assert.match(SQL, new RegExp(`'${state}'`));
  });

  it('never counts accepted as completed, and only confirmed and refunded as completed', () => {
    assert.equal(S.isCompleted('accepted'), false);
    assert.deepEqual(S.API_STATES.filter((s) => S.isCompleted(s)), ['confirmed', 'refunded']);
    assert.equal(S.canTransition('accepted', 'confirmed'), false);
    assert.equal(S.canTransition('claim_pending', 'refund_pending'), true);
    assert.equal(S.canTransition('refunded', 'refund_pending'), false);
    assert.deepEqual(S.API_STATES.filter((s) => S.isFinal(s)), ['confirmed', 'failed', 'refunded']);
  });

  it('changes a state and writes its webhook event in one database transaction', () => {
    const fn = SQL.slice(SQL.indexOf('create or replace function public.api_transition'), SQL.indexOf('-- Service role only, everywhere.'));
    assert.match(fn, /for update;/);
    assert.match(fn, /raise exception 'api transition % -> % is not allowed'/);
    assert.ok(fn.indexOf('update public.api_transactions') < fn.indexOf('insert into public.api_webhook_events'));
  });
});

describe('webhook signatures', () => {
  const body = '{"id":"evt_1","type":"payout.confirmed"}';
  it('verify, and fail on a changed body, another secret, or outside the replay window', () => {
    const header = W.signWebhook('whsec_one', body, 1_800_000_000);
    assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
    assert.equal(W.verifyWebhookSignature('whsec_one', body, header, 1_800_000_100), true);
    assert.equal(W.verifyWebhookSignature('whsec_one', body + ' ', header, 1_800_000_100), false);
    assert.equal(W.verifyWebhookSignature('whsec_two', body, header, 1_800_000_100), false);
    assert.equal(W.verifyWebhookSignature('whsec_one', body, header, 1_800_000_000 + W.REPLAY_WINDOW_SEC + 1), false);
    assert.equal(W.verifyWebhookSignature('whsec_one', body, 't=x,v1=zz', 1_800_000_000), false);
    assert.equal(W.verifyWebhookSignature('whsec_one', body, null), false);
  });

  it('tell receivers to dedupe by the event id', () => {
    assert.match(read('web/lib/apiWebhookSign.ts'), /receivers dedupe by it/);
    assert.match(SQL, /create table if not exists public\.api_webhook_events \(\s*id uuid primary key default gen_random_uuid\(\)/);
  });
});

describe('authentication', () => {
  const ENV = { FLIZY_API_MODE: 'test' };
  let fake;
  let secret;
  const platformId = 'plat-1';
  const keyId = 'key-1';
  function seed({ key = {}, platform = {} } = {}) {
    const made = K.generateApiKey('test');
    secret = made.secret;
    fake = createFakeSupabase({
      api_platforms: [{ id: platformId, display_name: 'Acme', wallet_address: '0x' + 'ab'.repeat(20), enabled: true, ...platform }],
      api_keys: [{ id: keyId, platform_id: platformId, mode: 'test', prefix: made.prefix, key_hash: made.hash, scopes: ['read'], ip_allowlist: null, revoked_at: null, ...key }],
      api_requests: [],
      api_control: [{ id: true, payouts_enabled: false }],
    });
  }
  const req = (auth, ip = '9.9.9.9') => new Request('https://flizy.app/api/v1/me', { headers: { authorization: auth, 'x-real-ip': ip } });
  beforeEach(() => seed());

  it('lets a valid key in with its platform and permissions', async () => {
    const r = await A.authenticateApiRequest(req(`Bearer ${secret}`), fake.client, 'read', { env: ENV });
    assert.equal(r.ok, true);
    assert.equal(r.caller.platformName, 'Acme');
    assert.deepEqual(r.caller.scopes, ['read']);
    assert.match(r.caller.requestId, /^req_/);
  });

  it('answers every failure to prove identity the same way, so nothing can be probed', async () => {
    const bodies = [];
    const check = async (r) => {
      assert.equal(r.ok, false);
      assert.equal(r.response.status, 401);
      const b = await r.response.json();
      bodies.push(`${b.error.code}|${b.error.message}`);
    };
    await check(await A.authenticateApiRequest(new Request('https://flizy.app/api/v1/me'), fake.client, 'read', { env: ENV }));
    await check(await A.authenticateApiRequest(req('Bearer nonsense'), fake.client, 'read', { env: ENV }));
    await check(await A.authenticateApiRequest(req(`Bearer ${K.generateApiKey('test').secret}`), fake.client, 'read', { env: ENV }));
    await check(await A.authenticateApiRequest(req(`Bearer ${secret}`), fake.client, 'read', { env: { FLIZY_API_MODE: 'live' } }));
    seed({ key: { revoked_at: new Date().toISOString() } });
    await check(await A.authenticateApiRequest(req(`Bearer ${secret}`), fake.client, 'read', { env: ENV }));
    seed({ platform: { enabled: false } });
    await check(await A.authenticateApiRequest(req(`Bearer ${secret}`), fake.client, 'read', { env: ENV }));
    assert.equal(new Set(bodies).size, 1, bodies.join('\n'));
  });

  it('refuses a missing permission and an address outside the allowlist with 403', async () => {
    const noCollect = await A.authenticateApiRequest(req(`Bearer ${secret}`), fake.client, 'collect', { env: ENV });
    assert.equal(noCollect.response.status, 403);
    seed({ key: { ip_allowlist: ['1.2.3.4'] } });
    const elsewhere = await A.authenticateApiRequest(req(`Bearer ${secret}`, '5.6.7.8'), fake.client, 'read', { env: ENV });
    assert.equal(elsewhere.response.status, 403);
    const listed = await A.authenticateApiRequest(req(`Bearer ${secret}`, '1.2.3.4'), fake.client, 'read', { env: ENV });
    assert.equal(listed.ok, true);
  });

  it('rate limits each key per minute from the request log', async () => {
    const now = Date.now();
    fake.db.tables.api_requests = Array.from({ length: A.RATE_PER_MINUTE }, (_, i) => ({
      id: `r${i}`,
      key_id: keyId,
      created_at: new Date(now - 1000).toISOString(),
    }));
    const r = await A.authenticateApiRequest(req(`Bearer ${secret}`), fake.client, 'read', { env: ENV, now });
    assert.equal(r.response.status, 429);
    fake.db.tables.api_requests.forEach((row) => (row.created_at = new Date(now - 120_000).toISOString()));
    assert.equal((await A.authenticateApiRequest(req(`Bearer ${secret}`), fake.client, 'read', { env: ENV, now })).ok, true);
  });

  it('logs each authenticated call with the key id, never the key', async () => {
    const r = await A.authenticateApiRequest(req(`Bearer ${secret}`), fake.client, 'read', { env: ENV });
    await A.logApiRequest(fake.client, req(`Bearer ${secret}`), r.caller, 200);
    const row = fake.db.tables.api_requests[0];
    assert.equal(row.key_id, keyId);
    assert.ok(!JSON.stringify(row).includes(secret));
    assert.ok(fake.db.tables.api_keys[0].last_used_at);
  });

  it('needs both halves of the payout switch on', async () => {
    assert.equal(await A.payoutsEnabled(fake.client, { API_PAYOUTS_ENABLED: 'true' }), false);
    fake.db.tables.api_control[0].payouts_enabled = true;
    assert.equal(await A.payoutsEnabled(fake.client, {}), false);
    assert.equal(await A.payoutsEnabled(fake.client, { API_PAYOUTS_ENABLED: 'true' }), true);
    assert.match(SQL, /payouts_enabled boolean not null default false/);
  });
});

describe('Idempotency-Key', () => {
  let fake;
  beforeEach(() => {
    fake = createFakeSupabase({ api_idempotency: [] });
  });
  const hash = (b) => I.requestHash('POST', '/api/v1/payouts', b);
  // The fake applies no column defaults; fill the ones the migration declares.
  const begin = async (...args) => {
    const out = await I.beginIdempotent(fake.client, ...args);
    for (const row of fake.db.tables.api_idempotency) {
      row.state ??= 'in_progress';
      row.expires_at ??= new Date(Date.now() + 24 * 3600_000).toISOString();
    }
    return out;
  };

  it('records the first request, replays its answer, and refuses a different request with the same key', async () => {
    assert.deepEqual(await begin('k1', 'order-42', hash('{"a":1}')), { kind: 'new' });
    assert.deepEqual(await begin('k1', 'order-42', hash('{"a":1}')), { kind: 'in_progress' });
    await I.finishIdempotent(fake.client, 'k1', 'order-42', 202, { id: 'po_1', state: 'accepted' });
    assert.deepEqual(await begin('k1', 'order-42', hash('{"a":1}')), {
      kind: 'replay',
      status: 202,
      body: { id: 'po_1', state: 'accepted' },
    });
    assert.deepEqual(await begin('k1', 'order-42', hash('{"a":2}')), { kind: 'conflict' });
  });

  it('keeps keys apart per API key, refuses a malformed key, and frees an expired one', async () => {
    assert.deepEqual(await begin('k2', 'order-42', hash('x')), { kind: 'new' });
    assert.deepEqual(await begin('k1', '', hash('x')), { kind: 'invalid' });
    assert.deepEqual(await begin('k1', 'has space', hash('x')), { kind: 'invalid' });
    fake.db.tables.api_idempotency[0].expires_at = new Date(Date.now() - 1000).toISOString();
    assert.deepEqual(await begin('k2', 'order-42', hash('y')), { kind: 'new' });
  });
});

describe('platform keys from the Developers page', () => {
  let fake;
  const platform = { id: 'plat-1', account_id: 'acc-1', display_name: 'Acme', wallet_address: '0x' + 'ab'.repeat(20), enabled: true, fee_bps: 0 };
  beforeEach(() => {
    fake = createFakeSupabase({ api_platforms: [platform, { ...platform, id: 'plat-2', account_id: 'acc-2' }], api_keys: [], api_key_events: [] });
  });

  it('creates a key with read or collect, never payout, and returns the secret once', async () => {
    const made = await P.createKey(fake.client, platform, { label: 'Prod\nserver', scopes: ['read'], ipAllowlist: [], mode: 'test' });
    assert.match(made.secret, /^fz_test_/);
    const row = fake.db.tables.api_keys[0];
    assert.equal(row.key_hash, K.hashApiKey(made.secret));
    assert.ok(!JSON.stringify(row).includes(made.secret));
    assert.equal(row.label, 'Prod server');
    await assert.rejects(P.createKey(fake.client, platform, { label: '', scopes: ['payout'], ipAllowlist: [], mode: 'test' }), /granted by Flizy/);
  });

  it('caps active keys per platform', async () => {
    for (let i = 0; i < P.MAX_ACTIVE_KEYS; i += 1) await P.createKey(fake.client, platform, { label: '', scopes: ['read'], ipAllowlist: [], mode: 'test' });
    await assert.rejects(P.createKey(fake.client, platform, { label: '', scopes: ['read'], ipAllowlist: [], mode: 'test' }), /active keys/);
  });

  it('revokes and rotates only its own keys, and rotation keeps permissions Flizy granted', async () => {
    const mine = await P.createKey(fake.client, platform, { label: 'a', scopes: ['read'], ipAllowlist: [], mode: 'test' });
    fake.db.tables.api_keys[0].scopes = ['read', 'payout'];
    const other = { ...platform, id: 'plat-2' };
    assert.equal(await P.revokeKey(fake.client, other, mine.key.id), false);
    assert.equal(await P.rotateKey(fake.client, other, mine.key.id), null);
    const rotated = await P.rotateKey(fake.client, platform, mine.key.id);
    assert.deepEqual(rotated.key.scopes, ['read', 'payout']);
    assert.ok(fake.db.tables.api_keys.find((k) => k.id === mine.key.id).revoked_at, 'old key revoked');
    assert.equal(fake.db.tables.api_keys.filter((k) => !k.revoked_at).length, 1, 'other keys untouched, one live key');
    assert.equal(await P.revokeKey(fake.client, platform, mine.key.id), false, 'already revoked');
  });

  it('mails key events, marking one mailed only when it went out, and names only the prefix', async () => {
    const made = await P.createKey(fake.client, platform, { label: 'a', scopes: ['read'], ipAllowlist: [], mode: 'test' });
    fake.db.tables.api_key_events = [
      { id: 'e1', key_id: made.key.id, platform_id: platform.id, kind: 'scopes_changed', scopes: ['read', 'payout'], created_at: new Date().toISOString(), mailed_at: null },
    ];
    const sentTo = [];
    assert.equal(await P.mailKeyEvents(fake.client, async () => false, 'https://flizy.app'), 0);
    assert.equal(fake.db.tables.api_key_events[0].mailed_at, null);
    assert.equal(
      await P.mailKeyEvents(fake.client, async (id, mail) => (sentTo.push([id, mail]), true), 'https://flizy.app'),
      1
    );
    assert.ok(fake.db.tables.api_key_events[0].mailed_at);
    assert.equal(sentTo[0][0], 'acc-1');
    assert.match(sentTo[0][1].text, /now read, payout/);
    assert.ok(!sentTo[0][1].text.includes(made.secret));
  });

  it('mails an event once when two runs overlap, and frees it again when the mailer throws', async () => {
    const made = await P.createKey(fake.client, platform, { label: 'a', scopes: ['read'], ipAllowlist: [], mode: 'test' });
    fake.db.tables.api_key_events = [
      { id: 'e1', key_id: made.key.id, platform_id: platform.id, kind: 'created', scopes: ['read'], created_at: new Date().toISOString(), mailed_at: null },
    ];
    await assert.doesNotReject(P.mailKeyEvents(fake.client, async () => { throw new Error('smtp down'); }, 'https://flizy.app'));
    assert.equal(fake.db.tables.api_key_events[0].mailed_at, null);
    let mails = 0;
    const mailer = async () => ((mails += 1), true);
    const [a, b] = await Promise.all([
      P.mailKeyEvents(fake.client, mailer, 'https://flizy.app'),
      P.mailKeyEvents(fake.client, mailer, 'https://flizy.app'),
    ]);
    assert.equal(mails, 1);
    assert.equal(a + b, 1);
  });

  // The fake simulates no triggers or unique indexes; these hand the app the
  // errors the database raises, to prove the app answers them correctly.
  function insertFails(client, code) {
    return {
      from(t) {
        const q = client.from(t);
        if (t === 'api_keys') q.insert = () => ({ select: () => ({ single: async () => ({ data: null, error: { code, message: 'refused' } }) }) });
        return q;
      },
    };
  }

  it('turns the database key cap into the same message as the app check', async () => {
    await assert.rejects(
      P.createKey(insertFails(fake.client, '23514'), platform, { label: '', scopes: ['read'], ipAllowlist: [], mode: 'test' }),
      (err) => err instanceof P.KeyRequestError && /active keys/.test(err.message)
    );
  });

  it('rotates a key once: a second rotation refused by the index leaves the old key alone', async () => {
    const mine = await P.createKey(fake.client, platform, { label: 'a', scopes: ['read'], ipAllowlist: [], mode: 'test' });
    assert.equal(await P.rotateKey(insertFails(fake.client, '23505'), platform, mine.key.id), null);
    assert.equal(fake.db.tables.api_keys.length, 1);
    assert.equal(fake.db.tables.api_keys[0].revoked_at ?? null, null);
  });
});

describe('the migration', () => {
  it('keeps every API table service role only, with row level security on', () => {
    for (const t of ['api_control', 'api_platforms', 'api_keys', 'api_key_events', 'api_requests', 'api_idempotency', 'api_transactions', 'api_webhook_endpoints', 'api_webhook_events', 'api_webhook_attempts']) {
      assert.match(SQL, new RegExp(`'${t}'`), t);
      assert.match(SQL, new RegExp(`create table if not exists public\\.${t} \\(`), t);
      assert.match(SQL, new RegExp(`alter table public\\.${t} enable row level security;`), t);
    }
    assert.match(SQL, /revoke all on function public\.api_transition\(uuid, text, jsonb\) from public, anon, authenticated;/);
  });

  it('stores keys only as digests, limits permissions, and defaults the fee to 0', () => {
    assert.match(SQL, /key_hash text not null unique/);
    assert.match(SQL, /scopes <@ array\['read', 'collect', 'payout'\]::text\[\]/);
    assert.match(SQL, /fee_bps integer not null default 0/);
    assert.match(SQL, /claim_expiry_default_days integer not null default 30/);
  });

  it('records key changes by trigger, so a permission granted by hand is recorded too', () => {
    assert.match(SQL, /elsif new\.scopes is distinct from old\.scopes then/);
    assert.match(SQL, /after insert or update on public\.api_keys/);
  });

  it('holds the key cap and single rotation in the database, with the same number as the app', () => {
    assert.match(SQL, /\) >= 10 then\s+raise exception 'api key limit reached' using errcode = 'check_violation';/);
    assert.equal(P.MAX_ACTIVE_KEYS, 10);
    assert.match(SQL, /perform 1 from public\.api_platforms where id = new\.platform_id for update;/);
    assert.match(SQL, /and id is distinct from new\.rotated_from/);
    // A repeat rotation is answered before the count, so the app always sees 23505 for it.
    const trig = SQL.slice(SQL.indexOf('function public.api_keys_cap_trigger'));
    assert.ok(trig.indexOf("using errcode = 'unique_violation'") < trig.indexOf('select count(*) from public.api_keys'));
    assert.match(SQL, /before insert on public\.api_keys/);
    assert.match(SQL, /create unique index if not exists api_keys_rotated_from_idx\s+on public\.api_keys \(rotated_from\) where rotated_from is not null;/);
  });

  it('refuses a missing target state explicitly', () => {
    assert.match(SQL, /if p_to_state is null or not \(p_to_state = any \(allowed\)\) then/);
  });

  it('ends with a post-condition that fails a partial apply', () => {
    assert.match(SQL, /raise exception 'public\.% is missing', t;/);
    assert.match(SQL, /raise exception 'trigger api_keys_events is missing';/);
    assert.match(SQL, /raise exception 'trigger api_keys_cap is missing';/);
    assert.match(SQL, /raise exception 'index api_keys_rotated_from_idx is missing';/);
  });
});

describe('routes', () => {
  it('creating, rotating and revoking a key take the password and the same-origin check', () => {
    for (const rel of ['web/app/api/developers/keys/route.ts', 'web/app/api/developers/keys/[id]/revoke/route.ts', 'web/app/api/developers/keys/[id]/rotate/route.ts']) {
      const src = read(rel);
      assert.match(src, /rejectIfCrossOrigin\(req\)/, rel);
      assert.match(src, /requirePassword\(/, rel);
      assert.match(src, /platformForAccount\(db, accountId\)/, rel);
    }
    assert.match(read('web/app/api/developers/keys/route.ts'), /const scopes = cleanScopes\(body\.scopes\);/);
  });

  it('GET /api/v1/me authenticates with the read permission and logs the call', () => {
    const src = read('web/app/api/v1/me/route.ts');
    assert.match(src, /authenticateApiRequest\(req, db, 'read'\)/);
    assert.match(src, /logApiRequest\(db, req, caller, 200\)/);
  });

  it('moves no money: phase 1 has no payout or collect endpoint', () => {
    const v1 = path.join(ROOT, 'web', 'app', 'api', 'v1');
    assert.deepEqual(fs.readdirSync(v1), ['me']);
    for (const rel of ['web/lib/apiAuth.ts', 'web/lib/apiPlatforms.ts', 'web/app/api/v1/me/route.ts']) {
      assert.doesNotMatch(read(rel), /sendTransaction|executeGatorCall|executeClaim|transfers'\)\.insert/, rel);
    }
  });

  it('keeps the API settings server only', () => {
    const env = read('.env.example');
    assert.match(env, /# API_PAYOUTS_ENABLED=false/);
    assert.match(env, /# FLIZY_API_MODE=test/);
    assert.doesNotMatch(env, /NEXT_PUBLIC_(API_PAYOUTS|FLIZY_API)/);
  });

  it('shows the Developers section only to an approved platform', () => {
    const page = read('web/app/dashboard/account/page.tsx');
    assert.match(page, /\.\.\.\(isPlatform \? \[\{ id: 'developers', label: 'Developers' \}\] : \[\]\)/);
    assert.match(page, /\{slide === 'developers' && isPlatform \? <AccountDevelopers \/> : null\}/);
  });
});

describe('key notices from the VPS', () => {
  const N = require('../lib/apiKeyNotices');
  it('only sends the secret over https, or http to a local site', () => {
    assert.equal(N.apiKeyNoticeUrl('https://flizy.app'), 'https://flizy.app/api/internal/api-key-notices');
    assert.equal(N.apiKeyNoticeUrl('http://flizy.app'), null);
    assert.equal(N.apiKeyNoticeUrl('http://localhost:3100'), 'http://localhost:3100/api/internal/api-key-notices');
  });

  it('calls the site with the bearer secret, and does nothing when unconfigured', async () => {
    const calls = [];
    const fetch = async (url, init) => (calls.push([url, init.headers.authorization]), { ok: true });
    assert.equal(await N.pumpApiKeyNotices({ secret: 's3', siteUrl: 'https://flizy.app', fetch }), 'sent');
    assert.deepEqual(calls[0], ['https://flizy.app/api/internal/api-key-notices', 'Bearer s3']);
    assert.equal(await N.pumpApiKeyNotices({ secret: '', siteUrl: 'https://flizy.app', fetch }), 'unconfigured');
  });
});
