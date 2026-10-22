/**
 * Secure this account, steps 1 and 2 (web/lib/custody/ceremony.ts).
 *
 * What is pinned: only pilot accounts may start; a passkey challenge is used
 * once, by its own account, before it expires, from this site; the key goes on
 * chain as addKey on the account itself and counts only once the account holds
 * that exact point; delegations are built fresh, signed by a passkey that is on
 * the account, confirmed by the account (ERC-1271), and only then made live,
 * replacing the previous one for that asset.
 *
 * The database is the in-memory fake; the chain is a stand-in that stores
 * addKey and answers getKey and isValidSignature.
 *
 * Run: node --test test/custodyCeremony.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { createSoftPasskey, ORIGIN } = require('./helpers/softPasskey');

const ME = '0b8c3f2a-1111-4222-8333-444455556666';
const OTHER = '0b8c3f2a-9999-4222-8333-444455556666';
const GATOR = '0x' + 'aa'.repeat(20);
const RELAYER = '0x' + 'bb'.repeat(20);
const ACCOUNT_IFACE = new ethers.Interface([
  'function addKey(string _keyId, uint256 _x, uint256 _y)',
  'function getKey(string _keyId) view returns (uint256 x_, uint256 y_)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);

let C;
let D;
before(async () => {
  process.env.CUSTODY_PILOT_ACCOUNTS = `${ME}`;
  process.env.CUSTODY_DELEGATE_ADDRESS = RELAYER;
  C = await import('../web/lib/custody/ceremony.ts');
  D = await import('../web/lib/custody/delegations.ts');
});

let fake;
let chain;
let notices;
let clock;
const db = () => fake.client;
const table = (t) => fake.db.tables[t] || [];

function deps(overrides = {}) {
  return {
    gatorOf: async (id) => (id === ME || id === OTHER ? GATOR : null),
    execAsAccount: async ({ target, data, onBroadcast }) => {
      chain.execs.push({ target, data });
      const txHash = '0x' + String(chain.execs.length).padStart(64, '0');
      if (chain.failExec) throw new Error('handleOps refused');
      await onBroadcast(txHash);
      const [keyId, x, y] = ACCOUNT_IFACE.decodeFunctionData('addKey', data);
      if (chain.noReceipt) {
        // Sent, then the node went quiet. The key lands later.
        chain.landLater = () => chain.keys.set(keyId, [x, y]);
        throw new Error('No receipt yet');
      }
      chain.keys.set(keyId, chain.storeWrongPoint ? [x + 1n, y] : [x, y]);
      return { txHash };
    },
    call: async (to, data) => {
      assert.equal(to, GATOR);
      const fn = ACCOUNT_IFACE.parseTransaction({ data });
      if (fn.name === 'getKey') {
        const [x, y] = chain.keys.get(fn.args[0]) || [0n, 0n];
        return ACCOUNT_IFACE.encodeFunctionResult('getKey', [x, y]);
      }
      return ACCOUNT_IFACE.encodeFunctionResult('isValidSignature', [chain.rejectSignatures ? '0xffffffff' : '0x1626ba7e']);
    },
    notify: async (id, body) => {
      notices.push({ id, body });
    },
    now: () => clock,
    ...overrides,
  };
}

beforeEach(() => {
  fake = createFakeSupabase({});
  chain = { execs: [], keys: new Map(), failExec: false, rejectSignatures: false, storeWrongPoint: false };
  notices = [];
  clock = new Date('2026-10-24T10:00:00Z');
});

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function createAnswer(pk, challenge, { origin = ORIGIN, type = 'webauthn.create', alg = -7, credentialId } = {}) {
  return {
    credentialId: credentialId || b64(ethers.randomBytes(20)),
    clientDataJSON: b64(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))),
    publicKey: b64(pk.spki),
    publicKeyAlgorithm: alg,
  };
}

async function addPasskey(pk = createSoftPasskey()) {
  const opts = await C.beginPasskey(db(), ME, 'ludarep', deps());
  const answer = createAnswer(pk, opts.challenge);
  const done = await C.finishPasskey(db(), ME, answer, ORIGIN, deps());
  return { pk, keyId: answer.credentialId, done };
}

function signAll(pk, keyId, requests) {
  return requests.map((r) => {
    const digest = '0x' + Buffer.from(r.challenge, 'base64url').toString('hex');
    const a = pk.assert(digest);
    return { id: r.id, credentialId: keyId, authenticatorData: b64(a.authenticatorData), clientDataJSON: b64(a.clientDataJSON), signature: b64(a.signature) };
  });
}

describe('who may start', () => {
  it('refuses any account outside the pilot, at every step', async () => {
    await assert.rejects(() => C.beginPasskey(db(), OTHER, 'x', deps()), { message: C.NOT_IN_PILOT });
    await assert.rejects(() => C.finishPasskey(db(), OTHER, {}, ORIGIN, deps()), { message: C.NOT_IN_PILOT });
    await assert.rejects(() => C.beginDelegations(db(), OTHER, deps()), { message: C.NOT_IN_PILOT });
    await assert.rejects(() => C.finishDelegations(db(), OTHER, [], ORIGIN, deps()), { message: C.NOT_IN_PILOT });
    assert.equal(C.inPilot(''), false);
  });

  it('refuses an account whose wallet is not a HybridDeleGator', async () => {
    await assert.rejects(() => C.beginPasskey(db(), ME, 'x', deps({ gatorOf: async () => null })), /cannot take a passkey/);
  });
});

describe('step 1: a passkey on the account', () => {
  it('hands out a one-time challenge and an opaque user handle', async () => {
    const opts = await C.beginPasskey(db(), ME, 'ludarep', deps());
    assert.match(opts.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(table('custody_challenges').length, 1);
    assert.equal(table('custody_challenges')[0].account_id, ME);
    assert.ok(!Buffer.from(opts.userId, 'base64url').toString('latin1').includes(ME), 'no account id in the authenticator');
  });

  it('adds the key on the account itself, and counts it only once the account holds it', async () => {
    const { pk, keyId, done } = await addPasskey();
    assert.equal(chain.execs.length, 1);
    assert.equal(chain.execs[0].target, GATOR, 'a call from the account to itself');
    const [k, x, y] = ACCOUNT_IFACE.decodeFunctionData('addKey', chain.execs[0].data);
    assert.deepEqual([k, x, y], [keyId, pk.point.x, pk.point.y]);
    const row = table('custody_passkeys')[0];
    assert.equal(row.status, 'added');
    assert.equal(row.add_tx_hash, done.txHash);
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /passkey was added/);
  });

  it('uses a challenge once', async () => {
    const pk = createSoftPasskey();
    const opts = await C.beginPasskey(db(), ME, 'x', deps());
    await C.finishPasskey(db(), ME, createAnswer(pk, opts.challenge), ORIGIN, deps());
    await assert.rejects(() => C.finishPasskey(db(), ME, createAnswer(createSoftPasskey(), opts.challenge), ORIGIN, deps()), /expired/);
  });

  it('refuses an expired challenge, or one made for another account', async () => {
    const opts = await C.beginPasskey(db(), ME, 'x', deps());
    clock = new Date(clock.getTime() + 5 * 60 * 1000 + 1);
    await assert.rejects(() => C.finishPasskey(db(), ME, createAnswer(createSoftPasskey(), opts.challenge), ORIGIN, deps()), /expired/);
    clock = new Date('2026-10-24T10:00:00Z');
    table('custody_challenges')[0].used_at = null;
    table('custody_challenges')[0].account_id = OTHER;
    await assert.rejects(() => C.finishPasskey(db(), ME, createAnswer(createSoftPasskey(), opts.challenge), ORIGIN, deps()), /expired/);
    assert.equal(chain.execs.length, 0);
  });

  it('refuses another site, the wrong step, another algorithm, or a key that is not P-256', async () => {
    const crypto = require('crypto');
    const cases = [
      [{ origin: 'https://evil.app' }, /another site/],
      [{ type: 'webauthn.get' }, /different step/],
      [{ alg: -257 }, /cannot use/],
    ];
    for (const [opt, msg] of cases) {
      const opts = await C.beginPasskey(db(), ME, 'x', deps());
      await assert.rejects(() => C.finishPasskey(db(), ME, createAnswer(createSoftPasskey(), opts.challenge, opt), ORIGIN, deps()), msg);
    }
    const opts = await C.beginPasskey(db(), ME, 'x', deps());
    const p384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' });
    const answer = { ...createAnswer(createSoftPasskey(), opts.challenge), publicKey: b64(p384) };
    await assert.rejects(() => C.finishPasskey(db(), ME, answer, ORIGIN, deps()), /not a P-256/);
    assert.equal(chain.execs.length, 0, 'nothing reached the chain');
  });

  it('marks the passkey failed when the chain refuses or stores something else', async () => {
    chain.failExec = true;
    await assert.rejects(() => addPasskey(), /handleOps refused/);
    assert.equal(table('custody_passkeys')[0].status, 'failed');
    chain.failExec = false;
    chain.storeWrongPoint = true;
    await assert.rejects(() => addPasskey(), /did not store/);
    assert.equal(table('custody_passkeys')[1].status, 'failed');
    assert.equal(notices.length, 0);
  });

  it('keeps a sent but unconfirmed passkey pending, and settles it from the account later', async () => {
    chain.noReceipt = true;
    await assert.rejects(() => addPasskey(), /not confirmed yet/);
    const row = table('custody_passkeys')[0];
    assert.equal(row.status, 'pending');
    assert.match(row.add_tx_hash, /^0x0+1$/);

    let status = await C.custodyStatus(db(), ME, deps());
    assert.deepEqual(status.passkeys.map((p) => p.status), ['pending'], 'not on the account yet');
    assert.equal(notices.length, 0);

    chain.landLater();
    status = await C.custodyStatus(db(), ME, deps());
    assert.deepEqual(status.passkeys.map((p) => p.status), ['added']);
    assert.equal(row.status, 'added');
    assert.equal(notices.length, 1, 'told once, when it landed');
    await C.custodyStatus(db(), ME, deps());
    assert.equal(notices.length, 1, 'not again');
  });
});

describe('status', () => {
  it('says nothing about an account outside the pilot', async () => {
    assert.deepEqual(await C.custodyStatus(db(), OTHER, deps()), { pilot: false, walletReady: false, passkeys: [], delegations: [] });
  });

  it('lists live, unexpired permissions only', async () => {
    const { pk, keyId } = await addPasskey();
    const { requests } = await C.beginDelegations(db(), ME, deps());
    await C.finishDelegations(db(), ME, signAll(pk, keyId, requests), ORIGIN, deps());
    const status = await C.custodyStatus(db(), ME, deps());
    assert.equal(status.walletReady, true);
    assert.deepEqual(status.delegations.map((d) => d.symbol), ['ETH', 'FLZ', 'TUSD']);
    const later = new Date(clock.getTime() + 31 * 86400 * 1000);
    assert.deepEqual((await C.custodyStatus(db(), ME, deps({ now: () => later }))).delegations, []);
  });
});

describe('step 2: the passkey signs the delegations', () => {
  it('needs a passkey on the account and a configured relayer first', async () => {
    await assert.rejects(() => C.beginDelegations(db(), ME, deps()), /Add a passkey first/);
    await addPasskey();
    const saved = process.env.CUSTODY_DELEGATE_ADDRESS;
    process.env.CUSTODY_DELEGATE_ADDRESS = '';
    try {
      await assert.rejects(() => C.beginDelegations(db(), ME, deps()), /CUSTODY_DELEGATE_ADDRESS/);
    } finally {
      process.env.CUSTODY_DELEGATE_ADDRESS = saved;
    }
  });

  it('builds one fresh delegation per asset, digest as the challenge', async () => {
    await addPasskey();
    const { requests, keyIds } = await C.beginDelegations(db(), ME, deps());
    assert.equal(keyIds.length, 1);
    assert.deepEqual(requests.map((r) => r.symbol), ['ETH', 'FLZ', 'TUSD']);
    for (const r of requests) {
      const row = table('custody_delegations').find((d) => d.id === r.id);
      const rebuilt = {
        delegate: ethers.getAddress(RELAYER),
        delegator: ethers.getAddress(GATOR),
        authority: D.ROOT_AUTHORITY,
        caveats: row.caveats,
        salt: BigInt(row.salt),
        signature: '0x',
      };
      assert.equal(row.digest, D.delegationDigest(rebuilt), 'stored row rebuilds the same digest');
      assert.equal('0x' + Buffer.from(r.challenge, 'base64url').toString('hex'), row.digest);
      assert.equal(row.status, 'pending');
    }
  });

  it('deletes an earlier unsigned build, so repeated starts never pile rows up', async () => {
    await addPasskey();
    const first = await C.beginDelegations(db(), ME, deps());
    for (let i = 0; i < 5; i++) await C.beginDelegations(db(), ME, deps());
    const rows = table('custody_delegations');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((d) => d.status === 'pending'));
    assert.ok(first.requests.every((r) => !rows.some((d) => d.id === r.id)), 'the first build is gone');
  });

  it('makes them live once the account accepts each signature, replacing the old ones', async () => {
    const { pk, keyId } = await addPasskey();
    const first = await C.beginDelegations(db(), ME, deps());
    assert.deepEqual((await C.finishDelegations(db(), ME, signAll(pk, keyId, first.requests), ORIGIN, deps())).active, ['ETH', 'FLZ', 'TUSD']);
    const second = await C.beginDelegations(db(), ME, deps());
    await C.finishDelegations(db(), ME, signAll(pk, keyId, second.requests), ORIGIN, deps());
    const live = table('custody_delegations').filter((d) => d.status === 'active');
    assert.equal(live.length, 3);
    assert.deepEqual(live.map((d) => d.id).sort(), second.requests.map((r) => r.id).sort());
    for (const d of live) assert.match(d.signature, /^0x[0-9a-f]+$/);
    assert.match(notices.at(-1).body, /spending permissions/);
  });

  it('refuses a passkey that is not on the account, and a signature the account rejects', async () => {
    const { pk, keyId } = await addPasskey();
    const { requests } = await C.beginDelegations(db(), ME, deps());
    const stranger = createSoftPasskey();
    await assert.rejects(() => C.finishDelegations(db(), ME, signAll(stranger, 'not-a-key-id-on-here', requests), ORIGIN, deps()), /not on this account/);
    await assert.rejects(() => C.finishDelegations(db(), ME, signAll(stranger, keyId, requests), ORIGIN, deps()), /does not match this key/);
    chain.rejectSignatures = true;
    await assert.rejects(() => C.finishDelegations(db(), ME, signAll(pk, keyId, requests), ORIGIN, deps()), /did not accept/);
    assert.equal(table('custody_delegations').filter((d) => d.status === 'active').length, 0, 'nothing went live');
  });

  it('refuses a stale build, a row from another account, or an empty answer', async () => {
    const { pk, keyId } = await addPasskey();
    const { requests } = await C.beginDelegations(db(), ME, deps());
    await assert.rejects(() => C.finishDelegations(db(), ME, [], ORIGIN, deps()), /Sign each permission/);
    const later = new Date(clock.getTime() + 15 * 60 * 1000 + 1000);
    await assert.rejects(() => C.finishDelegations(db(), ME, signAll(pk, keyId, requests), ORIGIN, deps({ now: () => later })), /too long/);
    table('custody_delegations')[0].account_id = OTHER;
    await assert.rejects(() => C.finishDelegations(db(), ME, signAll(pk, keyId, requests), ORIGIN, deps()), /no longer waiting/);
  });
});
