/**
 * Spending is the chain balance minus Savings. Savings is a book, not a
 * second wallet. These tests pin the line, the chat grammar, and that every
 * spend of the Flizy wallet asks the book.
 *
 * Run: node --test test/reserves.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const bot = require('../lib/reserves');
const { parseReserveMove, isSavingsCommand, isFlizyCommandBody } = require('../lib/commands/parse');
const { canonicalizeCommand } = require('../lib/commandAliases');
const { unsupportedCurrencyCommand } = require('../lib/commands/amount');
const { formatHoldingsMessage } = require('../lib/holdings');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function book(rows, error) {
  return {
    from() {
      return {
        select() {
          return { eq: async () => ({ data: rows, error: error || null }) };
        },
      };
    },
  };
}

const ETH = (n) => ethers.parseEther(String(n));
const TUSD = (n) => ethers.parseUnits(String(n), 6);

describe('available is holding minus savings minus gas', () => {
  it('lands on the line and refuses one unit over', () => {
    assert.equal(bot.covers(10n, 4n, 6n, 0n), true);
    assert.equal(bot.covers(10n, 4n, 7n, 0n), false);
    assert.equal(bot.covers(10n, 4n, 4n, 2n), true);
    assert.equal(bot.covers(10n, 4n, 5n, 2n), false);
    assert.equal(bot.availableBase(10n, 4n, 2n), 4n);
    assert.equal(bot.availableBase(3n, 5n, 1n), 0n);
  });

  it('keeps gas in available only when ETH moves into savings', () => {
    assert.equal(bot.reserveMoveGas('ETH', 'to_savings', 7n), 7n);
    assert.equal(bot.reserveMoveGas('ETH', 'to_spending', 7n), 0n);
    assert.equal(bot.reserveMoveGas('TUSD', 'to_savings', 7n), 0n);
    assert.equal(bot.reserveMoveGas('FLZ', 'to_spending', 7n), 0n);
  });

  it('refuses a negative or a non-integer base unit', () => {
    assert.throws(() => bot.availableBase(-1n, 0n, 0n));
    assert.throws(() => bot.covers('1.5', 0n, 0n, 0n));
  });
});

describe('the fence speaks only when savings is what makes the spend short', () => {
  const account = '00000000-0000-4000-8000-000000000001';

  it('lets a plain shortfall through so the funding wall can speak', async () => {
    const out = await bot.assertSpendable(book([]), account, {
      asset: 'ETH',
      holding: ETH(1),
      amount: ETH(2),
      gas: ETH('0.01'),
      decimals: 18,
      label: 'ETH',
    });
    assert.deepEqual(out, { ok: true });
  });

  it('lets a spend through when savings still leaves enough', async () => {
    const out = await bot.assertSpendable(book([{ asset: 'ETH', amount: ETH(1).toString() }]), account, {
      asset: 'ETH',
      holding: ETH(3),
      amount: ETH(1),
      gas: ETH(1),
      decimals: 18,
      label: 'ETH',
    });
    assert.deepEqual(out, { ok: true });
  });

  it('refuses when the chain balance covers the spend only by using savings', async () => {
    const out = await bot.assertSpendable(book([{ asset: 'ETH', amount: ETH(1).toString() }]), account, {
      asset: 'ETH',
      holding: ETH(2),
      amount: ETH('1.5'),
      gas: 0n,
      decimals: 18,
      label: 'ETH',
    });
    assert.equal(out.ok, false);
    assert.match(out.message, /^Insufficient available balance\.\nAvailable: .+ ETH\nSavings is not included in available funds\.$/);
    assert.doesNotMatch(out.message, /FUND_REASON|account_id|wbqh/);
  });

  it('counts gas against available ETH', async () => {
    const out = await bot.assertSpendable(book([{ asset: 'ETH', amount: ETH(6).toString() }]), account, {
      asset: 'ETH',
      holding: ETH(10),
      amount: ETH(3),
      gas: ETH(2),
      decimals: 18,
      label: 'ETH',
    });
    assert.equal(out.ok, false);
    const open = await bot.assertSpendable(book([{ asset: 'ETH', amount: ETH(6).toString() }]), account, {
      asset: 'ETH',
      holding: ETH(10),
      amount: ETH(2),
      gas: ETH(2),
      decimals: 18,
      label: 'ETH',
    });
    assert.deepEqual(open, { ok: true });
  });

  it('fails open when the table is not there, and closed when the read fails', async () => {
    const missing = await bot.assertSpendable(book(null, { code: 'PGRST205', message: 'account_reserves' }), account, {
      asset: 'ETH',
      holding: ETH(1),
      amount: ETH(1),
      decimals: 18,
      label: 'ETH',
    });
    assert.deepEqual(missing, { ok: true });
    const failed = await bot.assertSpendable(book(null, { code: 'XX000', message: 'connection reset' }), account, {
      asset: 'ETH',
      holding: ETH(5),
      amount: ETH(1),
      decimals: 18,
      label: 'ETH',
    });
    assert.deepEqual(failed, { ok: false, message: 'Could not read Savings. Nothing was sent.' });
  });

  it('fails closed on a row that is not an integer of base units', async () => {
    const out = await bot.assertSpendable(book([{ asset: 'ETH', amount: '1.5' }]), account, {
      asset: 'ETH',
      holding: ETH(5),
      amount: ETH(1),
      decimals: 18,
      label: 'ETH',
    });
    assert.deepEqual(out, { ok: false, message: 'Could not read Savings. Nothing was sent.' });
  });
});

describe('savings display', () => {
  it('subtracts the book from a copy and leaves a bad token row alone', () => {
    const holdings = {
      native: { balance: '1.5', symbol: 'ETH' },
      tokens: [
        { symbol: 'tUSD', balance: '10', decimals: 6 },
        { symbol: 'FLZ', balance: '', decimals: 18 },
        { symbol: 'MAKI', balance: 'not-a-number', decimals: 18 },
      ],
    };
    const next = bot.applyReservesToHoldings(holdings, [
      { asset: 'ETH', amount: ETH('0.5').toString() },
      { asset: 'TUSD', amount: TUSD(4).toString() },
    ]);
    assert.equal(holdings.native.balance, '1.5');
    assert.equal(holdings.tokens[0].balance, '10');
    assert.equal(next.native.balance, '1.0');
    assert.equal(next.tokens[0].balance, '6.0');
    assert.equal(next.tokens[1].balance, '');
    assert.equal(next.tokens[2].balance, 'not-a-number');
  });

  it('clamps a display at zero when the chain read is below the book', () => {
    const next = bot.applyReservesToHoldings(
      { native: { balance: '0.2', symbol: 'ETH' }, tokens: [] },
      [{ asset: 'ETH', amount: ETH(1).toString() }]
    );
    assert.equal(next.native.balance, '0.0');
  });

  it('says savings is not a bank account and does not earn yield', () => {
    const text = bot.formatSavingsMessage([{ asset: 'TUSD', amount: TUSD('1.5').toString() }], null);
    assert.match(text, /^Savings\n/);
    assert.match(text, /tUSD/);
    assert.match(text, /Funds here are not available for normal spending\./);
    assert.match(text, /This is not a bank account and it does not earn yield\./);
    assert.doesNotMatch(text, /savings account/i);
  });

  it('names an empty book', () => {
    assert.match(bot.formatSavingsMessage([], null), /Nothing is in Savings\./);
  });
});

describe('flizy balance shows available and does not mention savings', () => {
  it('opens on Available', () => {
    const text = formatHoldingsMessage({
      credit: '0',
      agentWallet: '0x0000000000000000000000000000000000000001',
      holdings: { native: { balance: '1.25', symbol: 'ETH' }, tokens: [] },
      showCredit: false,
    });
    assert.match(text, /^Available\n/);
    assert.doesNotMatch(text, /Savings|Your balance|Total balance/);
  });
});

describe('move grammar', () => {
  const spend = ['spend', 'spending', 'available'];
  const save = ['savings', 'reserve', 'vault'];

  it('uses the same bucket words as the engine', () => {
    assert.deepEqual([...bot.SPEND_BUCKETS].sort(), [...spend].sort());
    assert.deepEqual([...bot.SAVE_BUCKETS].sort(), [...save].sort());
  });

  it('does not swallow the word from as a ticker', () => {
    const move = parseReserveMove('transfer 5 from spending to savings');
    assert.equal(move.asset, 'ETH');
    assert.equal(move.from, 'spending');
    assert.equal(move.to, 'savings');
    assert.equal(move.direction, 'to_savings');
    assert.equal(move.same, false);
  });

  it('parses an asset and both directions', () => {
    const into = parseReserveMove('transfer 50 USDC from spending to savings');
    assert.equal(into.amount, '50');
    assert.equal(into.asset, 'USDC');
    assert.equal(into.direction, 'to_savings');
    const back = parseReserveMove('transfer 1,000.5 usd from vault to available');
    assert.equal(back.amount, '1000.5');
    assert.equal(back.asset, 'TUSD');
    assert.equal(back.direction, 'to_spending');
  });

  it('treats two words on the same side as no move', () => {
    const same = parseReserveMove('transfer 1 ETH from savings to vault');
    assert.equal(same.same, true);
    assert.equal(same.direction, null);
    assert.equal(same.from, 'savings');
    assert.equal(same.to, 'savings');
  });

  it('leaves a payment to a person for send', () => {
    assert.equal(parseReserveMove('transfer 50 to savings'), null);
    assert.equal(parseReserveMove('transfer 5 to john'), null);
    assert.equal(parseReserveMove('transfer 5 from spending to john'), null);
  });

  it('accepts every bucket word and refuses an unknown one', () => {
    for (const from of spend) {
      for (const to of save) {
        const move = parseReserveMove(`transfer 1 from ${from} to ${to}`);
        assert.equal(move.direction, 'to_savings', `${from} -> ${to}`);
      }
    }
    for (const from of save) {
      for (const to of spend) {
        const move = parseReserveMove(`transfer 1 from ${from} to ${to}`);
        assert.equal(move.direction, 'to_spending', `${from} -> ${to}`);
      }
    }
    assert.equal(parseReserveMove('transfer 1 from wallet to savings'), null);
  });

  it('does not rewrite a real move, and turns transfer-to-savings into a send', () => {
    assert.equal(
      canonicalizeCommand('transfer 50 USDC from spending to savings'),
      'transfer 50 USDC from spending to savings'
    );
    assert.equal(canonicalizeCommand('transfer 50 to savings'), 'send 50 to savings');
    assert.equal(bot.isReserveTarget('savings'), true);
    assert.equal(bot.isReserveTarget('@vault'), true);
    assert.equal(bot.isReserveTarget('reserve'), true);
    assert.equal(bot.isReserveTarget('john'), false);
    assert.equal(bot.isReserveTarget('save'), false);
  });

  it('still refuses a dollar or naira amount, because the move pattern does not take it', () => {
    assert.equal(parseReserveMove('transfer $5 from spending to savings'), null);
    assert.equal(unsupportedCurrencyCommand('transfer $5 from spending to savings'), 'Dollar');
    assert.equal(parseReserveMove('transfer ₦5 from spending to savings'), null);
    assert.equal(unsupportedCurrencyCommand('transfer ₦5 from spending to savings'), 'Naira');
    assert.equal(parseReserveMove('transfer N5000 from spending to savings'), null);
    assert.equal(unsupportedCurrencyCommand('transfer N5000 from spending to savings'), 'Naira');
  });
});

describe('what wakes the bot', () => {
  it('wakes on savings, reserve, vault, and a move', () => {
    assert.equal(isSavingsCommand('savings'), true);
    assert.equal(isSavingsCommand('reserve'), true);
    assert.equal(isSavingsCommand('vault'), true);
    assert.equal(isSavingsCommand('save'), false);
    assert.equal(isFlizyCommandBody('savings'), true);
    assert.equal(isFlizyCommandBody('reserve'), true);
    assert.equal(isFlizyCommandBody('vault'), true);
    assert.equal(isFlizyCommandBody('transfer 2 from spending to savings'), true);
    assert.equal(isFlizyCommandBody('save'), false);
    assert.equal(isFlizyCommandBody('hello'), false);
  });

  it('keeps the parser free of the reserves module', () => {
    const src = read('lib/commands/parse.js');
    assert.doesNotMatch(src, /require\(['"][^'"]*reserves/);
    assert.doesNotMatch(read('lib/commands/pending.js'), /reservesChat/);
  });
});

describe('listed dollars use six decimals on both sides', () => {
  it('resolves usd to tUSD', () => {
    const info = bot.resolveReserveAsset('usd');
    assert.equal(info.asset, 'TUSD');
    assert.equal(info.decimals, 6);
    assert.equal(info.label, 'tUSD');
    assert.equal(bot.resolveReserveAsset('FLZ', null), null);
    assert.equal(bot.resolveReserveAsset('NOPE'), null);
  });
});

describe('every spend of the Flizy wallet asks the book', () => {
  const calls = [
    'lib/engine/executeTransfer.js',
    'lib/engine/executeSwap.js',
    'lib/engine/executeClaim.js',
    'lib/engine/executeAcceptOffer.js',
    'lib/listedNfts.js',
    'web/app/api/pay/execute/route.ts',
    'web/app/api/pay/swap/route.ts',
    'web/app/api/swap/execute/route.ts',
    'web/app/api/swap/liquidity/route.ts',
    'web/lib/marketExecute.ts',
    'web/lib/ammora/siteSwap.ts',
  ];

  it('calls assertSpendable at the mutation', () => {
    for (const rel of calls) {
      assert.match(read(rel), /assertSpendable\(/, rel);
    }
    assert.match(read('lib/handlers/claims.js'), /refusePlanSpend\(/);
  });

  it('does not mark a savings refusal as a funding-wall failure', () => {
    for (const rel of [
      'lib/engine/executeTransfer.js',
      'lib/engine/executeSwap.js',
      'lib/engine/executeAcceptOffer.js',
    ]) {
      const src = read(rel);
      assert.match(src, /insufficient available balance/);
      const fence = src.match(/if \(!fence\.ok\) \{[\s\S]{0,700}?error: fence\.message/);
      assert.ok(fence, rel);
      assert.doesNotMatch(fence[0], /FUND_REASON/, rel);
    }
  });

  it('fences a liquidity add and leaves a removal alone', () => {
    const src = read('web/app/api/swap/liquidity/route.ts');
    const remove = src.slice(src.indexOf("if (action === 'remove')"), src.indexOf('// add (default)'));
    const add = src.slice(src.indexOf('// add (default)'));
    assert.doesNotMatch(remove, /assertSpendable\(/);
    assert.match(add, /assertSpendable\(/);
  });

  it('fences a logged-in marketplace action and a mint, and not a wallet plan', () => {
    const market = read('web/app/api/market/[action]/route.ts');
    const post = market.slice(market.indexOf('export async function POST'));
    assert.ok(post.indexOf("get('plan') === '1'") < post.indexOf('assertCanPay('));
    assert.match(post, /assertCanPay\(ctx\.provider, viewer, plan\.value, plan\.calls\.length, \{ supabase, accountId \}\)/);
    const plan = market.slice(market.indexOf('async function planForWallet'), market.indexOf('export async function POST'));
    assert.doesNotMatch(plan, /assertSpendable\(|account_reserves/);
    assert.match(
      read('web/lib/mintExecute.ts'),
      /assertCanPay\(ctx\.provider, viewer, tx\.value, tx\.calls\.length, \{ supabase, accountId \}\)/
    );
  });

  it('stores a swap refusal as not sent, not the sentence shown to the person', () => {
    const src = read('web/app/api/swap/execute/route.ts');
    const fence = src.slice(src.indexOf('const markNotSent'), src.indexOf('const result = viaGator'));
    assert.match(fence, /assertSpendable\(/);
    assert.match(fence, /error: 'not sent'/);
    assert.match(fence, /return NextResponse\.json\(\{ error: fence\.message \}, \{ status: 400 \}\)/);
  });

  it('prefers a pending send over a pending move, and cancel of a move says so', () => {
    const src = read('lib/router.js');
    const confirm = src.slice(src.indexOf('if (isConfirmCommand(text))'), src.indexOf('if (isConfirmCommand(text))') + 900);
    assert.ok(confirm.indexOf('pendingSends.has(ctx.key)') < confirm.indexOf('hasPendingMove(ctx.key)'));
    assert.match(confirm, /clearPendingMove\(ctx\.key\)/);
    assert.match(confirm, /confirmReserveMove\(ctx, account\)/);
    assert.match(src, /Move cancelled\. Nothing was moved\./);
    const dispatch = src.slice(src.indexOf('const move = parseReserveMove(text)'), src.indexOf('const unpriced = unsupportedCurrencyCommand'));
    assert.match(dispatch, /beginReserveMove/);
  });
});

describe('the site mirror agrees with the engine', () => {
  let webMath;
  let webStore;

  before(async () => {
    webMath = await import('../web/lib/reservesMath.ts');
    webStore = await import('../web/lib/reserveStore.ts');
  });

  it('computes the same available, cover, and gas', () => {
    const vectors = [
      [0n, 0n, 0n, 0n],
      [ETH(1), ETH('0.4'), ETH('0.5'), ETH('0.1')],
      [TUSD(10), TUSD('2.5'), TUSD('7.5'), 0n],
      [5n, 9n, 1n, 1n],
    ];
    for (const [holding, reserved, amount, gas] of vectors) {
      assert.equal(webMath.availableBase(holding, reserved, gas), bot.availableBase(holding, reserved, gas));
      assert.equal(webMath.covers(holding, reserved, amount, gas), bot.covers(holding, reserved, amount, gas));
    }
    assert.equal(webMath.reserveMoveGas('ETH', 'to_savings', 9n), bot.reserveMoveGas('ETH', 'to_savings', 9n));
    assert.equal(webMath.reserveMoveGas('TUSD', 'to_savings', 9n), 0n);
    assert.equal(webMath.reserveMoveGas('ETH', 'to_spending', 9n), 0n);
  });

  it('parses tUSD the way ethers does, and refuses a longer fraction', () => {
    for (const text of ['0', '1', '1.5', '0.000001', '10.123456']) {
      assert.equal(webMath.parseUnits(text, 6), ethers.parseUnits(text, 6));
    }
    for (const text of ['0', '1.0', '0.000000000000000001']) {
      assert.equal(webMath.parseUnits(text, 18), ethers.parseUnits(text, 18));
    }
    assert.throws(() => webMath.parseUnits('1.1234567', 6));
    assert.throws(() => ethers.parseUnits('1.1234567', 6));
    assert.throws(() => webMath.parseUnits('1,000', 6));
    assert.throws(() => webMath.parseUnits('1e6', 6));
  });

  it('names the same assets and the same refusal', async () => {
    const usd = webStore.resolveReserveAsset('usd');
    const botUsd = bot.resolveReserveAsset('usd');
    assert.equal(usd.asset, botUsd.asset);
    assert.equal(usd.decimals, 6);
    assert.equal(usd.label, 'tUSD');
    assert.equal(webStore.resolveReserveAsset('NOPE'), null);
    const flz = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
    assert.equal(webStore.resolveReserveAsset('FLZ', flz).asset, bot.resolveReserveAsset('FLZ', { flzToken: flz }).asset);
    for (const word of ['savings', 'reserve', 'vault', 'spend', 'spending', 'available']) {
      assert.equal(webStore.isReserveTarget(word), bot.isReserveTarget(word), word);
    }
    assert.equal(webStore.isReserveTarget('save'), false);

    const account = '00000000-0000-4000-8000-000000000001';
    const spec = {
      asset: 'TUSD',
      holding: TUSD(10),
      amount: TUSD(8),
      gas: 0n,
      decimals: 6,
      label: 'tUSD',
    };
    const rows = [{ asset: 'TUSD', amount: TUSD(4).toString() }];
    const left = await bot.assertSpendable(book(rows), account, spec);
    const right = await webStore.assertSpendable(book(rows), account, spec);
    assert.equal(left.ok, false);
    assert.equal(right.message, left.message);
    assert.match(left.message, /Available: .+ tUSD/);

    const move = { label: 'tUSD', holding: TUSD(10), reserved: TUSD(4), gas: 0n, decimals: 6 };
    assert.equal(
      webStore.mapReserveMoveError({ message: 'insufficient savings' }, move).message,
      bot.mapReserveMoveError({ message: 'insufficient savings' }, move).message
    );
    assert.match(bot.mapReserveMoveError({ message: 'insufficient savings' }, move).message, /Insufficient Savings balance\./);
    assert.equal(
      webStore.mapReserveMoveError({ message: 'something else' }, move).message,
      'Could not move that. Nothing changed.'
    );
  });

  it('shows the same helper on the card', () => {
    const card = read('web/components/SavingsCard.tsx');
    assert.match(card, /SAVINGS_HELPER/);
    assert.match(card, /To Savings/);
    assert.match(card, /To Spending/);
    assert.match(read('web/lib/reservesMath.ts'), /This is not a bank account and it does not earn yield\./);
    assert.match(read('web/components/WalletBalances.tsx'), />Available</);
    assert.match(read('web/app/dashboard/page.tsx'), />Available</);
  });
});
