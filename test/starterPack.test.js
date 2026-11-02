/**
 * The starter pack on Home: link a chat, free test ETH, a first payment to the
 * starter host, a first swap.
 *
 * What is pinned: a chat counts only when it is WhatsApp or Telegram; the
 * payment step ticks on a confirmed ETH send of at least the starter amount to
 * the host's wallet, from chat or from the site; a token, a smaller amount, an
 * unconfirmed send or a send to someone else does not tick it; the host and an
 * install with no host are never asked to pay; and the Home card reads it.
 *
 * Run: node --test test/starterPack.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

let S;
let H;
before(async () => {
  S = await import('../web/lib/starterPack.ts');
  H = await import('../web/lib/starterHost.ts');
});

const ME = 'acc-me';
const HOST = 'acc-host';
const HOST_WALLET = '0x' + 'ab'.repeat(20);

function client({ channels = [], transfers = [], host = {} } = {}) {
  return createFakeSupabase({
    accounts: [
      { id: ME, username: 'ama', agent_wallet_address: '0x' + 'cd'.repeat(20) },
      { id: HOST, username: H.STARTER_HOST, agent_wallet_address: HOST_WALLET, ...host },
    ],
    channel_identities: channels.map((channel, i) => ({ id: `ci-${i}`, account_id: ME, channel, external_id: String(100 + i) })),
    transfers: transfers.map((t, i) => ({
      id: `tx-${i}`, account_id: ME, to_address: HOST_WALLET.toUpperCase().replace('0X', '0x'), status: 'confirmed', kind: 'transfer',
      amount_eth: '0.001', asset: 'ETH', token_address: null, ...t,
    })),
  }).client;
}

describe('starter pack progress', () => {
  it('pays the host 0.001 ETH', () => {
    assert.equal(H.STARTER_HOST, 'ludarep');
    assert.equal(H.STARTER_AMOUNT_ETH, 0.001);
  });

  it('starts with nothing done', async () => {
    assert.deepEqual(await S.starterProgress(ME, client()), { chatLinked: false, paidHost: false });
  });

  it('counts a linked WhatsApp or Telegram, and nothing else, as a chat', async () => {
    assert.equal((await S.starterProgress(ME, client({ channels: ['telegram'] }))).chatLinked, true);
    assert.equal((await S.starterProgress(ME, client({ channels: ['whatsapp'] }))).chatLinked, true);
    assert.equal((await S.starterProgress(ME, client({ channels: ['discord'] }))).chatLinked, false);
  });

  it('ticks on a confirmed ETH send of at least the amount to the host wallet', async () => {
    assert.equal((await S.starterProgress(ME, client({ transfers: [{}] }))).paidHost, true);
    assert.equal((await S.starterProgress(ME, client({ transfers: [{ amount_eth: '0.5', asset: null }] }))).paidHost, true);
  });

  it('does not tick on a token, a smaller amount, an unconfirmed send or another payee', async () => {
    for (const t of [
      { asset: 'FLZ', token_address: '0x' + 'ee'.repeat(20) },
      { amount_eth: '0.0009' },
      { status: 'pending' },
      { status: 'failed' },
      { kind: 'swap' },
      { to_address: '0x' + '12'.repeat(20) },
    ]) {
      assert.equal((await S.starterProgress(ME, client({ transfers: [t] }))).paidHost, false, JSON.stringify(t));
    }
  });

  it('never asks the host, or an install with no host, to pay', async () => {
    assert.equal((await S.starterProgress(HOST, client())).paidHost, true);
    assert.equal((await S.starterProgress(ME, client({ host: { username: 'someone' } }))).paidHost, true);
    assert.equal((await S.starterProgress(ME, client({ host: { agent_wallet_address: null } }))).paidHost, true);
  });
});

describe('the starter pack on Home', () => {
  const card = fs.readFileSync(path.join(__dirname, '..', 'web', 'components', 'FirstSteps.tsx'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'api', 'account', 'starter', 'route.ts'), 'utf8');

  it('reads its progress from a signed-in route', () => {
    assert.match(card, /fetch\('\/api\/account\/starter'\)/);
    assert.match(route, /if \(!accountId\) return NextResponse\.json\(\{ error: 'Not logged in' \}, \{ status: 401 \}\)/);
    assert.match(route, /starterProgress\(accountId\)/);
  });

  it('tells a new person what to type in chat', () => {
    assert.match(card, /In your chat, type: send \$\{STARTER_AMOUNT_ETH\} to @\$\{STARTER_HOST\}/);
  });

  it('keeps the database client out of the browser card', () => {
    assert.match(card, /from '\.\.\/lib\/starterHost'/);
    assert.doesNotMatch(card, /starterPack/);
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'starterHost.ts'), 'utf8'), /^import /m);
  });
});
