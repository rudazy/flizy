/**
 * Dollar rules for copy trade.
 *
 * This file parses, checks and formats the rules. It does not watch a chain
 * and it does not submit a transaction. A saved rule is a preference. The
 * screen that stores it has to say that copying does not run.
 *
 * Buys are a fixed dollar amount. Sells are either the same percentage of the
 * copied position, or a fixed dollar amount. A wallet with every override
 * null uses the account defaults. A zero market cap on a wallet is an
 * explicit "no bound", which is different from null (use the default).
 */

import { ClientError } from './apiError.ts';

export type SellMode = 'percent' | 'fixed';

export type CopyTradeRules = {
  buyUsdCents: number;
  minMcapUsd: number;
  maxMcapUsd: number;
  copyBuys: boolean;
  copySells: boolean;
  sellMode: SellMode;
  sellUsdCents: number;
  maxTradeUsdCents: number;
  maxDailyUsdCents: number;
  maxOpenPositions: number;
  ignoreStablecoins: boolean;
  firstBuyOnly: boolean;
  skipLiquidity: boolean;
  skipTransfers: boolean;
  skipFailed: boolean;
  slippageBps: number;
  cooldownSec: number;
  minTokenAgeMin: number;
  minLiquidityUsd: number;
  maxGasGwei: number;
  walletDailyCap: number;
  /** True once a full rule set has been saved. Zero cents is not a saved $10. */
  ready: boolean;
};

export type WalletOverride = {
  buyUsdCents: number | null;
  minMcapUsd: number | null;
  maxMcapUsd: number | null;
  copyBuys: boolean | null;
  copySells: boolean | null;
  sellMode: SellMode | null;
  sellUsdCents: number | null;
};

export type ResolvedWallet = {
  buyUsdCents: number;
  minMcapUsd: number;
  maxMcapUsd: number;
  copyBuys: boolean;
  copySells: boolean;
  sellMode: SellMode;
  sellUsdCents: number;
  custom: boolean;
};

/** Columns added for trade rules. The select list has to name every one. */
export const SETUP_RULE_COLUMNS = [
  'buy_usd_cents',
  'min_mcap_usd',
  'max_mcap_usd',
  'sell_mode',
  'sell_usd_cents',
  'max_trade_usd_cents',
  'max_daily_usd_cents',
  'max_open_positions',
  'ignore_stablecoins',
  'first_buy_only',
  'skip_liquidity',
  'skip_transfers',
  'skip_failed',
  'cooldown_sec',
  'min_token_age_min',
  'min_liquidity_usd',
  'max_gas_gwei',
  'wallet_daily_cap',
] as const;

export const WALLET_RULE_COLUMNS = [
  'buy_usd_cents',
  'min_mcap_usd',
  'max_mcap_usd',
  'copy_buys',
  'copy_sells',
  'sell_mode',
  'sell_usd_cents',
] as const;

export const RULES_NOT_INSTALLED = 'Copy trade rules are not installed on this database yet.';

const MONEY_MAX_CENTS = 100_000_000;
const MCAP_MAX_USD = 1_000_000_000_000;
/** Reject a pasted blob before it becomes a bigint. Valid amounts fit well under this. */
const MONEY_TEXT_MAX = 40;

const MCAP_MULT: Record<string, bigint> = {
  '': 1n,
  k: 1_000n,
  m: 1_000_000n,
  b: 1_000_000_000n,
  t: 1_000_000_000_000n,
};

export const SUGGESTED_RULES = {
  buy: '10',
  minMcap: '50000',
  maxMcap: '5000000',
  copyBuys: true,
  copySells: true,
  sellMode: 'percent' as SellMode,
  sellAmount: '',
  maxPerTrade: '10',
  maxDaily: '100',
  maxOpenPositions: '10',
  ignoreStablecoins: true,
  firstBuyOnly: false,
  skipLiquidity: true,
  skipTransfers: true,
  skipFailed: true,
  slippagePct: '1',
  cooldownSec: '0',
  minTokenAgeMin: '0',
  minLiquidity: '',
  maxGasGwei: '',
  walletDailyCap: '0',
};

export type RuleForm = typeof SUGGESTED_RULES;

export type OverrideForm = {
  useBuy: boolean;
  buy: string;
  useMcap: boolean;
  minMcap: string;
  maxMcap: string;
  useSides: boolean;
  copyBuys: boolean;
  copySells: boolean;
  useSell: boolean;
  sellMode: SellMode;
  sellAmount: string;
};

export function emptyOverride(): WalletOverride {
  return {
    buyUsdCents: null,
    minMcapUsd: null,
    maxMcapUsd: null,
    copyBuys: null,
    copySells: null,
    sellMode: null,
    sellUsdCents: null,
  };
}

export function blankRules(): CopyTradeRules {
  return {
    buyUsdCents: 0,
    minMcapUsd: 0,
    maxMcapUsd: 0,
    copyBuys: true,
    copySells: true,
    sellMode: 'percent',
    sellUsdCents: 0,
    maxTradeUsdCents: 0,
    maxDailyUsdCents: 0,
    maxOpenPositions: 0,
    ignoreStablecoins: true,
    firstBuyOnly: false,
    skipLiquidity: true,
    skipTransfers: true,
    skipFailed: true,
    slippageBps: 100,
    cooldownSec: 0,
    minTokenAgeMin: 0,
    minLiquidityUsd: 0,
    maxGasGwei: 0,
    walletDailyCap: 0,
    ready: false,
  };
}

export function isMissingRulesColumn(message: string): boolean {
  return (
    /buy_usd_cents|min_mcap_usd|max_mcap_usd|sell_mode|sell_usd_cents|max_trade_usd_cents|max_daily_usd_cents|max_open_positions|ignore_stablecoins|first_buy_only|skip_liquidity|skip_transfers|skip_failed|cooldown_sec|min_token_age_min|min_liquidity_usd|max_gas_gwei|wallet_daily_cap/.test(
      message
    ) && /does not exist|schema cache|could not find/i.test(message)
  );
}

function moneyTooLarge(label: string): ClientError {
  return new ClientError(`${label} must be $1,000,000 or less.`);
}

/**
 * Dollars to cents. Empty is 0. Accepts 10, $10, 10.50, 1,000 and a k or m
 * suffix. At most two decimal places. No float is stored: the result is an
 * integer number of cents.
 */
function moneyText(raw: unknown, label: string): string {
  if (typeof raw !== 'string') throw new ClientError(`${label} needs to be a dollar amount.`);
  const stripped = raw.trim().replace(/[$,\s]/g, '').toLowerCase();
  if (stripped.length > MONEY_TEXT_MAX) throw new ClientError(`${label} needs to be a dollar amount.`);
  return stripped;
}

export function parseUsdCents(raw: unknown, label: string): number {
  const stripped = moneyText(raw, label);
  if (!stripped) return 0;
  const match = /^(\d+)(?:\.(\d+))?([km])?$/.exec(stripped);
  if (!match) throw new ClientError(`${label} needs to be a dollar amount.`);
  const whole = match[1];
  const frac = match[2] ?? '';
  const suffix = match[3] ?? '';
  if (frac.length > 2) throw new ClientError(`${label} can use at most 2 decimal places.`);
  if (whole.length > 12) throw moneyTooLarge(label);
  const mult = suffix === 'k' ? 1_000n : suffix === 'm' ? 1_000_000n : 1n;
  const cents = (BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'))) * mult;
  if (cents > BigInt(MONEY_MAX_CENTS)) throw moneyTooLarge(label);
  return Number(cents);
}

function requireMoney(raw: unknown, label: string): number {
  const cents = parseUsdCents(raw, label);
  if (cents < 100) throw new ClientError(`${label} must be at least $1.`);
  return cents;
}

/** Whole dollars. Empty or 0 means no bound. k, m, b and t are allowed. */
export function parseMcapUsd(raw: unknown, label: string): number {
  if (raw == null) return 0;
  const stripped = moneyText(raw, label);
  if (!stripped || stripped === '0') return 0;
  const match = /^(\d+)(?:\.(\d+))?([kmbt])?$/.exec(stripped);
  if (!match) throw new ClientError(`${label} needs to be a dollar amount.`);
  const frac = match[2] ?? '';
  const suffix = match[3] ?? '';
  if (!suffix && frac.length > 0) throw new ClientError(`${label} needs to be a whole dollar amount.`);
  if (frac.length > 2) throw new ClientError(`${label} can use at most 2 decimal places.`);
  const mult = MCAP_MULT[suffix];
  const scaled = (BigInt(match[1]) * 100n + BigInt((frac + '00').slice(0, 2))) * mult;
  if (scaled % 100n !== 0n) throw new ClientError(`${label} needs to be a whole dollar amount.`);
  const dollars = scaled / 100n;
  if (dollars > BigInt(MCAP_MAX_USD)) throw new ClientError(`${label} is too large.`);
  return Number(dollars);
}

export function parseSlippageBps(raw: unknown): number {
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return 100;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (text.length > MONEY_TEXT_MAX || !/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new ClientError('Slippage must be between 0.10% and 10%.');
  }
  const bps = Math.round(Number(text) * 100);
  if (!Number.isInteger(bps) || bps < 10 || bps > 1000) {
    throw new ClientError('Slippage must be between 0.10% and 10%.');
  }
  return bps;
}

function requireBool(value: unknown, message: string): boolean {
  if (typeof value !== 'boolean') throw new ClientError(message);
  return value;
}

function optionalBool(value: unknown, message: string): boolean | null {
  if (value == null) return null;
  return requireBool(value, message);
}

function parseSellMode(value: unknown): SellMode {
  if (value === 'percent' || value === 'fixed') return value;
  throw new ClientError('Choose sell same percentage or a fixed sell amount.');
}

function parseWhole(raw: unknown, label: string, min: number, max: number, whenEmpty: number | null): number {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    if (whenEmpty == null) throw new ClientError(`${label} must be from ${min} to ${max}.`);
    return whenEmpty;
  }
  const text = typeof raw === 'number' && Number.isInteger(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,12}$/.test(text)) throw new ClientError(`${label} must be a whole number from ${min} to ${max}.`);
  const n = Number(text);
  if (n < min || n > max) throw new ClientError(`${label} must be from ${min} to ${max}.`);
  return n;
}

function asRecord(raw: unknown, message: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ClientError(message);
  return raw as Record<string, unknown>;
}

function mcapOrder(min: number, max: number) {
  if (min > 0 && max > 0 && max < min) {
    throw new ClientError('Maximum market cap is below the minimum.');
  }
}

/** A full save. Omitted advanced fields use the safe defaults. */
export function parseCommittedRules(raw: unknown): CopyTradeRules {
  const input = asRecord(raw, 'Enter the copy settings again.');
  const buyUsdCents = requireMoney(input.buy, 'Amount per trade');
  const minMcapUsd = parseMcapUsd(input.minMcap == null ? '' : input.minMcap, 'Minimum market cap');
  const maxMcapUsd = parseMcapUsd(input.maxMcap == null ? '' : input.maxMcap, 'Maximum market cap');
  mcapOrder(minMcapUsd, maxMcapUsd);

  const copyBuys = requireBool(input.copyBuys, 'Choose whether buys are copied.');
  const copySells = requireBool(input.copySells, 'Choose whether sells are copied.');
  const sellMode = parseSellMode(input.sellMode);
  const sellUsdCents = sellMode === 'fixed' ? requireMoney(input.sellAmount, 'Sell amount') : 0;

  const maxTradeUsdCents = requireMoney(input.maxPerTrade, 'Maximum per trade');
  if (buyUsdCents > maxTradeUsdCents) {
    throw new ClientError('Amount per trade is above the maximum per trade.');
  }
  if (sellUsdCents > maxTradeUsdCents) {
    throw new ClientError('Sell amount is above the maximum per trade.');
  }

  const maxDailyUsdCents = requireMoney(input.maxDaily, 'Maximum daily spend');
  if (maxDailyUsdCents < maxTradeUsdCents) {
    throw new ClientError('Maximum daily spend is below the maximum per trade.');
  }

  const maxOpenPositions = parseWhole(input.maxOpenPositions, 'Open positions', 1, 100, null);
  const minLiquidityUsd = parseMcapUsd(
    input.minLiquidity == null ? '' : input.minLiquidity,
    'Minimum liquidity'
  );

  return {
    buyUsdCents,
    minMcapUsd,
    maxMcapUsd,
    copyBuys,
    copySells,
    sellMode,
    sellUsdCents,
    maxTradeUsdCents,
    maxDailyUsdCents,
    maxOpenPositions,
    ignoreStablecoins: requireBool(
      input.ignoreStablecoins == null ? true : input.ignoreStablecoins,
      'Choose whether stablecoins are ignored.'
    ),
    firstBuyOnly: requireBool(
      input.firstBuyOnly == null ? false : input.firstBuyOnly,
      'Choose whether only the first buy is copied.'
    ),
    skipLiquidity: requireBool(
      input.skipLiquidity == null ? true : input.skipLiquidity,
      'Choose whether liquidity moves are skipped.'
    ),
    skipTransfers: requireBool(
      input.skipTransfers == null ? true : input.skipTransfers,
      'Choose whether transfers are skipped.'
    ),
    skipFailed: requireBool(
      input.skipFailed == null ? true : input.skipFailed,
      'Choose whether failed trades are skipped.'
    ),
    slippageBps: parseSlippageBps(input.slippagePct),
    cooldownSec: parseWhole(input.cooldownSec, 'Cooldown (seconds)', 0, 86400, 0),
    minTokenAgeMin: parseWhole(input.minTokenAgeMin, 'Minimum token age (minutes)', 0, 525600, 0),
    minLiquidityUsd,
    maxGasGwei: parseWhole(input.maxGasGwei, 'Max gas (gwei)', 0, 100000, 0),
    walletDailyCap: parseWhole(input.walletDailyCap, 'Daily cap for one wallet', 0, 1000, 0),
    ready: true,
  };
}

/** Null fields mean "use the default". A present mcap string of 0 means no bound. */
export function parseWalletOverride(raw: unknown): WalletOverride {
  if (raw == null) return emptyOverride();
  const row = asRecord(raw, 'Wallet settings were not readable.');
  const sellMode = row.sellMode == null ? null : parseSellMode(row.sellMode);
  let sellUsdCents: number | null = null;
  if (sellMode === 'fixed') {
    sellUsdCents = requireMoney(row.sellAmount, 'Sell amount');
  } else if (sellMode == null && row.sellAmount != null && String(row.sellAmount).trim() !== '') {
    throw new ClientError('Choose how this wallet sells.');
  }
  const minMcapUsd = row.minMcap == null ? null : parseMcapUsd(row.minMcap, 'Minimum market cap');
  const maxMcapUsd = row.maxMcap == null ? null : parseMcapUsd(row.maxMcap, 'Maximum market cap');
  if (minMcapUsd != null && maxMcapUsd != null) mcapOrder(minMcapUsd, maxMcapUsd);
  const copyBuys = optionalBool(row.copyBuys, 'Choose whether buys are copied.');
  const copySells = optionalBool(row.copySells, 'Choose whether sells are copied.');
  if ((copyBuys == null) !== (copySells == null)) {
    throw new ClientError('Choose whether buys and sells are copied.');
  }
  return {
    buyUsdCents: row.buy == null ? null : requireMoney(row.buy, 'Custom amount'),
    minMcapUsd,
    maxMcapUsd,
    copyBuys,
    copySells,
    sellMode,
    sellUsdCents,
  };
}

export function isCustomOverride(override: WalletOverride | null): boolean {
  if (!override) return false;
  return (
    override.buyUsdCents != null ||
    override.minMcapUsd != null ||
    override.maxMcapUsd != null ||
    override.copyBuys != null ||
    override.copySells != null ||
    override.sellMode != null ||
    override.sellUsdCents != null
  );
}

export function resolveWallet(rules: CopyTradeRules, override: WalletOverride | null): ResolvedWallet {
  const over = override ?? emptyOverride();
  const sellMode = over.sellMode ?? rules.sellMode;
  return {
    buyUsdCents: over.buyUsdCents ?? rules.buyUsdCents,
    minMcapUsd: over.minMcapUsd ?? rules.minMcapUsd,
    maxMcapUsd: over.maxMcapUsd ?? rules.maxMcapUsd,
    copyBuys: over.copyBuys ?? rules.copyBuys,
    copySells: over.copySells ?? rules.copySells,
    sellMode,
    sellUsdCents: sellMode === 'percent' ? 0 : (over.sellUsdCents ?? rules.sellUsdCents),
    custom: isCustomOverride(override),
  };
}

/** Resolved custom amounts have to sit inside the global per-trade maximum. */
export function assertOverridesFit(rules: CopyTradeRules, overrides: Array<WalletOverride | null>) {
  for (const override of overrides) {
    if (!override) continue;
    const resolved = resolveWallet(rules, override);
    if (rules.maxTradeUsdCents > 0 && resolved.buyUsdCents > rules.maxTradeUsdCents) {
      throw new ClientError('A wallet amount is above the maximum per trade.');
    }
    if (
      rules.maxTradeUsdCents > 0 &&
      resolved.sellMode === 'fixed' &&
      resolved.sellUsdCents > rules.maxTradeUsdCents
    ) {
      throw new ClientError('A wallet sell amount is above the maximum per trade.');
    }
    mcapOrder(resolved.minMcapUsd, resolved.maxMcapUsd);
  }
}

function intField(row: Record<string, unknown>, key: string, fallback: number): number {
  const value = row[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  return fallback;
}

function nullableInt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

function flag(row: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (row[key] == null) return fallback;
  return row[key] === true;
}

export function rulesFromRow(row: Record<string, unknown> | null): CopyTradeRules | null {
  if (!row) return null;
  const buyUsdCents = intField(row, 'buy_usd_cents', 0);
  const maxTradeUsdCents = intField(row, 'max_trade_usd_cents', 0);
  const maxDailyUsdCents = intField(row, 'max_daily_usd_cents', 0);
  const maxOpenPositions = intField(row, 'max_open_positions', 0);
  const sellMode: SellMode = row.sell_mode === 'fixed' ? 'fixed' : 'percent';
  const sellUsdCents = intField(row, 'sell_usd_cents', 0);
  const ready =
    buyUsdCents >= 100 &&
    maxTradeUsdCents >= buyUsdCents &&
    maxDailyUsdCents >= maxTradeUsdCents &&
    maxOpenPositions >= 1 &&
    maxOpenPositions <= 100 &&
    (sellMode !== 'fixed' || sellUsdCents >= 100);
  return {
    buyUsdCents,
    minMcapUsd: intField(row, 'min_mcap_usd', 0),
    maxMcapUsd: intField(row, 'max_mcap_usd', 0),
    copyBuys: flag(row, 'copy_buys', true),
    copySells: flag(row, 'copy_sells', false),
    sellMode,
    sellUsdCents,
    maxTradeUsdCents,
    maxDailyUsdCents,
    maxOpenPositions,
    ignoreStablecoins: flag(row, 'ignore_stablecoins', true),
    firstBuyOnly: flag(row, 'first_buy_only', false),
    skipLiquidity: flag(row, 'skip_liquidity', true),
    skipTransfers: flag(row, 'skip_transfers', true),
    skipFailed: flag(row, 'skip_failed', true),
    slippageBps: intField(row, 'slippage_bps', 100),
    cooldownSec: intField(row, 'cooldown_sec', 0),
    minTokenAgeMin: intField(row, 'min_token_age_min', 0),
    minLiquidityUsd: intField(row, 'min_liquidity_usd', 0),
    maxGasGwei: intField(row, 'max_gas_gwei', 0),
    walletDailyCap: intField(row, 'wallet_daily_cap', 0),
    ready,
  };
}

export function overrideFromRow(row: Record<string, unknown>): WalletOverride {
  const sellMode: SellMode | null = row.sell_mode == null ? null : row.sell_mode === 'fixed' ? 'fixed' : row.sell_mode === 'percent' ? 'percent' : null;
  return {
    buyUsdCents: nullableInt(row, 'buy_usd_cents'),
    minMcapUsd: nullableInt(row, 'min_mcap_usd'),
    maxMcapUsd: nullableInt(row, 'max_mcap_usd'),
    copyBuys: row.copy_buys == null ? null : row.copy_buys === true,
    copySells: row.copy_sells == null ? null : row.copy_sells === true,
    sellMode,
    sellUsdCents: nullableInt(row, 'sell_usd_cents'),
  };
}

export function rulesToColumns(rules: CopyTradeRules): Record<string, string | number | boolean> {
  return {
    buy_usd_cents: rules.buyUsdCents,
    min_mcap_usd: rules.minMcapUsd,
    max_mcap_usd: rules.maxMcapUsd,
    sell_mode: rules.sellMode,
    sell_usd_cents: rules.sellUsdCents,
    max_trade_usd_cents: rules.maxTradeUsdCents,
    max_daily_usd_cents: rules.maxDailyUsdCents,
    max_open_positions: rules.maxOpenPositions,
    ignore_stablecoins: rules.ignoreStablecoins,
    first_buy_only: rules.firstBuyOnly,
    skip_liquidity: rules.skipLiquidity,
    skip_transfers: rules.skipTransfers,
    skip_failed: rules.skipFailed,
    cooldown_sec: rules.cooldownSec,
    min_token_age_min: rules.minTokenAgeMin,
    min_liquidity_usd: rules.minLiquidityUsd,
    max_gas_gwei: rules.maxGasGwei,
    wallet_daily_cap: rules.walletDailyCap,
    copy_buys: rules.copyBuys,
    copy_sells: rules.copySells,
    slippage_bps: rules.slippageBps,
  };
}

export function overrideToColumns(override: WalletOverride): Record<string, string | number | boolean | null> {
  return {
    buy_usd_cents: override.buyUsdCents,
    min_mcap_usd: override.minMcapUsd,
    max_mcap_usd: override.maxMcapUsd,
    copy_buys: override.copyBuys,
    copy_sells: override.copySells,
    sell_mode: override.sellMode,
    sell_usd_cents: override.sellUsdCents,
  };
}

export function formatUsdFromCents(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.max(0, Math.trunc(cents)) : 0;
  const dollars = Math.floor(safe / 100);
  const frac = safe % 100;
  const grouped = dollars.toLocaleString('en-US');
  return frac === 0 ? `$${grouped}` : `$${grouped}.${String(frac).padStart(2, '0')}`;
}

export function centsToInput(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.max(0, Math.trunc(cents)) : 0;
  const dollars = Math.floor(safe / 100);
  const frac = safe % 100;
  return frac === 0 ? String(dollars) : `${dollars}.${String(frac).padStart(2, '0')}`;
}

export function formatCompactUsd(dollars: number): string {
  const n = Number.isFinite(dollars) ? Math.max(0, Math.trunc(dollars)) : 0;
  if (n === 0) return '$0';
  const units: Array<[number, string]> = [
    [1_000_000_000_000, 'T'],
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (n < size) continue;
    const rounded = Math.round((n / size) * 100) / 100;
    const text = Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
    return `$${text}${suffix}`;
  }
  return `$${n.toLocaleString('en-US')}`;
}

export function formatMcapRange(min: number, max: number): string {
  if (min > 0 && max > 0) return `${formatCompactUsd(min)} to ${formatCompactUsd(max)}`;
  if (min > 0) return `${formatCompactUsd(min)} and up`;
  if (max > 0) return `Up to ${formatCompactUsd(max)}`;
  return 'Any market cap';
}

export function sideLabel(copyBuys: boolean, copySells: boolean, custom: boolean): string {
  if (custom) return 'Custom settings';
  if (copyBuys && copySells) return 'Buy + Sell';
  if (copyBuys) return 'Buy';
  if (copySells) return 'Sell';
  return 'Off';
}

export function walletCardCopy(rules: CopyTradeRules | null, override: WalletOverride | null): {
  amount: string;
  range: string;
  note: string;
} {
  if (!rules || !rules.ready) {
    if (override && isCustomOverride(override) && override.buyUsdCents != null) {
      return {
        amount: `${formatUsdFromCents(override.buyUsdCents)} / trade`,
        range: '',
        note: 'Custom settings',
      };
    }
    if (override && isCustomOverride(override)) {
      return { amount: 'Uses your defaults', range: '', note: 'Custom settings' };
    }
    return { amount: 'Uses your defaults', range: '', note: '' };
  }
  const resolved = resolveWallet(rules, override);
  const range = formatMcapRange(resolved.minMcapUsd, resolved.maxMcapUsd);
  return {
    amount: `${formatUsdFromCents(resolved.buyUsdCents)} / trade`,
    range: range === 'Any market cap' ? range : `${range} MC`,
    note: sideLabel(resolved.copyBuys, resolved.copySells, resolved.custom),
  };
}

export function formFromRules(rules: CopyTradeRules | null): RuleForm {
  if (!rules || !rules.ready) return { ...SUGGESTED_RULES };
  return {
    buy: centsToInput(rules.buyUsdCents),
    minMcap: rules.minMcapUsd ? String(rules.minMcapUsd) : '',
    maxMcap: rules.maxMcapUsd ? String(rules.maxMcapUsd) : '',
    copyBuys: rules.copyBuys,
    copySells: rules.copySells,
    sellMode: rules.sellMode,
    sellAmount: rules.sellMode === 'fixed' ? centsToInput(rules.sellUsdCents) : '',
    maxPerTrade: centsToInput(rules.maxTradeUsdCents),
    maxDaily: centsToInput(rules.maxDailyUsdCents),
    maxOpenPositions: String(rules.maxOpenPositions),
    ignoreStablecoins: rules.ignoreStablecoins,
    firstBuyOnly: rules.firstBuyOnly,
    skipLiquidity: rules.skipLiquidity,
    skipTransfers: rules.skipTransfers,
    skipFailed: rules.skipFailed,
    slippagePct: String(rules.slippageBps / 100),
    cooldownSec: String(rules.cooldownSec),
    minTokenAgeMin: String(rules.minTokenAgeMin),
    minLiquidity: rules.minLiquidityUsd ? String(rules.minLiquidityUsd) : '',
    maxGasGwei: rules.maxGasGwei ? String(rules.maxGasGwei) : '',
    walletDailyCap: String(rules.walletDailyCap),
  };
}

/**
 * The open sheet shows inherited defaults in the custom fields so turning
 * "use default" off does not flip a sell on or clear a market-cap range.
 * `useBuy` and the other use-flags stay true while the wallet still inherits,
 * and `overridePayload` therefore still sends null.
 */
export function overrideFormFrom(
  override: WalletOverride | null,
  inherited?: {
    minMcap: string;
    maxMcap: string;
    copyBuys: boolean;
    copySells: boolean;
    sellMode: SellMode;
    sellAmount: string;
  }
): OverrideForm {
  const over = override ?? emptyOverride();
  return {
    useBuy: over.buyUsdCents == null,
    buy: over.buyUsdCents == null ? '' : centsToInput(over.buyUsdCents),
    useMcap: over.minMcapUsd == null && over.maxMcapUsd == null,
    minMcap: over.minMcapUsd == null ? inherited?.minMcap ?? '' : over.minMcapUsd ? String(over.minMcapUsd) : '',
    maxMcap: over.maxMcapUsd == null ? inherited?.maxMcap ?? '' : over.maxMcapUsd ? String(over.maxMcapUsd) : '',
    useSides: over.copyBuys == null && over.copySells == null,
    copyBuys: over.copyBuys ?? inherited?.copyBuys ?? true,
    copySells: over.copySells ?? inherited?.copySells ?? true,
    useSell: over.sellMode == null,
    sellMode: over.sellMode ?? inherited?.sellMode ?? 'percent',
    sellAmount:
      over.sellUsdCents != null
        ? centsToInput(over.sellUsdCents)
        : over.sellMode === 'fixed'
          ? ''
          : over.sellMode == null && inherited?.sellMode === 'fixed'
            ? inherited.sellAmount
            : '',
  };
}

export function overridePayload(form: OverrideForm): Record<string, string | boolean | null> {
  return {
    buy: form.useBuy ? null : form.buy,
    minMcap: form.useMcap ? null : form.minMcap,
    maxMcap: form.useMcap ? null : form.maxMcap,
    copyBuys: form.useSides ? null : form.copyBuys,
    copySells: form.useSides ? null : form.copySells,
    sellMode: form.useSell ? null : form.sellMode,
    sellAmount: form.useSell || form.sellMode !== 'fixed' ? null : form.sellAmount,
  };
}
