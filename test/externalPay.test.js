/**
 * Paying a Flizy account from a wallet outside Flizy.
 *
 * The server believes the chain, not the browser. What is pinned here: only a
 * PaymentReceived event from FlizyPaymentReceiver, to this account's wallet, in
 * a pay-list asset, in a successful transaction, counts; each event is
 * recorded once however often it is confirmed; a note is kept only when it
 * hashes to the invoice id the payer put on chain; and the receiver address
 * the app uses is the one that was deployed.
 *
 * Run: node --test test/externalPay.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const WEB_LIB = pathToFileURL(path.join(ROOT, 'web', 'lib') + path.sep).href;
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

let X;
let P;
let I;
before(async () => {
  X = await import('../web/lib/externalPay.ts');
  P = await import('../web/lib/paymentReceiver.ts');
  I = await import('../web/lib/invoiceId.ts');
});

const RECEIVER = '0x12197866DdD74b0F37D2127AC5e2E69dFF6d6FF1';
const PAYEE = '0x' + 'cd'.repeat(20);
const PAYER = '0x' + 'ab'.repeat(20);
const TUSD = '0x4F28C18600c312Bfa8e8281D882e0EC306F82446';
const TX = '0x' + '12'.repeat(32);
const iface = new ethers.Interface([
  'event PaymentReceived(bytes32 indexed invoiceId, address indexed payer, address indexed payee, address token, uint256 amount)',
]);

function log({ address = RECEIVER, invoice = ethers.ZeroHash, payee = PAYEE, token = TUSD, units = 50_000_000n, index = 0 } = {}) {
  const enc = iface.encodeEventLog('PaymentReceived', [invoice, PAYER, payee, token, units]);
  return { address, topics: enc.topics, data: enc.data, index };
}

describe('which events count', () => {
  it('reads a tUSD payment to this wallet as 50 tUSD', () => {
    const [p] = X.paymentsInReceipt({ status: 1, logs: [log()] }, PAYEE);
    assert.equal(p.asset, 'TUSD');
    assert.equal(p.amount, '50.0');
    assert.equal(p.units, 50_000_000n);
    assert.equal(p.payer, PAYER);
  });

  it('reads native ETH as ETH', () => {
    const [p] = X.paymentsInReceipt({ status: 1, logs: [log({ token: ethers.ZeroAddress, units: 10n ** 16n })] }, PAYEE);
    assert.equal(p.asset, 'ETH');
    assert.equal(p.amount, '0.01');
  });

  it('ignores the same event from any other contract', () => {
    assert.deepEqual(X.paymentsInReceipt({ status: 1, logs: [log({ address: '0x' + '99'.repeat(20) })] }, PAYEE), []);
  });

  it('ignores a payment to anyone else, and a token off the pay list', () => {
    assert.deepEqual(X.paymentsInReceipt({ status: 1, logs: [log({ payee: '0x' + '77'.repeat(20) })] }, PAYEE), []);
    assert.deepEqual(X.paymentsInReceipt({ status: 1, logs: [log({ token: '0x8CA7A8F78abC8dA471df82BE4F374e1661e34473' })] }, PAYEE), []);
  });

  it('refuses a failed transaction outright', () => {
    assert.throws(() => X.paymentsInReceipt({ status: 0, logs: [log()] }, PAYEE), { message: X.EXTERNAL_TX_FAILED });
  });

  it('matches the payee in any letter case', () => {
    assert.equal(X.paymentsInReceipt({ status: 1, logs: [log()] }, ethers.getAddress(PAYEE)).length, 1);
  });
});

describe('recording', () => {
  let fake;
  beforeEach(() => {
    fake = createFakeSupabase({ external_payments: [], transfers: [], external_pay_attempts: [] });
  });

  it('records a payment once, however often it is confirmed', async () => {
    const payments = X.paymentsInReceipt({ status: 1, logs: [log()] }, PAYEE);
    const first = await X.recordExternalPayments(fake.client, { txHash: TX, payeeAccountId: 'acc-p', payments });
    const again = await X.recordExternalPayments(fake.client, { txHash: TX, payeeAccountId: 'acc-p', payments });
    assert.equal(first.length, 1);
    assert.equal(again.length, 0, 'nothing new, so nobody is notified twice');
    assert.equal(fake.db.tables.external_payments.length, 1);
    assert.equal(fake.db.tables.transfers.length, 1);
    const t = fake.db.tables.transfers[0];
    assert.equal(t.account_id, null);
    assert.equal(t.phone, 'external');
    assert.equal(t.status, 'confirmed');
    assert.equal(t.asset, 'TUSD');
    assert.equal(t.to_address, ethers.getAddress(PAYEE));
  });

  it('caps confirm calls per caller per hour', async () => {
    for (let i = 0; i < X.EXTERNAL_CONFIRMS_PER_HOUR; i += 1) {
      assert.equal(await X.takeExternalAttempt(fake.client, 'k'.repeat(64)), true);
    }
    assert.equal(await X.takeExternalAttempt(fake.client, 'k'.repeat(64)), false);
    assert.equal(await X.takeExternalAttempt(fake.client, 'j'.repeat(64)), true, 'another caller is not affected');
  });
});

describe('the note a payer puts on chain', () => {
  it('binds the note to the payment through the invoice id', () => {
    const nonce = '0x' + '5a'.repeat(16);
    const id = I.invoiceIdFor('design work', nonce);
    assert.match(id, /^0x[0-9a-f]{64}$/);
    assert.notEqual(I.invoiceIdFor('refund for scam', nonce), id);
    assert.notEqual(I.invoiceIdFor('design work', '0x' + '5b'.repeat(16)), id);
    assert.equal(I.invoiceIdFor('design work', nonce), id);
  });

  it('is kept by the route only when it hashes to every paid invoice id', () => {
    const route = fs.readFileSync(path.join(ROOT, 'web/app/api/pay/external/route.ts'), 'utf8');
    assert.match(route, /payments\.every\(\(p\) => p\.invoiceId === invoiceIdFor\(note, nonce\)\)/);
    assert.match(route, /note: noteHolds \? note : null/);
    assert.match(route, /takeExternalAttempt\(supabase, clientIpKey\(req\.headers\)\)/);
  });
});

describe('who can be paid from an outside wallet', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('only an account that turned it on: the address is not handed out otherwise', () => {
    const route = read('web/app/api/pay/external/route.ts');
    assert.match(route, /if \(data\?\.accept_outside_pay !== true\) \{\s*return NextResponse\.json\(\{ error: OUTSIDE_PAY_OFF \}, \{ status: 403 \}\);/);
    assert.ok(route.indexOf('accept_outside_pay !== true') < route.indexOf('payee: ethers.getAddress(to)'));
    const sql = read('supabase/migrations/20261021150000_external_payments.sql');
    assert.match(sql, /add column if not exists accept_outside_pay boolean not null default false/);
  });

  it('the pay page offers it only then, and the switch is same-site and signed in', () => {
    for (const rel of ['web/app/pay/[code]/page.tsx', 'web/app/pay/c/[code]/page.tsx']) {
      assert.match(read(rel), /outsidePay = data\?\.accept_outside_pay === true;/, rel);
    }
    assert.match(read('web/components/PayLanding.tsx'), /loggedIn === false && outsidePay \? \(\s*<ExternalPay/);
    const toggle = read('web/app/api/account/outside-pay/route.ts');
    assert.match(toggle, /rejectIfCrossOrigin\(req\)/);
    assert.match(toggle, /typeof body\?\.enabled !== 'boolean'/);
  });
});

describe('the receiver address', () => {
  it('keeps viem out of the pay page until a payment starts', () => {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'web/lib/paymentReceiver.ts'), 'utf8'), /from 'viem'/);
    const comp = fs.readFileSync(path.join(ROOT, 'web/components/ExternalPay.tsx'), 'utf8');
    // A type-only import is erased at build; any other would put viem in the page bundle.
    assert.doesNotMatch(comp, /^import (?!type )[^;]* from 'viem';/m);
    // The shared chain helper loads viem only inside its functions.
    const chain = fs.readFileSync(path.join(ROOT, 'web/lib/walletChain.ts'), 'utf8');
    assert.doesNotMatch(chain, /^import (?!type )[^;]* from 'viem';/m);
    assert.match(chain, /await import\('viem'\)/);
  });

  it('is the one deployed and verified', () => {
    const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployments/giwa-sepolia.json'), 'utf8'));
    assert.equal(P.PAYMENT_RECEIVER, dep.paymentReceiver.address);
    assert.equal(dep.paymentReceiver.verified, true);
    assert.equal(P.PAYMENT_RECEIVER_CHAIN.hexId, `0x${P.PAYMENT_RECEIVER_CHAIN.id.toString(16)}`);
  });
});

describe('dust', () => {
  it('is recorded but never announced to the payee', () => {
    const route = fs.readFileSync(path.join(ROOT, 'web/app/api/pay/external/route.ts'), 'utf8');
    assert.match(route, /if \(Number\(pay\.amount\) < \(pay\.asset === 'ETH' \? 0\.0001 : 0\.01\)\) continue;/);
    assert.ok(route.indexOf('recordExternalPayments(') < route.indexOf("pay.asset === 'ETH' ? 0.0001"));
  });
});
