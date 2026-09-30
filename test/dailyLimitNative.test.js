/**
 * The daily send limit is an ETH limit, and it holds on every path.
 *
 * transfers.amount_eth and claims.amount_eth hold the amount in whatever asset
 * the row names, so a plain sum would count an FLZ pay or an NFT send as ETH.
 * Only native, outgoing, non-swap rows count, in one SQL function that chat and
 * the site both call. The site checks it on web pay, and chat checks it
 * again at confirm under the account lock, where the plan-time check could be
 * passed twice.
 *
 * Run: node --test test/dailyLimitNative.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake;
mockSupabaseModule({
  from: (table) => fake.client.from(table),
  rpc: (name, args) => fake.client.rpc(name, args),
});

const { getDailySentWei } = require('../lib/dailyLimits');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const now = () => new Date().toISOString();
const yesterday = () => new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

function seedMixedDay({ limit = null } = {}) {
  fake = createFakeSupabase({
    accounts: [{ id: 'acc-1', daily_send_limit_eth: limit }],
    transfers: [
      { account_id: 'acc-1', amount_eth: '0.01', asset: 'ETH', kind: 'transfer', status: 'confirmed', direction: 'out', created_at: now() },
      { account_id: 'acc-1', amount_eth: '500', asset: 'FLZ', kind: 'transfer', status: 'confirmed', direction: 'out', phone: 'site', created_at: now() },
      { account_id: 'acc-1', amount_eth: '0.2', asset: 'ETH', kind: 'swap', status: 'confirmed', direction: 'out', created_at: now() },
      { account_id: 'acc-1', amount_eth: '1', asset: 'GIWAFORGE', kind: 'transfer', status: 'confirmed', direction: 'out', created_at: now() },
      { account_id: 'acc-1', amount_eth: '5', asset: 'ETH', kind: 'transfer', status: 'failed', direction: 'out', created_at: now() },
      { account_id: 'acc-1', amount_eth: '1', asset: 'ETH', kind: 'transfer', status: 'confirmed', direction: 'out', created_at: yesterday() },
      { account_id: 'acc-1', amount_eth: '3', asset: 'ETH', kind: 'transfer', status: 'confirmed', direction: 'in', created_at: now() },
      { account_id: 'acc-other', amount_eth: '9', asset: 'ETH', kind: 'transfer', status: 'confirmed', direction: 'out', created_at: now() },
    ],
    claims: [
      { from_account_id: 'acc-1', amount_eth: '0.02', asset: 'ETH', status: 'pending', created_at: now() },
      { from_account_id: 'acc-1', amount_eth: '100', asset: 'FLZ', status: 'pending', created_at: now() },
      { from_account_id: 'acc-1', amount_eth: '4', asset: 'ETH', status: 'cancelled', created_at: now() },
    ],
  });
}

let site;
before(async () => {
  site = await import('../web/lib/dailyLimits.ts');
});

beforeEach(() => seedMixedDay());

describe('what counts as sent today', () => {
  it('only native, outgoing, non-swap sends and native claim holds', async () => {
    const wei = await getDailySentWei('acc-1');
    assert.equal(ethers.formatEther(wei), '0.03');
  });

  it('is defined once in SQL with exactly those filters', () => {
    const sql = fs.readFileSync(
      path.join(ROOT, 'supabase', 'migrations', '20260930120000_daily_native_sent.sql'),
      'utf8'
    );
    assert.match(sql, /create or replace function public\.daily_native_sent_eth\(p_account_id uuid\)/);
    assert.match(sql, /returns text/);
    assert.match(sql, /upper\(coalesce\(t\.asset, 'ETH'\)\) in \('ETH', 'NATIVE', 'ETHER'\)/);
    assert.match(sql, /coalesce\(t\.kind, 'transfer'\) <> 'swap'/);
    assert.match(sql, /coalesce\(t\.direction, 'out'\) = 'out'/);
    assert.match(sql, /t\.status in \('pending', 'submitted', 'confirmed'\)/);
    assert.match(sql, /upper\(coalesce\(c\.asset, 'ETH'\)\) in \('ETH', 'NATIVE', 'ETHER'\)/);
    assert.match(sql, /c\.status in \('pending', 'processing', 'claimed'\)/);
    assert.match(sql, /revoke all on function public\.daily_native_sent_eth\(uuid\) from public, anon, authenticated/);
  });
});

describe('web pay limit', () => {
  const eth = (v) => ethers.parseEther(v);

  it('does not count an FLZ pay toward the ETH limit', async () => {
    seedMixedDay({ limit: 0.05 });
    // 0.03 sent in ETH today, 500 FLZ ignored: 0.02 more fits exactly.
    assert.deepEqual(await site.checkDailyNativeLimit(fake.client, 'acc-1', eth('0.02')), { ok: true });
  });

  it('refuses an ETH pay over the limit', async () => {
    seedMixedDay({ limit: 0.05 });
    const r = await site.checkDailyNativeLimit(fake.client, 'acc-1', eth('0.021'));
    assert.equal(r.ok, false);
    assert.match(r.message, /Daily ETH send limit reached/);
    assert.match(r.message, /Remaining: 0\.02 ETH/);
  });

  it('treats a limit of 0 as blocking every ETH send, and no limit as none', async () => {
    seedMixedDay({ limit: 0 });
    assert.equal((await site.checkDailyNativeLimit(fake.client, 'acc-1', eth('0.000001'))).ok, false);
    seedMixedDay({ limit: null });
    assert.deepEqual(await site.checkDailyNativeLimit(fake.client, 'acc-1', eth('50')), { ok: true });
  });

  it('throws when the total cannot be read, so the pay is not made', async () => {
    seedMixedDay({ limit: 1 });
    const broken = {
      from: (table) => fake.client.from(table),
      rpc: async () => ({ data: null, error: { message: 'database unreachable' } }),
    };
    await assert.rejects(() => site.checkDailyNativeLimit(broken, 'acc-1', eth('0.01')));
  });

  it('runs inside the account lock, on the ETH branch, before anything is signed', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web', 'app', 'api', 'pay', 'execute', 'route.ts'), 'utf8');
    const lock = src.indexOf('tryAccountTxLock(supabase, payerId');
    const check = src.indexOf('checkDailyNativeLimit(supabase, payerId, amountWei)');
    const ethBranch = src.indexOf("if (asset === 'ETH')");
    const flzBranch = src.indexOf('} else {', ethBranch);
    assert.ok(lock > 0 && check > lock, 'the check must come after the lock');
    assert.ok(check > ethBranch && check < flzBranch, 'the check belongs to the ETH branch');
    for (const later of ["from('transfers')", 'executeGatorCall(', 'signer.sendTransaction(']) {
      assert.ok(src.indexOf(later, ethBranch) > check, `${later} runs before the limit is checked`);
    }
  });
});
