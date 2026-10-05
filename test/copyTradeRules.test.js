/**
 * Dollar rules for copy trade: parse, inherit, sell behaviour, and the card text.
 *
 * Run: node --test test/copyTradeRules.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let rules;

before(async () => {
  rules = await import('../web/lib/copyTradeRules.ts');
});

function committed(extra = {}) {
  return rules.parseCommittedRules({
    buy: '10',
    minMcap: '50000',
    maxMcap: '5000000',
    copyBuys: true,
    copySells: true,
    sellMode: 'percent',
    maxPerTrade: '10',
    maxDaily: '100',
    maxOpenPositions: 10,
    ...extra,
  });
}

describe('money', () => {
  it('reads dollars, cents, commas, and k or m suffixes as cents', () => {
    assert.equal(rules.parseUsdCents('$10', 'Amount'), 1000);
    assert.equal(rules.parseUsdCents('10', 'Amount'), 1000);
    assert.equal(rules.parseUsdCents('10.50', 'Amount'), 1050);
    assert.equal(rules.parseUsdCents('$1,000', 'Amount'), 100000);
    assert.equal(rules.parseUsdCents('1.5k', 'Amount'), 150000);
    assert.equal(rules.parseUsdCents('1m', 'Amount'), 100000000);
    assert.equal(rules.parseMcapUsd('50k', 'Minimum market cap'), 50000);
    assert.equal(rules.parseMcapUsd('$5M', 'Maximum market cap'), 5000000);
    assert.equal(rules.parseMcapUsd('', 'Minimum market cap'), 0);
    assert.equal(rules.parseMcapUsd('0', 'Minimum market cap'), 0);
  });

  it('refuses a third decimal, a tiny amount, and an amount past the cap', () => {
    assert.throws(() => rules.parseUsdCents('1'.repeat(41), 'Amount per trade'), /dollar amount/);
    assert.throws(() => rules.parseMcapUsd('9'.repeat(41), 'Minimum market cap'), /dollar amount/);
    assert.throws(() => rules.parseUsdCents('10.555', 'Amount per trade'), /2 decimal places/);
    assert.throws(() => committed({ buy: '0.50' }), /at least \$1/);
    assert.throws(() => rules.parseUsdCents('2m', 'Amount per trade'), /\$1,000,000 or less/);
    assert.throws(() => committed({ minMcap: '10', maxMcap: '5' }), /below the minimum/);
  });
});

describe('sells and safety', () => {
  it('keeps a percentage sell free of a dollar amount', () => {
    const parsed = committed({ sellMode: 'percent', sellAmount: '40' });
    assert.equal(parsed.sellMode, 'percent');
    assert.equal(parsed.sellUsdCents, 0);
    assert.equal(parsed.buyUsdCents, 1000);
    assert.equal(parsed.maxDailyUsdCents, 10000);
    assert.equal(parsed.maxOpenPositions, 10);
    assert.equal(parsed.ignoreStablecoins, true);
    assert.equal(parsed.firstBuyOnly, false);
    assert.equal(parsed.skipLiquidity, true);
  });

  it('requires a fixed sell, a daily limit above the trade, and 1 to 100 open positions', () => {
    const fixed = committed({ sellMode: 'fixed', sellAmount: '5', maxPerTrade: '10' });
    assert.equal(fixed.sellUsdCents, 500);
    assert.throws(() => committed({ sellMode: 'fixed', sellAmount: '' }), /Sell amount/);
    assert.throws(() => committed({ maxPerTrade: '5' }), /above the maximum per trade/);
    assert.throws(() => committed({ maxDaily: '5' }), /daily spend is below/);
    assert.throws(() => committed({ maxOpenPositions: 0 }), /Open positions/);
    assert.throws(() => committed({ maxOpenPositions: 101 }), /Open positions/);
    const off = committed({ copyBuys: false, copySells: false });
    assert.equal(off.copyBuys, false);
    assert.equal(off.copySells, false);
  });

  it('leaves advanced fields at the safe defaults unless they are set', () => {
    const parsed = committed();
    assert.equal(parsed.slippageBps, 100);
    assert.equal(parsed.skipTransfers, true);
    assert.equal(parsed.skipFailed, true);
    assert.equal(parsed.cooldownSec, 0);
    assert.throws(() => committed({ slippagePct: '0.05' }), /0\.10%/);
    assert.equal(committed({ slippagePct: '0.10' }).slippageBps, 10);
    assert.throws(() => committed({ cooldownSec: '86401' }), /Cooldown/);
  });
});

describe('wallet overrides', () => {
  it('treats null as inherit and a zero market cap as its own rule', () => {
    const base = committed();
    const inherited = rules.resolveWallet(base, rules.emptyOverride());
    assert.equal(inherited.custom, false);
    assert.equal(inherited.buyUsdCents, 1000);
    assert.equal(inherited.sellMode, 'percent');

    const custom = rules.parseWalletOverride({
      buy: '25',
      minMcap: '0',
      maxMcap: '10000000',
      copyBuys: null,
      copySells: null,
      sellMode: null,
    });
    assert.equal(custom.minMcapUsd, 0);
    assert.equal(rules.isCustomOverride(custom), true);
    assert.equal(rules.resolveWallet(base, custom).buyUsdCents, 2500);

    assert.throws(
      () => rules.assertOverridesFit(base, [rules.parseWalletOverride({ buy: '25' })]),
      /above the maximum per trade/
    );
    const room = committed({ maxPerTrade: '50', maxDaily: '100' });
    assert.doesNotThrow(() => rules.assertOverridesFit(room, [rules.parseWalletOverride({ buy: '25' })]));
  });

  it('round-trips a wallet through the form the screen saves', () => {
    const samples = [
      rules.emptyOverride(),
      rules.parseWalletOverride({ buy: '25' }),
      rules.parseWalletOverride({ minMcap: '0', maxMcap: '5000000' }),
      rules.parseWalletOverride({ sellMode: 'percent' }),
      rules.parseWalletOverride({ sellMode: 'fixed', sellAmount: '5' }),
      rules.parseWalletOverride({ copyBuys: false, copySells: false }),
    ];
    for (const sample of samples) {
      const again = rules.parseWalletOverride(rules.overridePayload(rules.overrideFormFrom(sample)));
      assert.deepEqual(again, sample);
    }
  });

  it('shows the current defaults in a sheet without storing them', () => {
    const shown = {
      minMcap: '50000',
      maxMcap: '5000000',
      copyBuys: true,
      copySells: false,
      sellMode: 'fixed',
      sellAmount: '5',
    };
    const form = rules.overrideFormFrom(rules.emptyOverride(), shown);
    assert.equal(form.useSides, true);
    assert.equal(form.copySells, false);
    assert.equal(form.useSell, true);
    assert.equal(form.sellMode, 'fixed');
    assert.equal(form.sellAmount, '5');
    assert.equal(form.minMcap, '50000');
    assert.deepEqual(rules.parseWalletOverride(rules.overridePayload(form)), rules.emptyOverride());

    const noBound = rules.overrideFormFrom(rules.parseWalletOverride({ minMcap: '0', maxMcap: '0' }), shown);
    assert.equal(noBound.useMcap, false);
    assert.equal(noBound.minMcap, '');
    assert.equal(noBound.maxMcap, '');
  });
});

describe('card text', () => {
  it('shows the range with the word to, and marks a custom wallet', () => {
    const base = committed();
    const plain = rules.walletCardCopy(base, null);
    assert.equal(plain.amount, '$10 / trade');
    assert.equal(plain.range, '$50K to $5M MC');
    assert.equal(plain.note, 'Buy + Sell');

    const custom = rules.walletCardCopy(base, rules.parseWalletOverride({ buy: '25', minMcap: '100000', maxMcap: '10000000' }));
    assert.equal(custom.amount, '$25 / trade');
    assert.equal(custom.range, '$100K to $10M MC');
    assert.equal(custom.note, 'Custom settings');

    const unstarted = rules.walletCardCopy(rules.blankRules(), null);
    assert.equal(unstarted.amount, 'Uses your defaults');
    assert.equal(JSON.stringify([plain, custom, unstarted]).includes('\u2014'), false);
  });
});

describe('columns', () => {
  it('names every rule column the trade read selects', () => {
    const source = fs.readFileSync(path.join(__dirname, '../web/lib/copySetup.ts'), 'utf8');
    const migration = fs.readFileSync(
      path.join(__dirname, '../supabase/migrations/20261005200000_copy_trade_rules.sql'),
      'utf8'
    );
    assert.match(source, /SETUP_RULE_COLUMNS\.join/);
    assert.match(source, /WALLET_RULE_COLUMNS\.join/);
    assert.match(source, /kind === 'trade'/);
    const listed = fs.readFileSync(path.join(__dirname, '../web/lib/copyTradeRules.ts'), 'utf8');
    for (const column of [...rules.SETUP_RULE_COLUMNS, ...rules.WALLET_RULE_COLUMNS]) {
      assert.match(listed, new RegExp(column));
      assert.match(migration, new RegExp(`\\b${column}\\b`));
    }
  });
});
