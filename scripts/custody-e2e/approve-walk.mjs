/**
 * Approves an over-cap payment in Chrome, end to end, on the dev database and
 * the local GIWA fork. Runs after walk.mjs, which made the passkey.
 *
 *   1. Opens an approval for 0.2 ETH (lib/custody/approvals.js, as chat would).
 *   2. Loads the walk's passkey into a new virtual authenticator, opens
 *      /approve/{token}, checks the page shows the stored recipient, address
 *      and amount, and clicks Approve with passkey.
 *   3. Runs the approval worker with this run's relayer: the payment is sent,
 *      the page shows Sent, and redeeming the same permission again is refused
 *      on chain.
 *   4. Opens a second approval and cancels it on the page: the worker sends
 *      nothing.
 *   5. Opens that page with no session: it asks for a login and shows nothing.
 *
 * Needs the dev server on http://localhost:3100 started with pin-env.cjs, the
 * anvil fork, and E2E_CHROME (see README.md). Fork and dev database only.
 *
 * Run: node scripts/custody-e2e/approve-walk.mjs
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const rootRequire = createRequire(path.join(ROOT, 'package.json'));
const webRequire = createRequire(path.join(ROOT, 'web', 'package.json'));
const { ethers } = rootRequire('ethers');
const puppeteer = rootRequire('puppeteer');
const A = rootRequire('./lib/custody/approvals');
const R = rootRequire('./lib/custody/redeem');
const C = rootRequire('./lib/custody/delegations');

const BASE = 'http://localhost:3100';
const RPC = process.env.FORK_RPC || 'http://127.0.0.1:8546';
const CHROME = process.env.E2E_CHROME;
if (!CHROME || !fs.existsSync(CHROME)) throw new Error('set E2E_CHROME to a Chrome or Chromium executable');
if (!['127.0.0.1', 'localhost'].includes(new URL(RPC).hostname)) throw new Error('FORK_RPC must be a local anvil fork');

const state = JSON.parse(fs.readFileSync(path.join(HERE, 'state.json'), 'utf8'));
if (!state.credential || !state.relayerKey) throw new Error('run fund.cjs and walk.mjs first');

// Dev database only, by the same guard as account.mjs.
const env = webRequire('dotenv').parse(fs.readFileSync(path.join(ROOT, 'web', '.env.local')));
const { ref: devRef } = rootRequire('./scripts/devDbTarget').loadDevTarget(path.join(ROOT, '.env.dev'));
if (new URL(env.SUPABASE_URL).hostname !== `${devRef}.supabase.co`) throw new Error('refusing: web/.env.local is not the dev database');
const db = webRequire('@supabase/supabase-js').createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

const provider = new ethers.JsonRpcProvider(RPC);
await provider.send('anvil_nodeInfo', []);
const relayer = new ethers.Wallet(state.relayerKey, provider);

let failed = 0;
const record = (name, ok, extra = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
};
const notices = [];
const worker = () =>
  A.sendSignedApprovals({
    supabase: db,
    provider,
    relayer,
    notify: async (_id, body) => notices.push(body),
    explorerUrl: (h) => h,
    now: new Date(),
    log: { warn: (l) => console.log(l), info() {} },
  });
const open = async (to, label) => {
  const out = await A.createApproval({
    supabase: db,
    accountId: state.id,
    gator: state.gator,
    delegate: relayer.address,
    symbol: 'ETH',
    to,
    amount: ethers.parseEther('0.2'),
    amountDisplay: '0.2 ETH',
    recipientLabel: label,
    siteUrl: BASE,
  });
  return { ...out, token: out.url.split('/approve/')[1] };
};
const rowOf = async (id) => (await db.from('custody_approvals').select('*').eq('id', id).single()).data;

const browser = await puppeteer.launch({ executablePath: CHROME, protocolTimeout: 600000 });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 1100, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: state.credential });
  await page.setCookie({ name: 'flizy_session', value: state.token, domain: 'localhost', path: '/', httpOnly: true });
  const WAIT = { timeout: 300000 };
  const text = () => page.evaluate(() => document.body.innerText);
  const waitText = (t) => page.waitForFunction((x) => document.body.innerText.includes(x) || document.querySelector('[role="alert"]'), WAIT, t);
  const click = async (label) => {
    await page.waitForFunction((x) => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === x && !b.disabled), WAIT, label);
    await page.evaluate((x) => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === x && !b.disabled).click(), label);
  };

  // 1-3: approve and send.
  const john = ethers.Wallet.createRandom().address;
  const first = await open(john, 'walk-recipient');
  await page.goto(`${BASE}/approve/${first.token}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await waitText('Approve with passkey');
  const shown = await text();
  record('the page shows the stored recipient, address and amount', shown.includes('walk-recipient') && shown.includes(john) && shown.includes('0.2 ETH'));
  await page.screenshot({ path: path.join(HERE, '3-approve.png'), fullPage: true });
  await click('Approve with passkey');
  await waitText('Approved. Sending now.');
  const alert = await page.evaluate(() => document.querySelector('[role="alert"]')?.innerText || '');
  record('the passkey approves it and the wallet accepts the signature', !alert && (await rowOf(first.id)).status === 'signed', alert);

  record('the worker sends it once', (await worker()) === 1 && (await worker()) === 0);
  await waitText('Sent.');
  await page.screenshot({ path: path.join(HERE, '4-sent.png'), fullPage: true });
  const sentRow = await rowOf(first.id);
  record('the payment arrived, recorded with its hash', sentRow.status === 'sent' && /^0x[0-9a-f]{64}$/.test(sentRow.tx_hash) && (await provider.getBalance(john)) === ethers.parseEther('0.2'));
  let again = '';
  try {
    await provider.call({ from: relayer.address, to: C.CONTRACTS.delegationManager, data: C.redeemCalldata(R.signedFromRow(sentRow), { to: john, amount: ethers.parseEther('0.2') }) });
    again = 'not refused';
  } catch (err) {
    again = err.shortMessage || err.message;
  }
  record('redeeming the same permission again is refused on chain', /allowance-exceeded/.test(again), again.slice(0, 80));
  record('the account was told it was sent', notices.some((n) => n.startsWith('Approved and sent: 0.2 ETH to walk-recipient.')));

  // 4: cancel on the page.
  const kemi = ethers.Wallet.createRandom().address;
  const second = await open(kemi, 'walk-cancel');
  await page.goto(`${BASE}/approve/${second.token}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await waitText('Cancel payment');
  await click('Cancel payment');
  await waitText('Cancelled. Nothing was sent.');
  await page.screenshot({ path: path.join(HERE, '5-cancelled.png'), fullPage: true });
  record('cancel on the page closes it, and the worker sends nothing', (await rowOf(second.id)).status === 'cancelled' && (await worker()) === 0 && (await provider.getBalance(kemi)) === 0n);

  // 5: no session.
  const anon = await browser.createBrowserContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`${BASE}/approve/${second.token}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await anonPage.waitForFunction(() => document.body.innerText.includes('Log in'), WAIT);
  const anonText = await anonPage.evaluate(() => document.body.innerText);
  record('without a session it asks for a login and shows nothing of the payment', !anonText.includes(kemi) && !anonText.includes('walk-cancel') && !anonText.includes('0.2 ETH'));
  await anon.close();

  const [w, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  record('no horizontal scroll at 430px', w <= iw, `${w} / ${iw}`);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
