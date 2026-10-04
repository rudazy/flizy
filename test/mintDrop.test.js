/**
 * FlizyDrop as the site sees it: constants that must equal the contracts,
 * env config, the phase status, the fee breakdown the creator sees, the
 * schedule checks that mirror FlizyDrop's own, and Minted event decoding.
 *
 * Run: node --test test/mintDrop.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let m;
before(async () => {
  m = await import('../web/lib/mintDrop.ts');
});

const SRC = path.join(__dirname, '..', 'contracts', 'src', 'mint');
const ETH = 10n ** 18n;
const PAYOUT = '0x146f0Ee617e0b860A4d2fB454Ae65720C315bbA7';
const COL = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';

describe('constants match the contracts', () => {
  it('FlizyDrop and FlizyCollection', () => {
    const drop = fs.readFileSync(path.join(SRC, 'FlizyDrop.sol'), 'utf8');
    const col = fs.readFileSync(path.join(SRC, 'FlizyCollection.sol'), 'utf8');
    assert.match(drop, new RegExp(`uint256 public constant FEE_BPS = ${m.MINT_FEE_BPS};`));
    assert.match(drop, new RegExp(`uint256 public constant MAX_PER_TX = ${m.MAX_PER_TX};`));
    assert.match(col, /uint256 public constant MAX_SUPPLY_CAP = 10_000;/);
    assert.equal(m.NATIVE_MAX_SUPPLY, 10_000);
    assert.match(col, new RegExp(`uint96 public constant MAX_ROYALTY_BPS = ${m.NATIVE_MAX_ROYALTY_BPS};`));
  });
});

describe('mintConfig', () => {
  it('is off without a drop address', () => {
    assert.equal(m.mintConfig({}), null);
    assert.equal(m.mintConfig({ CHAIN_GIWA_SEPOLIA_DROP: 'nope' }), null);
  });

  it('reads the drop, block and factory', () => {
    const c = m.mintConfig({
      CHAIN_GIWA_SEPOLIA_DROP: '0x8e5f6205ef8bd47ab17ec03d529a3456ea8a56ca',
      CHAIN_GIWA_SEPOLIA_DROP_FROM_BLOCK: '37750102',
      CHAIN_GIWA_SEPOLIA_COLLECTION_FACTORY: '0xff6035bb2ef88ff5f158c411a2337ff767270746',
    });
    assert.equal(c.drop, '0x8E5f6205EF8bd47AB17EC03D529a3456EA8a56cA');
    assert.equal(c.fromBlock, 37750102);
    assert.equal(c.factory, '0xFF6035Bb2ef88Ff5F158C411a2337FF767270746');
  });

  it('a junk block or factory falls back safely', () => {
    const c = m.mintConfig({ CHAIN_GIWA_SEPOLIA_DROP: COL, CHAIN_GIWA_SEPOLIA_DROP_FROM_BLOCK: '-5', CHAIN_GIWA_SEPOLIA_COLLECTION_FACTORY: 'x' });
    assert.equal(c.fromBlock, 0);
    assert.equal(c.factory, null);
  });
});

function cfg(over = {}) {
  return {
    allowlistStart: 1000,
    allowlistEnd: 2000,
    publicStart: 2000,
    mintEnd: 5000,
    allowlistPriceWei: (2n * ETH / 100n).toString(),
    publicPriceWei: (4n * ETH / 100n).toString(),
    publicLimit: 5,
    merkleRoot: `0x${'0'.repeat(64)}`,
    payout: PAYOUT,
    ...over,
  };
}
const state = (over = {}, cfgOver = {}) => ({ configured: true, dropPaused: false, globalPaused: false, config: cfg(cfgOver), ...over });
const supply = (minted = 0, max = 100) => ({ minted, max });

describe('phaseView', () => {
  it('walks upcoming, allowlist, public, ended', () => {
    assert.equal(m.phaseView(state(), supply(), 500).status, 'upcoming');
    assert.equal(m.phaseView(state(), supply(), 500).nextChangeAt, 1000);
    const al = m.phaseView(state(), supply(), 1500);
    assert.equal(al.status, 'allowlist');
    assert.equal(al.allowlistLive, true);
    assert.equal(al.publicLive, false);
    const pub = m.phaseView(state(), supply(), 2000);
    assert.equal(pub.status, 'public');
    assert.equal(pub.allowlistLive, false, 'allowlist window is [start, end)');
    assert.equal(pub.nextChangeAt, 5000);
    assert.equal(m.phaseView(state(), supply(), 5000).status, 'ended');
  });

  it('overlap: both live, status public', () => {
    const v = m.phaseView(state({}, { publicStart: 1500 }), supply(), 1700);
    assert.equal(v.status, 'public');
    assert.ok(v.allowlistLive && v.publicLive);
  });

  it('no end time keeps the public mint open', () => {
    assert.equal(m.phaseView(state({}, { mintEnd: 0 }), supply(), 99_999_999).status, 'public');
  });

  it('allowlist-only ends when the window closes', () => {
    const s = state({}, { publicStart: 0, mintEnd: 0 });
    assert.equal(m.phaseView(s, supply(), 2500).status, 'ended');
  });

  it('sold out and paused win over the clock', () => {
    assert.equal(m.phaseView(state(), supply(100, 100), 2500).status, 'sold_out');
    const p = m.phaseView(state({ dropPaused: true }), supply(), 2500);
    assert.equal(p.status, 'paused');
    assert.equal(p.publicLive, false, 'nothing is mintable while paused');
    assert.equal(m.phaseView(state({ globalPaused: true }), supply(), 2500).status, 'paused');
  });

  it('an unconfigured drop says so', () => {
    assert.equal(m.phaseView({ configured: false, dropPaused: false, globalPaused: false, config: null }, supply(), 1).status, 'unconfigured');
  });
});

describe('headlinePriceWei', () => {
  const c = cfg();
  it('shows the live phase, else the next one', () => {
    assert.equal(m.headlinePriceWei(c, false, false, 500), c.allowlistPriceWei);
    assert.equal(m.headlinePriceWei(c, true, false, 1500), c.allowlistPriceWei);
    assert.equal(m.headlinePriceWei(c, true, true, 1500), c.publicPriceWei);
    assert.equal(m.headlinePriceWei(cfg({ allowlistStart: 0 }), false, false, 500), c.publicPriceWei);
  });
});

describe('feeBreakdown: what the creator page shows', () => {
  it('0.05 ETH: Flizy fee 0.001, creator 0.049', () => {
    const f = m.feeBreakdown((5n * ETH / 100n).toString(), 1);
    assert.equal(f.totalWei, (5n * ETH / 100n).toString());
    assert.equal(f.feeWei, (ETH / 1000n).toString());
    assert.equal(f.creatorWei, (49n * ETH / 1000n).toString());
    assert.equal(f.free, false);
  });

  it('free mint: nothing to anyone', () => {
    assert.deepEqual(m.feeBreakdown('0', 3), { totalWei: '0', feeWei: '0', creatorWei: '0', free: true });
  });

  it('rounds the fee down as the contract does', () => {
    const f = m.feeBreakdown('99', 1);
    assert.equal(f.feeWei, '1');
    assert.equal(f.creatorWei, '98');
  });
});

describe('checkSchedule mirrors FlizyDrop', () => {
  const now = 1000;
  const base = {
    saleType: 'allowlist_public',
    allowlistStart: 2000,
    allowlistEnd: 3000,
    publicStart: 3000,
    mintEnd: 9000,
    allowlistPriceWei: '1',
    publicPriceWei: '2',
    publicLimit: 5,
    payout: PAYOUT,
  };

  it('accepts the default timeline', () => {
    const r = m.checkSchedule(base, now, true);
    assert.equal(r.ok, true);
    assert.equal(r.config.allowlistStart, 2000);
    assert.equal(r.config.publicLimit, 5);
    assert.equal(r.config.merkleRoot, `0x${'0'.repeat(64)}`);
  });

  it('public only and allowlist only switch the other phase off', () => {
    const pub = m.checkSchedule({ ...base, saleType: 'public' }, now, true);
    assert.equal(pub.config.allowlistStart, 0);
    assert.equal(pub.config.allowlistPriceWei, '0');
    const al = m.checkSchedule({ ...base, saleType: 'allowlist' }, now, true);
    assert.equal(al.config.publicStart, 0);
    assert.equal(al.config.publicLimit, 0);
  });

  it('refuses what the contract would revert', () => {
    const bad = [
      [{ allowlistEnd: 2000 }, 'close after it opens'],
      [{ allowlistEnd: 9500 }, 'cannot close after the mint ends'],
      [{ mintEnd: 3000 }, 'end after the public mint opens'],
      [{ publicLimit: 0 }, 'per-wallet limit'],
      [{ payout: 'nope' }, 'payout'],
      [{ allowlistStart: undefined }, 'opens and closes'],
      [{ publicStart: undefined }, 'public mint opens'],
      [{ publicPriceWei: '-1' }, 'public price'],
      [{ merkleRoot: '0x1234' }, 'root'],
    ];
    for (const [over, msg] of bad) {
      const r = m.checkSchedule({ ...base, ...over }, now, true);
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.match(r.error, new RegExp(msg), JSON.stringify(over));
    }
  });

  it('a new drop must start in the future; an edit may keep a past start', () => {
    assert.match(m.checkSchedule({ ...base, allowlistStart: 900 }, now, true).error, /future/);
    assert.equal(m.checkSchedule({ ...base, allowlistStart: 900 }, now, false).ok, true);
  });

  it('no end time is allowed', () => {
    assert.equal(m.checkSchedule({ ...base, mintEnd: 0 }, now, true).ok, true);
  });

  it('configTuple round-trips through the ABI', () => {
    const r = m.checkSchedule(base, now, true);
    const data = m.DROP_IFACE.encodeFunctionData('configure', [COL, m.configTuple(r.config)]);
    const decoded = m.DROP_IFACE.decodeFunctionData('configure', data);
    const back = m.parseConfig(decoded[1]);
    assert.deepEqual(back, r.config);
  });
});

describe('Minted events', () => {
  const iface = () => m.DROP_IFACE;
  function log(args, ts) {
    const ev = iface().getEvent('Minted');
    const { topics, data } = iface().encodeEventLog(ev, args);
    return { topics, data, blockNumber: 10, logIndex: 0, txHash: `0x${'1'.repeat(64)}`, timestamp: ts };
  }

  it('decode and fold into creator stats', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const logs = [
      log([COL, PAYOUT, true, 2n, 1n, 4n * ETH / 100n, 8n * ETH / 10000n], '2026-10-04T10:00:00Z'),
      log([COL, PAYOUT, false, 1n, 3n, 4n * ETH / 100n, 8n * ETH / 10000n], '2026-10-01T10:00:00Z'),
      log(['0x308be8f71DA695f18E70D2243a446e1fD1566BA6', PAYOUT, false, 5n, 1n, 0n, 0n], '2026-10-04T10:00:00Z'),
      { topics: ['0xdead'], data: '0x', blockNumber: 1, logIndex: 0, txHash: '0x', timestamp: null },
    ];
    const events = m.decodeMintedLogs(logs);
    assert.equal(events.length, 3);
    assert.equal(events[0].allowlist, true);
    assert.equal(events[0].quantity, 2);
    const s = m.mintStats(events, COL, now);
    assert.equal(s.mintedViaFlizy, 3);
    assert.equal(s.mintsToday, 2);
    assert.equal(s.feesWei, (16n * ETH / 10000n).toString());
    assert.equal(s.revenueWei, (8n * ETH / 100n - 16n * ETH / 10000n).toString());
  });
});
