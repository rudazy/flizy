/**
 * The one-tap faucet, driven through web/lib/faucet.ts with a fake database and
 * a fake sender: who may claim, the 72-hour rule, one claim from a double
 * click, what frees a claim and what keeps it, and the dispenser key rules.
 *
 * try_faucet_claim and the signer lock are proven against real Postgres
 * separately; the fake holds the same rules so the application's decisions can
 * be pinned here without a network.
 *
 * Run: node --test test/faucet.test.js
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let F;
let fake;

before(async () => {
  F = await import('../web/lib/faucet.ts');
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const ALICE = 'acc-alice';
const BOB = 'acc-bob';
const WALLET = '0x' + 'ab'.repeat(20);
const BOB_WALLET = '0x' + 'cd'.repeat(20);
const AMOUNT_WEI = 20000000000000000n;
const HASH = (n) => '0x' + String(n).padStart(64, '0');

function seed(alice = {}) {
  fake = createFakeSupabase({
    accounts: [
      { id: ALICE, username: 'alice', email_verified_at: '2026-10-01T00:00:00.000Z', agent_wallet_address: WALLET, ...alice },
      { id: BOB, username: 'bob', email_verified_at: '2026-10-01T00:00:00.000Z', agent_wallet_address: BOB_WALLET },
    ],
    faucet_claims: [],
    faucet_signer_lock: [],
  });
}

/** A dispenser that records what it was asked to send. */
function sender({ balance = 10n ** 18n, sendError = null, outcome = 'confirmed', balanceError = null } = {}) {
  const sends = [];
  return {
    sends,
    async balance() {
      if (balanceError) throw balanceError;
      return balance;
    },
    async send(to, value) {
      if (sendError) throw sendError;
      sends.push({ to, value });
      return { hash: HASH(sends.length), wait: async () => outcome };
    },
  };
}

const c = () => fake.client;
const claims = () => fake.db.tables.faucet_claims;

describe('who can claim', () => {
  for (const [label, patch, reason] of [
    ['an unverified email', { email_verified_at: null }, 'Verify your email to claim.'],
    ['no username', { username: null }, 'Choose a username to claim.'],
    ['no wallet yet', { agent_wallet_address: null }, 'Your Flizy wallet is not ready yet.'],
    ['a deactivated account', { deactivated_at: '2026-10-02T00:00:00.000Z' }, 'This account cannot claim.'],
    ['a deleted account', { deleted_at: '2026-10-02T00:00:00.000Z' }, 'This account cannot claim.'],
  ]) {
    it(`refuses ${label}, before anything is reserved or sent`, async () => {
      seed(patch);
      const s = sender();
      await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s }), { message: reason });
      assert.equal(s.sends.length, 0);
      assert.equal(claims().length, 0);
    });
  }

  it('still works on a database without the account closure columns', async () => {
    seed();
    const base = fake.client;
    const client = {
      rpc: base.rpc.bind(base),
      from(table) {
        const query = base.from(table);
        if (table !== 'accounts') return query;
        const select = query.select.bind(query);
        query.select = (cols, opts) => {
          if (/deactivated_at/.test(cols)) {
            return { eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '42703', message: 'column accounts.deactivated_at does not exist' } }) }) };
          }
          return select(cols, opts);
        };
        return query;
      },
    };
    const s = sender();
    await F.claimFaucet(ALICE, { client, sender: s });
    assert.equal(s.sends.length, 1);
  });

  it('tells the screen why, and where to fix it', async () => {
    seed({ email_verified_at: null });
    process.env.FAUCET_PRIVATE_KEY = '0x' + '11'.repeat(32);
    try {
      const status = await F.faucetStatus(ALICE, c());
      assert.equal(status.eligible, false);
      assert.equal(status.reason, 'Verify your email to claim.');
      assert.equal(status.fix, 'profile');
    } finally {
      delete process.env.FAUCET_PRIVATE_KEY;
    }
  });
});

describe('claiming', () => {
  beforeEach(() => seed());

  it('sends exactly 0.02 ETH to the stored wallet and starts the 72-hour wait', async () => {
    const s = sender();
    const before = Date.now();
    const receipt = await F.claimFaucet(ALICE, { client: c(), sender: s });
    assert.equal(s.sends.length, 1);
    assert.equal(s.sends[0].to.toLowerCase(), WALLET);
    assert.equal(s.sends[0].value, AMOUNT_WEI);
    assert.equal(receipt.amountEth, '0.02');
    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.txHash, HASH(1));
    assert.match(receipt.txUrl, /\/tx\/0x0+1$/);
    const wait = new Date(receipt.nextClaimAt).getTime() - before;
    assert.ok(wait > 71.9 * 3600e3 && wait <= 72 * 3600e3 + 5000, String(wait));
    assert.equal(claims()[0].status, 'confirmed');
    assert.equal(claims()[0].tx_hash, HASH(1));
    assert.equal(fake.db.tables.faucet_signer_lock.length, 0, 'signer lock released');
  });

  it('refuses a second claim inside 72 hours, and sends nothing', async () => {
    const s = sender();
    await F.claimFaucet(ALICE, { client: c(), sender: s });
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s }), { message: F.FAUCET_COOLDOWN });
    assert.equal(s.sends.length, 1);
    process.env.FAUCET_PRIVATE_KEY = '0x' + '11'.repeat(32);
    try {
      const status = await F.faucetStatus(ALICE, c());
      assert.ok(status.nextClaimAt);
      assert.equal(status.lastClaim.status, 'confirmed');
      assert.match(status.lastClaim.txUrl, /\/tx\//);
    } finally {
      delete process.env.FAUCET_PRIVATE_KEY;
    }
  });

  it('opens again once 72 hours have passed', async () => {
    claims().push({ id: 'old', account_id: ALICE, to_address: WALLET, amount_wei: '1', status: 'confirmed', tx_hash: HASH(9), created_at: new Date(Date.now() - 73 * 3600e3).toISOString() });
    const s = sender();
    await F.claimFaucet(ALICE, { client: c(), sender: s });
    assert.equal(s.sends.length, 1);
  });

  it('turns a double click into one send', async () => {
    const s = sender();
    const results = await Promise.allSettled([
      F.claimFaucet(ALICE, { client: c(), sender: s }),
      F.claimFaucet(ALICE, { client: c(), sender: s }),
      F.claimFaucet(ALICE, { client: c(), sender: s }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(s.sends.length, 1);
  });

  it('lets two people claim at the same time, one after the other', async () => {
    const s = sender();
    await Promise.all([F.claimFaucet(ALICE, { client: c(), sender: s }), F.claimFaucet(BOB, { client: c(), sender: s })]);
    assert.deepEqual(s.sends.map((x) => x.to.toLowerCase()).sort(), [WALLET, BOB_WALLET].sort());
  });

  it('never sends to an address it was handed', async () => {
    const s = sender();
    // The route passes nothing but the account; a stray argument is ignored.
    await F.claimFaucet(ALICE, { client: c(), sender: s, to: '0x' + 'ee'.repeat(20) });
    assert.equal(s.sends[0].to.toLowerCase(), WALLET);
  });
});

describe('what frees a claim and what keeps it', () => {
  beforeEach(() => seed());

  it('frees it when the send fails, and says so plainly', async () => {
    await assert.rejects(
      () => F.claimFaucet(ALICE, { client: c(), sender: sender({ sendError: new Error('nonce too low at https://rpc.internal') }) }),
      { message: F.FAUCET_SEND_FAILED }
    );
    assert.equal(claims()[0].status, 'failed');
    // The RPC address in the error is not stored: a provider URL can carry an API key.
    assert.equal(claims()[0].error, 'nonce too low at [url]');
    const s = sender();
    await F.claimFaucet(ALICE, { client: c(), sender: s });
    assert.equal(s.sends.length, 1);
  });

  it('frees it when the transaction reverts', async () => {
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: sender({ outcome: 'reverted' }) }), {
      message: F.FAUCET_SEND_FAILED,
    });
    assert.equal(claims()[0].status, 'failed');
    await F.claimFaucet(ALICE, { client: c(), sender: sender() });
  });

  it('frees it when the dispenser cannot cover one claim, and sends nothing', async () => {
    const s = sender({ balance: AMOUNT_WEI });
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s }), { message: F.FAUCET_EMPTY });
    assert.equal(s.sends.length, 0);
    assert.equal(claims()[0].status, 'failed');
  });

  it('frees it when the chain cannot be read before sending', async () => {
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: sender({ balanceError: new Error('rpc down') }) }), /rpc down/);
    assert.equal(claims()[0].status, 'failed');
    assert.equal(fake.db.tables.faucet_signer_lock.length, 0);
  });

  it('keeps the wait when a sent transaction is not confirmed in time', async () => {
    const receipt = await F.claimFaucet(ALICE, { client: c(), sender: sender({ outcome: 'timeout' }) });
    assert.equal(receipt.status, 'sent');
    assert.equal(claims()[0].status, 'sent');
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: sender() }), { message: F.FAUCET_COOLDOWN });
  });

  it('does not let a request that died before sending lock anyone out', async () => {
    claims().push({ id: 'stuck', account_id: ALICE, to_address: WALLET, amount_wei: '1', status: 'pending', tx_hash: null, created_at: new Date(Date.now() - 10 * 60e3).toISOString() });
    const s = sender();
    await F.claimFaucet(ALICE, { client: c(), sender: s });
    assert.equal(s.sends.length, 1);
  });
});

describe('test USD', () => {
  const TUSD_ADDRESS = '0x4F28C18600c312Bfa8e8281D882e0EC306F82446';
  const TUSD_UNITS = 100n * 10n ** 6n;

  beforeEach(() => seed());

  /** A dispenser that holds tokens as well as ETH, and records token sends apart. */
  function usdSender({ eth = 10n ** 18n, held = 10n ** 12n, sendError = null, outcome = 'confirmed' } = {}) {
    const s = sender({ balance: eth });
    s.tokenSends = [];
    s.tokenBalance = async () => held;
    s.sendToken = async (token, to, units) => {
      if (sendError) throw sendError;
      s.tokenSends.push({ token, to, units });
      return { hash: HASH(100 + s.tokenSends.length), wait: async () => outcome };
    };
    return s;
  }

  it('reads usd and tusd as tUSD, nothing as ETH, and refuses anything else', () => {
    assert.equal(F.normalizeFaucetAsset('tusd'), 'TUSD');
    assert.equal(F.normalizeFaucetAsset('USD'), 'TUSD');
    assert.equal(F.normalizeFaucetAsset(null), 'ETH');
    assert.equal(F.normalizeFaucetAsset(''), 'ETH');
    assert.throws(() => F.normalizeFaucetAsset('FLZ'), { message: F.FAUCET_UNKNOWN_ASSET });
  });

  it('sends exactly 100 tUSD from the tUSD contract to the stored wallet and starts a 24-hour wait', async () => {
    const s = usdSender();
    const before = Date.now();
    const receipt = await F.claimFaucet(ALICE, { client: c(), sender: s, asset: 'TUSD' });
    assert.equal(s.sends.length, 0, 'no ETH sent');
    assert.equal(s.tokenSends.length, 1);
    assert.equal(s.tokenSends[0].token, TUSD_ADDRESS);
    assert.equal(s.tokenSends[0].to.toLowerCase(), WALLET);
    assert.equal(s.tokenSends[0].units, TUSD_UNITS);
    assert.equal(receipt.asset, 'TUSD');
    assert.equal(receipt.unit, 'tUSD');
    assert.equal(receipt.amount, '100');
    const wait = new Date(receipt.nextClaimAt).getTime() - before;
    assert.ok(wait > 23.9 * 3600e3 && wait <= 24 * 3600e3 + 5000, String(wait));
    assert.equal(claims()[0].asset, 'TUSD');
    assert.equal(claims()[0].amount_wei, String(TUSD_UNITS));
  });

  it('keeps the ETH and tUSD waits apart', async () => {
    const s = usdSender();
    await F.claimFaucet(ALICE, { client: c(), sender: s });
    await F.claimFaucet(ALICE, { client: c(), sender: s, asset: 'TUSD' });
    assert.equal(s.sends.length, 1);
    assert.equal(s.tokenSends.length, 1);
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s, asset: 'TUSD' }), { message: F.FAUCET_COOLDOWN });
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s }), { message: F.FAUCET_COOLDOWN });
    process.env.FAUCET_PRIVATE_KEY = '0x' + '11'.repeat(32);
    try {
      const usd = await F.faucetStatus(ALICE, c(), Date.now(), 'TUSD');
      assert.equal(usd.unit, 'tUSD');
      assert.equal(usd.cooldownHours, 24);
      assert.ok(usd.nextClaimAt);
      const eth = await F.faucetStatus(ALICE, c());
      assert.equal(eth.unit, 'ETH');
      assert.equal(eth.cooldownHours, 72);
      assert.ok(eth.nextClaimAt);
    } finally {
      delete process.env.FAUCET_PRIVATE_KEY;
    }
  });

  it('counts an old claim with no asset as ETH, never against tUSD', async () => {
    claims().push({ id: 'legacy', account_id: ALICE, to_address: WALLET, amount_wei: '1', status: 'confirmed', tx_hash: HASH(9), created_at: new Date().toISOString() });
    const s = usdSender();
    await F.claimFaucet(ALICE, { client: c(), sender: s, asset: 'TUSD' });
    assert.equal(s.tokenSends.length, 1);
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s }), { message: F.FAUCET_COOLDOWN });
  });

  it('frees it, and sends nothing, when the dispenser holds less than one claim', async () => {
    const s = usdSender({ held: TUSD_UNITS - 1n });
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s, asset: 'TUSD' }), { message: F.FAUCET_EMPTY });
    assert.equal(s.tokenSends.length, 0);
    assert.equal(claims()[0].status, 'failed');
  });

  it('frees it, and sends nothing, when the dispenser has no ETH for the gas', async () => {
    const s = usdSender({ eth: 0n });
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s, asset: 'TUSD' }), { message: F.FAUCET_EMPTY });
    assert.equal(s.tokenSends.length, 0);
  });

  it('names tUSD when the send fails, and frees the claim', async () => {
    const s = usdSender({ sendError: new Error('boom') });
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c(), sender: s, asset: 'TUSD' }), { message: F.FAUCET_SEND_FAILED_TUSD });
    assert.equal(claims()[0].status, 'failed');
  });

  it('reads a database without the asset column as ETH only', async () => {
    const client = {
      ...c(),
      from(table) {
        const query = c().from(table);
        if (table !== 'faucet_claims') return query;
        const select = query.select.bind(query);
        query.select = (cols) => (/\basset\b/.test(cols) ? { eq: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'column faucet_claims.asset does not exist' } }) }) }) }) } : select(cols));
        return query;
      },
    };
    process.env.FAUCET_PRIVATE_KEY = '0x' + '11'.repeat(32);
    try {
      const eth = await F.faucetStatus(ALICE, client);
      assert.equal(eth.nextClaimAt, null);
      const usd = await F.faucetStatus(ALICE, client, Date.now(), 'TUSD');
      assert.equal(usd.nextClaimAt, null);
    } finally {
      delete process.env.FAUCET_PRIVATE_KEY;
    }
  });
});

describe('the dispenser key', () => {
  const saved = {};
  beforeEach(() => {
    saved.key = process.env.FAUCET_PRIVATE_KEY;
    saved.chain = process.env.GIWA_CHAIN_ID;
  });
  afterEach(() => {
    if (saved.key === undefined) delete process.env.FAUCET_PRIVATE_KEY;
    else process.env.FAUCET_PRIVATE_KEY = saved.key;
    if (saved.chain === undefined) delete process.env.GIWA_CHAIN_ID;
    else process.env.GIWA_CHAIN_ID = saved.chain;
  });

  it('is required, and a placeholder does not count', async () => {
    delete process.env.FAUCET_PRIVATE_KEY;
    assert.equal(F.faucetConfigured(), false);
    assert.throws(() => F.getFaucetSender(), { message: F.FAUCET_NOT_SET_UP });
    process.env.FAUCET_PRIVATE_KEY = '0xyour_faucet_only_private_key';
    assert.equal(F.faucetConfigured(), false);
    seed();
    await assert.rejects(() => F.claimFaucet(ALICE, { client: c() }), { message: F.FAUCET_NOT_SET_UP });
    assert.equal(claims().length, 0);
  });

  it('never falls back to the ops key', () => {
    delete process.env.FAUCET_PRIVATE_KEY;
    const ops = process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY = '0x' + '22'.repeat(32);
    try {
      assert.equal(F.faucetConfigured(), false);
    } finally {
      if (ops === undefined) delete process.env.PRIVATE_KEY;
      else process.env.PRIVATE_KEY = ops;
    }
  });

  it('refuses to run anywhere but GIWA Sepolia', () => {
    process.env.FAUCET_PRIVATE_KEY = '0x' + '11'.repeat(32);
    process.env.GIWA_CHAIN_ID = '1';
    assert.throws(() => F.getFaucetSender(), /only runs on GIWA Sepolia/);
  });
});

describe('faucet source', () => {
  const ROOT = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('reads only its own key, and never exposes it to the browser', () => {
    const lib = read('web/lib/faucet.ts');
    assert.doesNotMatch(lib, /process\.env\.PRIVATE_KEY/);
    assert.match(lib, /process\.env\.FAUCET_PRIVATE_KEY/);
    for (const rel of ['web/components/FaucetPanel.tsx', 'web/app/api/faucet/route.ts', 'web/app/api/faucet/claim/route.ts']) {
      assert.doesNotMatch(read(rel), /FAUCET_PRIVATE_KEY|NEXT_PUBLIC_FAUCET/, rel);
    }
    assert.doesNotMatch(read('.env.example'), /NEXT_PUBLIC_FAUCET/);
  });

  it('claims only same-site, signed in, with nothing taken from the request body', () => {
    const route = read('web/app/api/faucet/claim/route.ts');
    assert.match(route, /rejectIfCrossOrigin\(req\)/);
    assert.match(route, /getAccountIdFromCookie\(\)/);
    assert.doesNotMatch(route, /req\.json\(|req\.text\(|req\.formData\(/);
    // The query names an asset and nothing else; normalizeFaucetAsset allows two.
    assert.match(route, /const asset = normalizeFaucetAsset\(new URL\(req\.url\)\.searchParams\.get\('asset'\)\);/);
    assert.match(route, /claimFaucet\(accountId, \{ asset \}\)/);
  });

  it('keeps the asset column and the per-asset reservation away from anon and authenticated', () => {
    const sql = read('supabase/migrations/20261021120000_faucet_test_usd.sql');
    assert.match(sql, /check \(asset in \('ETH', 'TUSD'\)\)/);
    assert.match(sql, /revoke all on function public\.try_faucet_claim\(uuid, text, numeric, integer, text\) from anon, authenticated;/);
    assert.match(sql, /revoke all on function public\.try_faucet_claim\(uuid, text, numeric, integer\) from anon, authenticated;/);
    assert.match(sql, /and c\.asset = p_asset/);
    assert.match(sql, /raise exception 'faucet_claims\.asset is missing'/);
  });

  it('keeps the claim functions and tables away from anon and authenticated', () => {
    const sql = read('supabase/migrations/20261010120000_faucet_claims.sql');
    assert.match(sql, /revoke all on table public\.faucet_claims from anon, authenticated;/);
    assert.match(sql, /revoke all on function public\.try_faucet_claim\(uuid, text, numeric, integer\) from anon, authenticated;/);
    assert.match(sql, /revoke all on function public\.try_faucet_signer_lock\(uuid\) from anon, authenticated;/);
    assert.match(sql, /pg_advisory_xact_lock\(hashtext\('flizy\.faucet:'/);
    assert.match(sql, /raise exception 'public\.faucet_claims is missing'/);
  });
});
