/**
 * Shared receipts: /r/{token}.
 *
 * What is pinned: only the sender or the wallet that was paid can make a
 * receipt link, and a stranger is told nothing about which ids exist; only a
 * confirmed payment has one; the token is random, made once and kept; the page
 * opens by token alone, never by id; and each person is named only when they
 * chose to be named on Scan.
 *
 * Run: node --test test/receipts.test.js
 */

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { receiptUrlFor } = require('../lib/receipts');
const { formatSendReceipt } = require('../lib/engine/receipt');

let R;
let fake;
before(async () => {
  R = await import('../web/lib/receipts.ts');
});

const SENDER = 'acc-sender';
const PAYEE = 'acc-payee';
const STRANGER = 'acc-stranger';
const PAYEE_WALLET = '0x' + 'cd'.repeat(20);
const TX = '11111111-2222-4333-8444-555555555555';

function seed(transfer = {}, accounts = {}) {
  fake = createFakeSupabase({
    accounts: [
      { id: SENDER, username: 'ada', scan_show_username: true, agent_wallet_address: '0x' + 'ab'.repeat(20), ...accounts.sender },
      { id: PAYEE, username: 'kemi', scan_show_username: false, agent_wallet_address: PAYEE_WALLET, ...accounts.payee },
      { id: STRANGER, username: 'zed', scan_show_username: true, agent_wallet_address: '0x' + 'ef'.repeat(20) },
    ],
    transfers: [
      {
        id: TX, account_id: SENDER, to_address: PAYEE_WALLET.toUpperCase().replace('0X', '0x'), status: 'confirmed', kind: 'transfer',
        amount_eth: '50', asset: 'TUSD', token_address: '0x4F28C18600c312Bfa8e8281D882e0EC306F82446',
        tx_hash: '0x' + 'aa'.repeat(32), created_at: '2026-10-21T10:00:00.000Z', note: 'design work', receipt_token: null,
        ...transfer,
      },
    ],
  });
}

const c = () => fake.client;
const row = () => fake.db.tables.transfers[0];

describe('who can share a receipt', () => {
  beforeEach(() => seed());

  it('lets the sender share, and makes a 22-character random token once', async () => {
    const token = await R.shareReceipt(SENDER, TX, c());
    assert.match(token, R.RECEIPT_TOKEN_RE);
    assert.equal(row().receipt_token, token);
    assert.equal(await R.shareReceipt(SENDER, TX, c()), token, 'a second share keeps the link');
  });

  it('lets the wallet that was paid share, matching the address in any case', async () => {
    const token = await R.shareReceipt(PAYEE, TX, c());
    assert.match(token, R.RECEIPT_TOKEN_RE);
  });

  it('tells a stranger the same thing as a missing id', async () => {
    await assert.rejects(() => R.shareReceipt(STRANGER, TX, c()), { message: R.RECEIPT_NOT_FOUND });
    await assert.rejects(() => R.shareReceipt(SENDER, '99999999-2222-4333-8444-555555555555', c()), { message: R.RECEIPT_NOT_FOUND });
    await assert.rejects(() => R.shareReceipt(SENDER, 'not-a-uuid', c()), { message: R.RECEIPT_NOT_FOUND });
    assert.equal(row().receipt_token, null);
  });

  it('refuses a payment that has not confirmed, and anything that is not a payment', async () => {
    seed({ status: 'pending' });
    await assert.rejects(() => R.shareReceipt(SENDER, TX, c()), { message: R.RECEIPT_NOT_SETTLED });
    seed({ kind: 'swap' });
    await assert.rejects(() => R.shareReceipt(SENDER, TX, c()), { message: R.RECEIPT_NOT_FOUND });
  });
});

describe('what a receipt shows', () => {
  it('opens by token only, never by id or a malformed token', async () => {
    seed();
    const token = await R.shareReceipt(SENDER, TX, c());
    assert.ok(await R.loadReceipt(token, 'GIWA Sepolia', c()));
    assert.equal(await R.loadReceipt(TX, 'GIWA Sepolia', c()), null);
    assert.equal(await R.loadReceipt('x'.repeat(22), 'GIWA Sepolia', c()), null);
    assert.equal(await R.loadReceipt("'; drop table--", 'GIWA Sepolia', c()), null);
  });

  it('names each person only when they chose to be named on Scan', async () => {
    seed();
    const r = await R.loadReceipt(await R.shareReceipt(SENDER, TX, c()), 'GIWA Sepolia', c());
    assert.deepEqual(
      { amount: r.amount, unit: r.unit, from: r.from, to: r.to, note: r.note, network: r.network },
      { amount: '50', unit: 'tUSD', from: '@ada', to: 'A Flizy account', note: 'design work', network: 'GIWA Sepolia' }
    );
  });

  it('shortens a wallet outside Flizy rather than printing it whole', async () => {
    seed({ to_address: '0x' + '12'.repeat(20) });
    const r = await R.loadReceipt(await R.shareReceipt(SENDER, TX, c()), 'GIWA Sepolia', c());
    assert.equal(r.to, '0x1212…1212');
    assert.equal(r.toKind, 'wallet');
  });

  it('says whether each side is a Flizy account', async () => {
    seed();
    const r = await R.loadReceipt(await R.shareReceipt(SENDER, TX, c()), 'GIWA Sepolia', c());
    assert.deepEqual({ fromKind: r.fromKind, toKind: r.toKind }, { fromKind: 'flizy', toKind: 'flizy' });
  });

  it('does not call a sender with no account a Flizy wallet', async () => {
    seed({ account_id: 'acc-gone', receipt_token: 'abcdefghijklmnopqrstuv' });
    const r = await R.loadReceipt('abcdefghijklmnopqrstuv', 'GIWA Sepolia', c());
    assert.deepEqual({ from: r.from, fromKind: r.fromKind }, { from: 'A wallet', fromKind: 'wallet' });
  });
});

describe('the receipt link in chat', () => {
  it('is made for a confirmed payment and printed under it', async () => {
    seed();
    const url = await receiptUrlFor(c(), TX, 'https://flizy.app/');
    assert.match(url, /^https:\/\/flizy\.app\/r\/[A-Za-z0-9_-]{22}$/);
    assert.equal(url, await receiptUrlFor(c(), TX, 'https://flizy.app'), 'the same link every time');
    const text = formatSendReceipt({ ok: true, explorerUrl: 'https://x/tx/1', receiptUrl: url });
    assert.match(text, /Receipt to share: https:\/\/flizy\.app\/r\//);
  });

  it('is left out, never thrown, when there is nothing to give', async () => {
    seed({ status: 'failed' });
    assert.equal(await receiptUrlFor(c(), TX, 'https://flizy.app'), null);
    assert.equal(await receiptUrlFor(c(), null, 'https://flizy.app'), null);
    const broken = { from: () => { throw new Error('db down'); } };
    assert.equal(await receiptUrlFor(broken, TX, 'https://flizy.app'), null);
    assert.doesNotMatch(formatSendReceipt({ ok: true, explorerUrl: 'https://x/tx/1' }), /Receipt/);
  });
});

describe('the receipt route', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  it('is same-site and signed in, and the page is never indexed', () => {
    const route = read('web/app/api/receipts/route.ts');
    assert.match(route, /rejectIfCrossOrigin\(req\)/);
    assert.match(route, /getAccountIdFromCookie\(\)/);
    assert.match(read('web/app/r/[token]/page.tsx'), /noindex: true/);
  });

  it('opens the receipt image by token, unindexed', () => {
    const route = read('web/app/r/[token]/image/route.tsx');
    assert.match(route, /loadReceipt\(params\.token,/);
    assert.match(route, /status: 404/);
    assert.match(route, /X-Robots-Tag', 'noindex'/);
  });

  it('keeps names off the link preview card', () => {
    const card = read('web/app/r/[token]/opengraph-image.tsx');
    assert.doesNotMatch(card, /r\.from|r\.to\b|r\.note/);
  });
});

describe('the receipt link preview', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  it('points at the receipt card, not the site-wide one', () => {
    const page = read('web/app/r/[token]/page.tsx');
    assert.match(page, /url: `\/r\/\$\{params\.token\}\/opengraph-image`/);
    assert.match(page, /openGraph: \{ \.\.\.base\.openGraph, images: \[card\] \}/);
  });

  it('says confirmed only of a real payment', () => {
    const card = read('web/app/r/[token]/opengraph-image.tsx');
    assert.match(card, /let kicker = 'RECEIPT';/);
    assert.match(card, /if \(r\) \{\s*kicker = 'PAYMENT CONFIRMED';/);
  });
});
