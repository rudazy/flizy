/**
 * Passkey approvals on flizy.app (web/lib/custody/approvals.ts, the route and
 * the page).
 *
 * What is pinned: what the page shows comes from the stored row, never the
 * URL; only the signed-in account that owns the payment can open it, any other
 * reads as a link that never existed; the passkey signs a one-off permission
 * for exactly that payment, expiring with the approval; the account confirms
 * the signature before it counts; a link approves once; cancel and expiry
 * close it.
 *
 * Run: node --test test/custodyApprovalsWeb.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { createSoftPasskey, ORIGIN } = require('./helpers/softPasskey');
const A = require('../lib/custody/approvals');
const C = require('../lib/custody/delegations');

const ME = '0b8c3f2a-1111-4222-8333-444455556666';
const OTHER = '0b8c3f2a-9999-4222-8333-444455556666';
const OUTSIDER = '0b8c3f2a-7777-4222-8333-444455556666';
const GATOR = ethers.getAddress('0x' + 'aa'.repeat(20));
const RELAYER = ethers.getAddress('0x' + 'bb'.repeat(20));
const TO = ethers.getAddress('0x' + '33'.repeat(20));
const NOW = new Date('2026-10-25T10:00:00Z');

let W;
before(async () => {
  process.env.CUSTODY_PILOT_ACCOUNTS = `${ME},${OTHER}`;
  W = await import('../web/lib/custody/approvals.ts');
});

let fake;
let token;
let passkey;
let keyId;
let chainSays;
const db = () => fake.client;
const row = () => fake.db.tables.custody_approvals[0];
const deps = (now = NOW) => ({
  call: async () => new ethers.Interface(['function f() view returns (bytes4)']).encodeFunctionResult('f', [chainSays]),
  now: () => now,
});

beforeEach(async () => {
  passkey = createSoftPasskey();
  keyId = Buffer.from(ethers.randomBytes(20)).toString('base64url');
  fake = createFakeSupabase({
    custody_approvals: [],
    transfers: [{ id: 'tx-row', status: 'pending', account_id: ME }],
    custody_passkeys: [{ account_id: ME, key_id: keyId, x: ethers.toBeHex(passkey.point.x, 32), y: ethers.toBeHex(passkey.point.y, 32), status: 'added' }],
  });
  chainSays = '0x1626ba7e';
  const out = await A.createApproval({
    supabase: db(),
    accountId: ME,
    gator: GATOR,
    delegate: RELAYER,
    symbol: 'TUSD',
    to: TO,
    amount: 75n * 10n ** 6n,
    amountDisplay: '75 tUSD',
    recipientLabel: '@kemi',
    transferId: 'tx-row',
    siteUrl: 'https://flizy.app',
    now: NOW,
  });
  token = out.url.split('/approve/')[1];
});

async function approveWithPasskey(pk = passkey, id = keyId) {
  const { challenge } = await W.beginApproval(db(), ME, token, deps());
  const a = pk.assert('0x' + Buffer.from(challenge, 'base64url').toString('hex'));
  const b64 = (x) => Buffer.from(x).toString('base64url');
  return W.finishApproval(
    db(),
    ME,
    token,
    { credentialId: id, authenticatorData: b64(a.authenticatorData), clientDataJSON: b64(a.clientDataJSON), signature: b64(a.signature) },
    ORIGIN,
    deps()
  );
}

describe('rule 1: details come from the server, for the right session only', () => {
  it('shows recipient, address, asset and amount from the stored row', async () => {
    assert.deepEqual(await W.viewApproval(db(), ME, token, deps()), {
      status: 'pending',
      asset: 'TUSD',
      amount: '75 tUSD',
      recipientLabel: '@kemi',
      recipientAddress: TO,
      expiresAt: row().expires_at,
      txHash: null,
    });
  });

  it('another account, an unknown token, or a malformed one all read as not found', async () => {
    await assert.rejects(() => W.viewApproval(db(), OTHER, token, deps()), { message: W.APPROVAL_NOT_FOUND });
    await assert.rejects(() => W.viewApproval(db(), ME, 'A'.repeat(22), deps()), { message: W.APPROVAL_NOT_FOUND });
    await assert.rejects(() => W.viewApproval(db(), ME, '../../etc', deps()), { message: W.APPROVAL_NOT_FOUND });
    await assert.rejects(() => W.beginApproval(db(), OTHER, token, deps()), { message: W.APPROVAL_NOT_FOUND });
    await assert.rejects(() => W.cancelApproval(db(), OTHER, token, deps()), { message: W.APPROVAL_NOT_FOUND });
    assert.equal(row().status, 'pending');
  });

  it('an account outside the pilot is refused', async () => {
    await assert.rejects(() => W.viewApproval(db(), OUTSIDER, token, deps()), /not open yet/);
  });

  it('the page and the route take only the token from the URL', () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const page = read('web/app/approve/[token]/page.tsx');
    const component = read('web/components/ApprovePayment.tsx');
    const route = read('web/app/api/custody/approvals/[token]/route.ts');
    for (const src of [page, component, route]) assert.doesNotMatch(src, /searchParams|useSearchParams|URLSearchParams/);
    assert.match(component, /fetch\(`\/api\/custody\/approvals\/\$\{encodeURIComponent\(token\)\}`/);
    assert.match(route, /getAccountIdFromCookie\(\)/);
    assert.match(route, /rejectIfCrossOrigin\(req\)/);
  });
});

describe('rule 3: the passkey signs exactly this payment, once', () => {
  it('the permission pins this token, recipient and amount, and dies with the approval', async () => {
    await W.beginApproval(db(), ME, token, deps());
    const r = row();
    const expiresAt = Math.floor(new Date(r.expires_at).getTime() / 1000);
    assert.deepEqual(r.caveats, C.oneOffCaveats('TUSD', { to: TO, amount: 75n * 10n ** 6n, expiresAt }));
    const rebuilt = { delegate: RELAYER, delegator: GATOR, authority: C.ROOT_AUTHORITY, caveats: r.caveats, salt: BigInt(r.salt), signature: '0x' };
    assert.equal(C.delegationDigest(rebuilt), r.digest);
  });

  it('becomes signed only after the wallet accepts the passkey signature', async () => {
    assert.deepEqual(await approveWithPasskey(), { status: 'signed' });
    assert.equal(row().status, 'signed');
    assert.match(row().signature, /^0x[0-9a-f]+$/);
  });

  it('a link approves once', async () => {
    await approveWithPasskey();
    await assert.rejects(() => approveWithPasskey(), /can no longer be approved/);
  });

  it('refuses a passkey that is not on the account, or a signature the wallet rejects', async () => {
    await assert.rejects(() => approveWithPasskey(createSoftPasskey(), 'not-a-key-on-this-account'), /not on this account/);
    await assert.rejects(() => approveWithPasskey(createSoftPasskey(), keyId), /does not match this key/);
    chainSays = '0xffffffff';
    await assert.rejects(() => approveWithPasskey(), /did not accept/);
    assert.equal(row().status, 'pending');
  });
});

describe('rule 4: cancel and expiry move nothing', () => {
  it('cancel from the page closes it and fails the transfer; it cannot be approved after', async () => {
    assert.deepEqual(await W.cancelApproval(db(), ME, token, deps()), { status: 'cancelled' });
    assert.equal(fake.db.tables.transfers[0].status, 'failed');
    await assert.rejects(() => W.beginApproval(db(), ME, token, deps()), /can no longer be approved/);
    await assert.rejects(() => W.cancelApproval(db(), ME, token, deps()), /can no longer be cancelled/);
    assert.equal((await W.viewApproval(db(), ME, token, deps())).status, 'cancelled');
  });

  it('a signed approval can still be cancelled before the worker claims it', async () => {
    await approveWithPasskey();
    await W.cancelApproval(db(), ME, token, deps());
    assert.equal(row().status, 'cancelled');
  });

  it('after ten minutes it reads expired and cannot be approved', async () => {
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    assert.equal((await W.viewApproval(db(), ME, token, deps(later))).status, 'expired');
    await assert.rejects(() => W.beginApproval(db(), ME, token, deps(later)), /can no longer be approved/);
  });

  it('chat cancel reaches the database: the router hands its account to cancelOpenApprovals', () => {
    const router = fs.readFileSync(path.join(__dirname, '..', 'lib', 'router.js'), 'utf8');
    assert.match(router, /async function handleCancel\(ctx, account = null\)/);
    assert.match(router, /await cancelOpenApprovals\(\{ supabase, accountId: account\.id \}\)/);
    assert.match(router, /await handleCancel\(ctx, account\);/);
  });
});
