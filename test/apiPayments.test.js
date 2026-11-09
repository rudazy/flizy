/**
 * Flizy Pay API, phase 3a: checkouts paid from any wallet.
 *
 * What is pinned:
 * - a payment request is validated strictly; a checkout gets a fresh 32-byte
 *   invoice id; its view never says completed before it settles;
 * - a return link is accepted only on an origin the platform registered, and
 *   look-alike hosts, user-info tricks, plain http and other subdomains fail;
 *   a platform holds at most MAX_ORIGINS sites, even with two adds at once;
 * - a reported receipt counts only for this checkout's invoice id, wallet and
 *   asset, from FlizyPaymentReceiver;
 * - the VPS watcher records only matching logs, starts sensibly on its first
 *   run, keeps its place when a record fails (the stretch is read again),
 *   expires open checkouts and never one that settled in between;
 * - the checkout page shows nothing of the platform's reference or metadata.
 * The database function's outcomes (partial, settled, overpaid, late, extra,
 * duplicate) are proven against Postgres in the dev smoke check.
 *
 * Run: node --test test/apiPayments.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const PW = require('../lib/api/paymentWatcher');
const { resolveListedSendAsset } = require('../lib/dex');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const IFACE = new ethers.Interface(['event PaymentReceived(bytes32 indexed invoiceId, address indexed payer, address indexed payee, address token, uint256 amount)']);
const WALLET = '0x' + 'ab'.repeat(20);
const PAYER = '0x' + 'cd'.repeat(20);
const INVOICE = '0x' + '11'.repeat(32);

let PM;
before(async () => {
  PM = await import('../web/lib/apiPayments.ts');
});

/** A PaymentReceived log as a provider returns it. */
function receiverLog({ invoiceId = INVOICE, payee = WALLET, token = ethers.ZeroAddress, units = 10n ** 16n, address = PW.RECEIVER, index = 0, block = 100, hash = '0x' + 'aa'.repeat(32) } = {}) {
  const enc = IFACE.encodeEventLog('PaymentReceived', [invoiceId, PAYER, payee, token, units]);
  return { address, topics: enc.topics, data: enc.data, index, blockNumber: block, transactionHash: hash };
}

describe('payment requests', () => {
  it('take an amount in the asset, an expiry within bounds, and nothing unknown', () => {
    const p = PM.parsePaymentRequest({ amount: '25', asset: 'tUSD', reference: 'order-1' });
    assert.deepEqual([p.symbol, p.amount, p.expiresInMinutes, p.returnUrl], ['TUSD', 25n * 10n ** 6n, 60, null]);
    assert.equal(PM.parsePaymentRequest({ amount: '1', asset: 'ETH', expires_in_minutes: 5 }).expiresInMinutes, 5);
    for (const m of [4, 10081, 1.5, '60']) assert.throws(() => PM.parsePaymentRequest({ amount: '1', asset: 'ETH', expires_in_minutes: m }), (e) => e.code === 'invalid_expiry', String(m));
    assert.throws(() => PM.parsePaymentRequest({ amount: '1', asset: 'ETH', recipient: {} }), /Unknown field/);
    assert.throws(() => PM.parsePaymentRequest({ amount: '0', asset: 'ETH' }), (e) => e.code === 'invalid_amount');
  });

  it('get a fresh 32-byte invoice id each', () => {
    const a = PM.newInvoiceId();
    assert.match(a, /^0x[0-9a-f]{64}$/);
    assert.notEqual(PM.newInvoiceId(), a);
  });

  it('show not completed until confirmed, with what arrived and the checkout link', () => {
    const base = { id: 'p1', amount: '25000000', asset: 'TUSD', reference: null, metadata: null, received_units: '10000000', overpaid: false, expires_at: '', return_url: null, tx_hash: null, settled_at: null, created_at: '', updated_at: '' };
    const open = PM.paymentView({ ...base, state: 'accepted' }, 'https://flizy.app/');
    assert.deepEqual([open.completed, open.amount, open.received, open.checkout_url], [false, '25', '10', 'https://flizy.app/checkout/p1']);
    assert.equal(PM.paymentView({ ...base, state: 'confirmed', overpaid: true }, 'https://flizy.app').completed, true);
  });
});

describe('return links', () => {
  const origins = ['https://shop.example.com'];
  it('only on a registered origin; look-alikes and tricks fail', () => {
    assert.equal(PM.allowedReturnUrl('https://shop.example.com/thanks?o=1', origins), 'https://shop.example.com/thanks?o=1');
    for (const u of [
      'https://shop.example.com.evil.com/x',
      'https://shop.example.com@evil.com/x',
      'https://evil.com/?https://shop.example.com',
      'http://shop.example.com/x',
      'https://www.shop.example.com/x',
      'https://shop.example.com:8443/x',
      'javascript:alert(1)',
      '//shop.example.com/x',
    ]) {
      assert.equal(PM.allowedReturnUrl(u, origins), null, u);
    }
  });

  it('a site registers as https and a host name only', () => {
    assert.equal(PM.cleanOrigin('https://Shop.Example.com/'), 'https://shop.example.com');
    for (const o of ['http://shop.example.com', 'https://shop.example.com/path', 'https://1.2.3.4', 'https://localhost', 'https://shop.example.com:444', 'https://shop', 'https://u:p@shop.example.com', 'https://shop.example.com/?q=1']) {
      assert.equal(PM.cleanOrigin(o), null, o);
    }
  });

  it('at most MAX_ORIGINS, even with two adds at once; remove only the platform\'s own', async () => {
    const fake = createFakeSupabase({ api_platform_origins: [] });
    for (let i = 0; i < PM.MAX_ORIGINS - 1; i += 1) await PM.addOrigin(fake.client, 'plat-1', `https://s${i}.example.com`);
    await Promise.allSettled([1, 2].map((n) => PM.addOrigin(fake.client, 'plat-1', `https://race${n}.example.com`)));
    assert.ok(fake.db.tables.api_platform_origins.length <= PM.MAX_ORIGINS);
    fake.db.tables.api_platform_origins.push({ platform_id: 'other', origin: 'https://theirs.example.com' });
    assert.equal(await PM.removeOrigin(fake.client, 'plat-1', 'https://theirs.example.com'), false);
    assert.equal(fake.db.tables.api_platform_origins.some((o) => o.origin === 'https://theirs.example.com'), true);
  });
});

describe('a reported receipt', () => {
  it('counts only this checkout\'s invoice id and asset (the receiver and wallet are checked by paymentsInReceipt)', () => {
    const pays = [
      { invoiceId: INVOICE.toUpperCase().replace('0X', '0x'), asset: 'ETH', logIndex: 0 },
      { invoiceId: '0x' + '22'.repeat(32), asset: 'ETH', logIndex: 1 },
      { invoiceId: INVOICE, asset: 'TUSD', logIndex: 2 },
    ];
    assert.deepEqual(PM.matchCheckoutPayments(pays, { invoiceId: INVOICE, asset: 'ETH' }).map((p) => p.logIndex), [0]);
    assert.match(read('web/lib/checkout.ts'), /matchCheckoutPayments\(paymentsInReceipt\(receipt, view\.payee\), view\)/);
  });
});

describe('the payment watcher', () => {
  let fake;
  let calls;
  let head;
  let logs;
  let failRecord;
  const chain = { id: 'giwa_sepolia', chainId: 91342 };
  const provider = {
    getBlockNumber: async () => head,
    getLogs: async (f) => {
      calls.getLogs.push(f);
      return logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock);
    },
  };
  beforeEach(() => {
    calls = { getLogs: [], record: [], transition: [] };
    head = 10_001;
    logs = [];
    failRecord = false;
    fake = createFakeSupabase({
      api_payment_cursor: [{ id: true, last_block: 9_000 }],
      api_transactions: [{ id: 'pay-1', kind: 'payment', platform_id: 'plat-1', asset: 'ETH', invoice_id: INVOICE, state: 'accepted', expires_at: new Date(Date.now() + 3600e3).toISOString() }],
      api_platforms: [{ id: 'plat-1', account_id: 'acc-1', wallet_address: WALLET }],
    });
  });
  const watcher = () =>
    PW.makePaymentWatcher({
      supabase: {
        from: (t) => fake.client.from(t),
        async rpc(name, args) {
          if (name === 'api_record_payment') {
            calls.record.push(args);
            return failRecord ? { data: null, error: { message: 'db down' } } : { data: 'confirmed', error: null };
          }
          if (name === 'api_transition') {
            calls.transition.push(args);
            const row = fake.db.tables.api_transactions.find((r) => r.id === args.p_transaction_id);
            if (row.state !== 'accepted') return { data: null, error: { message: 'not allowed' } };
            row.state = args.p_to_state;
            return { data: 'evt', error: null };
          }
          return fake.client.rpc(name, args);
        },
      },
      provider,
      chain,
      log: { warn() {}, info() {} },
    });

  it('records a matching log once, with the platform\'s account, and moves the cursor', async () => {
    logs = [receiverLog({ block: 9_500 }), receiverLog({ block: 9_600, invoiceId: '0x' + '33'.repeat(32), index: 1 }), receiverLog({ block: 9_700, payee: '0x' + 'ee'.repeat(20), index: 2 })];
    assert.equal(await watcher().scanOnce(), true);
    assert.equal(calls.record.length, 1, 'only the one for this checkout and wallet');
    const r = calls.record[0];
    assert.deepEqual([r.p_transaction_id, r.p_payee_account_id, r.p_asset, r.p_units, r.p_amount_text, r.p_token_address], ['pay-1', 'acc-1', 'ETH', String(10n ** 16n), '0.01', null]);
    assert.equal(calls.getLogs[0].address, PW.RECEIVER);
    assert.deepEqual(calls.getLogs[0].topics, [PW.TOPIC]);
    assert.equal(calls.getLogs[0].toBlock, head - 1, 'one block behind the head');
    assert.equal(fake.db.tables.api_payment_cursor[0].last_block, head - 1);
  });

  it('a token payment must be the checkout\'s own token', async () => {
    fake.db.tables.api_transactions[0].asset = 'TUSD';
    const tusd = resolveListedSendAsset('TUSD', 'giwa_sepolia').tokenAddress;
    logs = [receiverLog({ block: 9_500 }), receiverLog({ block: 9_501, token: tusd, units: 5n * 10n ** 6n, index: 1 })];
    await watcher().scanOnce();
    assert.equal(calls.record.length, 1, 'ETH sent to a tUSD checkout does not count');
    assert.deepEqual([calls.record[0].p_asset, calls.record[0].p_amount_text, calls.record[0].p_token_address], ['TUSD', '5.0', tusd.toLowerCase()]);
  });

  it('reads in stretches of 2000 blocks, and on a first run starts 2000 behind the head', async () => {
    fake.db.tables.api_payment_cursor[0].last_block = null;
    head = 50_001;
    await watcher().scanOnce();
    assert.deepEqual([calls.getLogs[0].fromBlock, calls.getLogs[0].toBlock], [48_001, 50_000]);
    fake.db.tables.api_payment_cursor[0].last_block = 1_000;
    calls.getLogs = [];
    assert.equal(await watcher().scanOnce(), false, 'not caught up yet');
    assert.deepEqual([calls.getLogs[0].fromBlock, calls.getLogs[0].toBlock], [1_001, 3_000]);
  });

  it('a record that fails keeps the cursor where it was, so the stretch is read again', async () => {
    logs = [receiverLog({ block: 9_500 })];
    failRecord = true;
    await assert.rejects(watcher().scanOnce(), /db down/);
    assert.equal(fake.db.tables.api_payment_cursor[0].last_block, 9_000);
  });

  it('expires an open checkout past its time, and never one that settled meanwhile', async () => {
    fake.db.tables.api_transactions[0].expires_at = new Date(Date.now() - 1000).toISOString();
    fake.db.tables.api_transactions.push({ id: 'pay-2', kind: 'payment', state: 'confirmed', expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(await watcher().expire(), 1);
    assert.deepEqual(calls.transition.map((t) => [t.p_transaction_id, t.p_to_state]), [['pay-1', 'expired']]);
  });
});

describe('the checkout page and its routes', () => {
  it('the page shows nothing of the platform\'s reference or metadata', () => {
    const lib = read('web/lib/checkout.ts');
    const select = /\.select\('([^']+)'\)\s*\.eq\('id', id\)\s*\.eq\('kind', 'payment'\)/.exec(lib);
    assert.ok(select, 'the loader select');
    assert.doesNotMatch(select[1], /reference|metadata/);
    assert.doesNotMatch(read('web/app/checkout/[id]/page.tsx'), /reference|metadata/);
  });

  it('a platform Flizy paused takes no new payment on its checkout page', () => {
    assert.match(read('web/lib/checkout.ts'), /platformEnabled: platform\.enabled === true/);
    const page = read('web/app/checkout/[id]/page.tsx');
    assert.match(page, /const payable = open && view\.platformEnabled;/);
    assert.match(page, /\) : payable \? \(\s*<ExternalWalletProvider>/);
  });

  it('the report route takes no session, is capped per caller, and believes only the receipt', () => {
    const src = read('web/app/api/checkout/[id]/route.ts');
    assert.match(src, /rejectIfCrossOrigin\(req\)/);
    assert.match(src, /takeExternalAttempt\(db, clientIpKey\(req\.headers\)\)/);
    assert.match(src, /checkoutPaymentsIn\(receipt, view\)/);
    assert.doesNotMatch(src, /getAccountIdFromCookie/);
  });

  it('creating a payment needs collect, an Idempotency-Key, and a registered return origin', () => {
    const src = read('web/app/api/v1/payments/route.ts');
    assert.match(src, /authenticateApiRequest\(req, db, 'collect'\)/);
    assert.match(src, /idempotency_key_required/);
    assert.match(src, /allowedReturnUrl\(parsed\.returnUrl, /);
    assert.match(src, /invoice_id: newInvoiceId\(\)/);
  });

  it('the database records a payment once and settles it only through the state machine', () => {
    const SQL = read('supabase/migrations/20261110120000_api_payments.sql');
    assert.match(SQL, /constraint api_payment_receipts_once unique \(tx_hash, log_index\)/);
    assert.match(SQL, /on conflict \(tx_hash, log_index\) do nothing\s+returning id into receipt_id;\s+if receipt_id is null then\s+return 'duplicate';/);
    assert.match(SQL, /perform public\.api_transition\(tx\.id, 'submitted'/);
    assert.match(SQL, /perform public\.api_transition\(tx\.id, 'confirmed'/);
    assert.match(SQL, /for update;/);
  });
});
