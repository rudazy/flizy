/**
 * Outside-wallet pay page payments recorded by the VPS payment watcher
 * (lib/api/paymentWatcher.js, recordPayPageLog), so a payer who closes the
 * page loses nothing.
 *
 * Covers: a payment is recorded once, with its transfers row, and the payee is
 * told once; an account that does not take outside payments, a wallet that is
 * no account and a token off the pay list are skipped; dust is recorded but
 * not announced; a checkout's log still goes to the API path; and the page's
 * late confirm adds its verified note to what the watcher recorded
 * (web/lib/externalPay.ts).
 *
 * Run: node --test test/payPageWatcher.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const PW = require('../lib/api/paymentWatcher');

const WEB_LIB = pathToFileURL(path.join(__dirname, '..', 'web', 'lib') + path.sep).href;
// Next resolves extensionless relative imports inside web/lib; plain node does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || '';
    if (parent.startsWith(WEB_LIB) && specifier.startsWith('.') && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, parent);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const IFACE = new ethers.Interface(['event PaymentReceived(bytes32 indexed invoiceId, address indexed payer, address indexed payee, address token, uint256 amount)']);
const PAYEE = ethers.getAddress('0x' + 'ab'.repeat(20));
const CLOSED = ethers.getAddress('0x' + 'bc'.repeat(20));
const PAYER = '0x' + 'cd'.repeat(20);
const INVOICE = '0x' + '44'.repeat(32);
const TX = '0x' + 'aa'.repeat(32);
const chain = { id: 'giwa_sepolia', chainId: 91342 };

function receiverLog({ payee = PAYEE, token = ethers.ZeroAddress, units = 10n ** 16n, index = 0, block = 100, invoiceId = INVOICE } = {}) {
  const enc = IFACE.encodeEventLog('PaymentReceived', [invoiceId, PAYER, payee, token, units]);
  return { address: PW.RECEIVER, topics: enc.topics, data: enc.data, index, blockNumber: block, transactionHash: TX };
}

let fake;
let notices;
const seed = () => {
  notices = [];
  fake = createFakeSupabase({
    // The payee's address is stored checksummed; the watcher matches it in any case.
    accounts: [
      { id: 'acc-open', agent_wallet_address: PAYEE, accept_outside_pay: true },
      { id: 'acc-closed', agent_wallet_address: CLOSED, accept_outside_pay: false },
    ],
    external_payments: [],
    transfers: [],
    account_notices: [],
    api_transactions: [],
    api_platforms: [],
    api_payment_cursor: [{ id: true, last_block: 99 }],
  });
};
const watcher = () =>
  PW.makePaymentWatcher({
    supabase: fake.client,
    provider: { getBlockNumber: async () => 101, getLogs: async () => logs },
    chain,
    log: { warn() {}, info() {} },
    notify: async (accountId, body) => notices.push({ accountId, body }),
  });
let logs = [];

describe('the watcher records pay page payments', () => {
  beforeEach(seed);

  it('once, with a transfers row, and the payee told once', async () => {
    const w = watcher();
    assert.equal(await w.recordPayPageLog(receiverLog()), 'recorded');
    assert.equal(await w.recordPayPageLog(receiverLog()), 'duplicate');
    const ext = fake.db.tables.external_payments;
    assert.equal(ext.length, 1);
    assert.deepEqual(
      [ext[0].tx_hash, ext[0].log_index, ext[0].payee_account_id, ext[0].asset, ext[0].amount, ext[0].note],
      [TX, 0, 'acc-open', 'ETH', '0.01', null]
    );
    const t = fake.db.tables.transfers;
    assert.equal(t.length, 1);
    assert.deepEqual([t[0].account_id, t[0].phone, t[0].status, t[0].to_address, t[0].amount_eth], [null, 'external', 'confirmed', PAYEE, '0.01']);
    assert.equal(ext[0].transfer_id, t[0].id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].accountId, 'acc-open');
    assert.match(notices[0].body, /^You received 0\.01 ETH from an outside wallet \(0xcdcd\.\.\.cdcd\)\./);
    const n = fake.db.tables.account_notices;
    assert.equal(n.length, 1);
    assert.equal(n[0].dedupe_key, `in:${TX}:payment-0:eth`);
  });

  it('skips an account that takes no outside payments, a wallet that is no account, and a token off the list', async () => {
    const w = watcher();
    assert.equal(await w.recordPayPageLog(receiverLog({ payee: CLOSED })), 'skip');
    assert.equal(await w.recordPayPageLog(receiverLog({ payee: '0x' + 'ee'.repeat(20) })), 'skip');
    assert.equal(await w.recordPayPageLog(receiverLog({ token: '0x' + '99'.repeat(20) })), 'skip');
    assert.equal(fake.db.tables.external_payments.length, 0);
    assert.equal(fake.db.tables.transfers.length, 0);
    assert.equal(notices.length, 0);
  });

  it('dust is recorded but not announced', async () => {
    assert.equal(await watcher().recordPayPageLog(receiverLog({ units: 10n ** 13n })), 'recorded');
    assert.equal(fake.db.tables.external_payments.length, 1);
    assert.equal(notices.length, 0);
    assert.equal(fake.db.tables.account_notices.length, 0);
  });

  it('keeps to the site\'s hourly cap on payment notices', async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 30; i += 1) fake.db.tables.account_notices.push({ id: `n${i}`, account_id: 'acc-open', dedupe_key: `in:x${i}`, created_at: now });
    assert.equal(await watcher().recordPayPageLog(receiverLog()), 'recorded');
    assert.equal(fake.db.tables.account_notices.length, 30, 'no 31st notice this hour');
    assert.equal(fake.db.tables.external_payments.length, 1, 'the payment itself is still recorded');
  });

  it('a scan sends a log that is no checkout to the pay page path, and moves the cursor', async () => {
    logs = [receiverLog({ block: 100 })];
    assert.equal(await watcher().scanOnce(), true);
    assert.equal(fake.db.tables.external_payments.length, 1);
    assert.equal(fake.db.tables.api_payment_cursor[0].last_block, 100);
  });
});

describe('the page reports late', () => {
  let X;
  before(async () => {
    X = await import('../web/lib/externalPay.ts');
  });
  beforeEach(seed);

  it('adds its note to a payment the watcher recorded, once, and records nothing new', async () => {
    await watcher().recordPayPageLog(receiverLog());
    const payments = X.paymentsInReceipt({ status: 1, logs: [receiverLog()] }, PAYEE);
    const recorded = await X.recordExternalPayments(fake.client, { txHash: TX, payeeAccountId: 'acc-open', payments, note: 'coffee' });
    assert.equal(recorded.length, 0, 'nothing new, so the payee is not told twice');
    assert.equal(fake.db.tables.external_payments.length, 1);
    assert.equal(fake.db.tables.external_payments[0].note, 'coffee');
    assert.equal(fake.db.tables.transfers[0].note, 'coffee');
    // A note already set is never replaced.
    await X.recordExternalPayments(fake.client, { txHash: TX, payeeAccountId: 'acc-open', payments, note: 'something else' });
    assert.equal(fake.db.tables.external_payments[0].note, 'coffee');
  });
});
