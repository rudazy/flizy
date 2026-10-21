/**
 * Connected-wallet transactions on Scan: what is read from the chain, the row
 * it becomes, what is refused, and the wiring from the page to the route.
 *
 * Calls and logs are encoded here with ethers, the same ABI the contracts
 * emit, so the reader is tested against real bytes, not hand-made objects.
 *
 * Run: node --test test/walletScanRecord.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let rec;
let historyRow;
before(async () => {
  rec = await import('../web/lib/walletScanRecord.ts');
  historyRow = await import('../web/lib/historyRow.ts');
});

const ROUTER = '0x6427fD0c13577847888B7E2d1A24C887bBEBd9cC';
const WETH = '0x3a13399f2741122B63c7710B2A85346B97C6BFDf';
const FLZ = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
const MARKET = '0x1111111111111111111111111111111111111111';
const COLLECTION = '0x2222222222222222222222222222222222222222';
const OUTSIDE = '0x3333333333333333333333333333333333333333';
const FLIZY_WALLET = '0x4444444444444444444444444444444444444444';
const STRANGER = '0x5555555555555555555555555555555555555555';
const POOL_ROUTER = '0x4055413A4757e069bbCAc481639EF2814224Faa0';
const HASH = `0x${'ab'.repeat(32)}`;

const SETUP = {
  feeRouter: ROUTER,
  weth: WETH,
  market: MARKET,
  tokens: [{ address: FLZ, symbol: 'FLZ', decimals: 18 }],
};

const routerIface = new ethers.Interface([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
]);
const tokenIface = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Withdrawal(address indexed src, uint256 wad)',
  'function transfer(address to, uint256 amount)',
]);
const marketIface = new ethers.Interface([
  'event Sold(address indexed collection, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price, uint256 fee, uint256 royalty, uint256 offerId)',
  'event OfferMade(uint256 indexed offerId, address indexed collection, address indexed maker, uint256 tokenId, bool anyToken, uint256 amount, uint64 expiry)',
  'event Listed(address indexed collection, uint256 indexed tokenId, address indexed seller, uint256 price, uint64 expiry)',
]);

function log(iface, address, name, args) {
  const encoded = iface.encodeEventLog(name, args);
  return { address, topics: encoded.topics, data: encoded.data };
}

const wei = (n) => ethers.parseEther(String(n));

function ethToFlz() {
  return {
    from: OUTSIDE,
    to: ROUTER,
    value: wei('0.01'),
    data: routerIface.encodeFunctionData('swapExactETHForTokens', [1n, [WETH, FLZ], OUTSIDE, 9999999999n]),
    logs: [
      log(tokenIface, FLZ, 'Transfer', ['0x6666666666666666666666666666666666666666', OUTSIDE, wei(250)]),
      // A Transfer of the same token to someone else is not the wallet's output.
      log(tokenIface, FLZ, 'Transfer', ['0x6666666666666666666666666666666666666666', STRANGER, wei(7)]),
    ],
  };
}

function flzToEth() {
  return {
    from: OUTSIDE,
    to: ROUTER,
    value: 0n,
    data: routerIface.encodeFunctionData('swapExactTokensForETH', [wei(100), 1n, [FLZ, WETH], OUTSIDE, 9999999999n]),
    logs: [log(tokenIface, WETH, 'Withdrawal', [POOL_ROUTER, wei('0.004')])],
  };
}

function buy() {
  return {
    from: OUTSIDE,
    to: MARKET,
    value: wei('0.05'),
    data: '0x12345678',
    logs: [log(marketIface, MARKET, 'Sold', [COLLECTION, 12n, OUTSIDE, STRANGER, wei('0.05'), 0n, 0n, 0n])],
  };
}

describe('reading a transaction', () => {
  it('ETH to a token through the fee router: the full amount in, the Transfer to the wallet out', () => {
    const move = rec.readWalletMove(ethToFlz(), SETUP);
    assert.equal(move.kind, 'swap');
    assert.equal(move.tokenIn, null);
    assert.equal(move.amountIn, wei('0.01'));
    assert.equal(move.tokenOut.symbol, 'FLZ');
    assert.equal(move.amountOut, wei(250));
  });

  it('a token to ETH: the amount from the call, ETH out from the WETH unwrap', () => {
    const move = rec.readWalletMove(flzToEth(), SETUP);
    assert.equal(move.kind, 'swap');
    assert.equal(move.tokenIn.symbol, 'FLZ');
    assert.equal(move.amountIn, wei(100));
    assert.equal(move.tokenOut, null);
    assert.equal(move.amountOut, wei('0.004'));
  });

  it('a swap of a token this deployment does not list is not recorded', () => {
    const tx = ethToFlz();
    tx.data = routerIface.encodeFunctionData('swapExactETHForTokens', [1n, [WETH, STRANGER], OUTSIDE, 9999999999n]);
    assert.equal(rec.readWalletMove(tx, SETUP), null);
  });

  it('only the token contract\'s own logs count as output', () => {
    const tx = ethToFlz();
    tx.logs = [log(tokenIface, STRANGER, 'Transfer', [STRANGER, OUTSIDE, wei(250)])];
    assert.equal(rec.readWalletMove(tx, SETUP), null);
  });

  it('a marketplace sale reads as a buy for the buyer and a sale for the seller', () => {
    const asBuyer = rec.readWalletMove(buy(), SETUP);
    assert.equal(asBuyer.kind, 'market');
    assert.equal(rec.marketLabel(asBuyer, 'Giwaforge'), 'Buy Giwaforge #12 for 0.05 ETH');
    const accept = { ...buy(), from: STRANGER, value: 0n };
    assert.equal(rec.marketLabel(rec.readWalletMove(accept, SETUP), 'Giwaforge'), 'Sell Giwaforge #12 for 0.05 ETH');
  });

  it('a collection offer names any token; an unnamed collection falls back to its address', () => {
    const tx = {
      from: OUTSIDE,
      to: MARKET,
      value: wei('0.02'),
      data: '0x12345678',
      logs: [log(marketIface, MARKET, 'OfferMade', [7n, COLLECTION, OUTSIDE, 0n, true, wei('0.02'), 0n])],
    };
    assert.equal(rec.marketLabel(rec.readWalletMove(tx, SETUP), null), 'Offer 0.02 ETH for any 0x2222...2222');
  });

  it('marketplace events logged by another contract are ignored', () => {
    const tx = buy();
    tx.logs = [log(marketIface, STRANGER, 'Sold', [COLLECTION, 12n, OUTSIDE, STRANGER, wei('0.05'), 0n, 0n, 0n])];
    assert.equal(rec.readWalletMove(tx, SETUP), null);
  });

  it('a plain ETH send is a deposit candidate; the receiver is checked later', () => {
    const move = rec.readWalletMove({ from: OUTSIDE, to: FLIZY_WALLET, value: wei('0.1'), data: '0x', logs: [] }, SETUP);
    assert.deepEqual(move, { kind: 'deposit', wallet: OUTSIDE, to: FLIZY_WALLET, token: null, units: wei('0.1') });
  });

  it('a token deposit needs its Transfer log to match the call', () => {
    const tx = {
      from: OUTSIDE,
      to: FLZ,
      value: 0n,
      data: tokenIface.encodeFunctionData('transfer', [FLIZY_WALLET, wei(5)]),
      logs: [log(tokenIface, FLZ, 'Transfer', [OUTSIDE, FLIZY_WALLET, wei(5)])],
    };
    assert.equal(rec.readWalletMove(tx, SETUP).units, wei(5));
    tx.logs = [log(tokenIface, FLZ, 'Transfer', [OUTSIDE, FLIZY_WALLET, wei(4)])];
    assert.equal(rec.readWalletMove(tx, SETUP), null);
  });

  it('a call to anything else, or a contract creation, is not Flizy activity', () => {
    assert.equal(rec.readWalletMove({ from: OUTSIDE, to: STRANGER, value: 0n, data: '0xdeadbeef', logs: [] }, SETUP), null);
    assert.equal(rec.readWalletMove({ from: OUTSIDE, to: null, value: 0n, data: '0x60', logs: [] }, SETUP), null);
  });
});

describe('the row', () => {
  const at = new Date('2026-10-21T10:00:00Z');

  it('a swap: no account, the wallet as the address, both legs', () => {
    const row = rec.walletScanRow(rec.readWalletMove(ethToFlz(), SETUP), { txHash: HASH.toUpperCase().replace('0X', '0x'), chainId: 91342, at });
    assert.equal(row.account_id, null);
    assert.equal(row.phone, 'wallet');
    assert.equal(row.kind, 'swap');
    assert.equal(row.to_address, OUTSIDE);
    assert.equal(row.amount_eth, '0.01');
    assert.equal(row.asset, 'ETH');
    assert.equal(row.amount_secondary, '250.0');
    assert.equal(row.asset_secondary, 'FLZ');
    assert.equal(row.tx_hash, HASH);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.created_at, at.toISOString());
  });

  it('a marketplace action carries its label and what was paid', () => {
    const row = rec.walletScanRow(rec.readWalletMove(buy(), SETUP), { txHash: HASH, chainId: 91342, at, collectionName: 'Giwaforge' });
    assert.equal(row.kind, 'nft_market');
    assert.equal(row.amount_eth, '0.05');
    assert.equal(row.counterparty_label, 'Buy Giwaforge #12 for 0.05 ETH');
  });

  it('a collection name from the chain is flattened before it is stored', () => {
    const row = rec.walletScanRow(rec.readWalletMove(buy(), SETUP), { txHash: HASH, chainId: 91342, at, collectionName: 'Evil\nline' });
    assert.equal(row.counterparty_label, 'Buy Evil line #12 for 0.05 ETH');
  });

  it('a deposit goes to the Flizy wallet and names the sender as an outside payment does', () => {
    const move = rec.readWalletMove({ from: OUTSIDE, to: FLIZY_WALLET, value: wei('0.1'), data: '0x', logs: [] }, SETUP);
    const row = rec.walletScanRow(move, { txHash: HASH, chainId: 91342, at });
    assert.equal(row.kind, 'transfer');
    assert.equal(row.to_address, FLIZY_WALLET);
    assert.equal(row.counterparty_label, '0x3333…3333');
    assert.equal(row.token_address, null);
  });

  it('Scan and History show the channel as an outside wallet', () => {
    assert.equal(historyRow.channelLabel('wallet'), 'Outside wallet');
  });
});

describe('recording', () => {
  const NOW = Date.parse('2026-10-21T10:30:00Z');
  const BLOCK_TIME = Math.floor(Date.parse('2026-10-21T10:00:00Z') / 1000);

  function provider(tx, { status = 1, blockTime = BLOCK_TIME, name = 'Giwaforge' } = {}) {
    return {
      getTransaction: async () => ({ from: tx.from, to: tx.to, value: tx.value, data: tx.data }),
      getTransactionReceipt: async () => ({ status, blockNumber: 5, logs: tx.logs }),
      getBlock: async () => ({ timestamp: blockTime }),
      // ethers.Contract reaches the provider through call(); name() answers with an ABI string.
      call: async () => ethers.AbiCoder.defaultAbiCoder().encode(['string'], [name]),
    };
  }

  function db(tables = {}) {
    const fake = createFakeSupabase({
      accounts: [{ id: 'acct-1', agent_wallet_address: FLIZY_WALLET }],
      transfers: [],
      faucet_claims: [],
      claims: [],
      ...tables,
    });
    return fake;
  }

  const record = (tx, fake, opts) =>
    rec.recordWalletTx({ provider: provider(tx, opts), supabase: fake.client, txHash: HASH, chainId: 91342, setup: SETUP, now: NOW });

  it('records a swap once it is mined', async () => {
    const fake = db();
    assert.equal(await record(ethToFlz(), fake), true);
    const rows = fake.db.tables.transfers;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phone, 'wallet');
    assert.equal(rows[0].kind, 'swap');
  });

  it('records a deposit into a Flizy wallet, and not one into any other wallet', async () => {
    const fake = db();
    assert.equal(await record({ from: OUTSIDE, to: FLIZY_WALLET, value: wei('0.1'), data: '0x', logs: [] }, fake), true);
    assert.equal(await record({ from: OUTSIDE, to: STRANGER, value: wei('0.1'), data: '0x', logs: [] }, db()), false);
  });

  it('refuses a failed transaction and one older than the window', async () => {
    assert.equal(await record(ethToFlz(), db(), { status: 0 }), false);
    assert.equal(await record(ethToFlz(), db(), { blockTime: BLOCK_TIME - rec.RECORD_WINDOW_S }), false);
  });

  it('refuses what Flizy already logged: its own sends, faucet drips, claim payouts and refunds', async () => {
    const deposit = { from: OUTSIDE, to: FLIZY_WALLET, value: wei('0.1'), data: '0x', logs: [] };
    assert.equal(await record(deposit, db({ transfers: [{ id: 't1', tx_hash: HASH }] })), false);
    assert.equal(await record(deposit, db({ faucet_claims: [{ id: 'f1', tx_hash: HASH }] })), false);
    assert.equal(await record(deposit, db({ claims: [{ id: 'c1', claim_tx_hash: HASH }] })), false);
    assert.equal(await record(deposit, db({ claims: [{ id: 'c2', refund_tx_hash: HASH }] })), false);
  });

  it('refuses a transaction sent by a Flizy wallet, whose own route logs it', async () => {
    const fake = db();
    assert.equal(await record({ ...ethToFlz(), from: FLIZY_WALLET }, fake), false);
    assert.equal(fake.db.tables.transfers.length, 0);
  });

  it('a hash handed over twice is one row: the unique index answers the second insert', async () => {
    const fake = db();
    const realFrom = fake.client.from.bind(fake.client);
    const seen = new Set();
    const client = {
      ...fake.client,
      from(table) {
        const q = realFrom(table);
        if (table !== 'transfers') return q;
        const insert = q.insert.bind(q);
        q.insert = (row) => {
          if (row.phone === 'wallet' && seen.has(row.tx_hash)) return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } });
          seen.add(row.tx_hash);
          return insert(row);
        };
        // The second call must reach the index: the "already logged" read is
        // answered empty here, as two calls racing would both see it empty.
        if (seen.size) q.select = () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }) }) });
        return q;
      },
    };
    const run = () => rec.recordWalletTx({ provider: provider(ethToFlz()), supabase: client, txHash: HASH, chainId: 91342, setup: SETUP, now: NOW });
    assert.equal(await run(), true);
    assert.equal(await run(), false);
    assert.equal(fake.db.tables.transfers.length, 1);
  });

  it('a marketplace row is labelled with the collection name read from the chain', async () => {
    const fake = db();
    assert.equal(await record(buy(), fake), true);
    assert.equal(fake.db.tables.transfers[0].counterparty_label, 'Buy Giwaforge #12 for 0.05 ETH');
  });
});

describe('wiring', () => {
  it('the route takes only a hash, refuses cross-origin calls, and is capped per caller', () => {
    const route = read('web/app/api/scan/record/route.ts');
    assert.match(route, /rejectIfCrossOrigin\(req\)/);
    assert.match(route, /takeCallerAttempt\(supabase, req\.headers, 'record'\)/);
    assert.match(route, /TX_HASH_RE\.test\(txHash\)/);
    assert.doesNotMatch(route, /getAccountIdFromCookie/);
  });

  it('the record bucket has its own hourly cap', async () => {
    const { CALLER_CAPS } = await import('../web/lib/callerLimit.ts');
    assert.equal(CALLER_CAPS.record, 30);
  });

  it('every connected-wallet trade and deposit hands its hash to Scan once it lands', () => {
    const trade = read('web/lib/walletTrade.ts');
    assert.match(trade, /recordOnScan\(txHash\);\n  return \{ txHash, explorerUrl/);
    assert.match(trade, /if \(receipt\.status !== 'success'\) throw new Error\('The swap failed on chain\.'\);\n  recordOnScan\(hash\);/);
    assert.match(
      read('web/components/DepositSheet.tsx'),
      /if \(receipt\.status !== 'success'\) throw new Error\('The deposit failed on chain\.'\);\n\s*recordOnScan\(hash\);/
    );
  });

  it('the migration is idempotent and checks its own result', () => {
    const sql = read('supabase/migrations/20261023120000_wallet_scan_rows.sql');
    assert.match(sql, /create unique index if not exists transfers_wallet_tx_once\s+on public\.transfers \(tx_hash\)\s+where phone = 'wallet';/);
    assert.match(sql, /do \$\$[\s\S]*raise exception 'transfers_wallet_tx_once is missing or not unique'/);
    assert.match(sql, /raise exception 'external_pay_attempts comment was not updated'/);
  });

  it('the merchant view names a deposit from a connected wallet as an outside wallet', () => {
    assert.match(read('web/lib/merchant.ts'), /r\.phone === 'external' \|\| r\.phone === 'wallet'/);
  });
});
