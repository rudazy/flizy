/**
 * Savings book for the site. Available is computed by the caller from the
 * chain balance minus these rows. The math lives in reservesMath.ts.
 * Callers pass the database client. This file does not open one.
 */

import { formatAmount } from './amountDisplay.ts';
import { listedBySymbol, symbolLabel } from './listedTokens.ts';
import { FLZ_TOKEN } from './walletChain.ts';
import { availableBase, covers, formatUnits, SAVINGS_HELPER } from './reservesMath.ts';

export { SAVINGS_HELPER };

type DbError = { code?: string; message?: string; details?: string; hint?: string } | null;
type RowsResult = { data: { asset?: string; amount?: string }[] | null; error: DbError };

type ReserveReader = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, value: string) => PromiseLike<RowsResult>;
    };
  };
};

/** Shallow on purpose. A Supabase client matched against ReserveReader is too deep for tsc. */
type ReserveClient = { from: (table: string) => unknown };

export type ReserveInfo = { asset: string; decimals: number; token: string | null; label: string };

const SPEND_WORDS = new Set(['spend', 'spending', 'available', 'savings', 'reserve', 'vault']);

export function isReserveTarget(raw: string): boolean {
  const word = String(raw || '').trim().toLowerCase().replace(/^@/, '');
  return SPEND_WORDS.has(word);
}

function normalizeAsset(raw: string): string {
  const s = String(raw || 'ETH').trim().toUpperCase();
  if (s === 'ETH' || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  if (s === 'FLIZY') return 'FLZ';
  if (s === 'USD') return 'TUSD';
  return s;
}

export function resolveReserveAsset(symbol: string, flzToken: string = FLZ_TOKEN): ReserveInfo | null {
  const key = normalizeAsset(symbol || 'ETH');
  if (key === 'ETH') return { asset: 'ETH', decimals: 18, token: null, label: 'ETH' };
  if (key === 'FLZ') {
    const token = String(flzToken || '').trim();
    if (!token) return null;
    return { asset: 'FLZ', decimals: 18, token, label: 'FLZ' };
  }
  const listed = listedBySymbol(key);
  if (!listed) return null;
  return { asset: listed.symbol, decimals: listed.decimals, token: listed.address, label: symbolLabel(listed.symbol) };
}

export function reserveStoreMissing(error: DbError): boolean {
  const code = String(error && error.code ? error.code : '');
  const msg = String(error && error.message ? error.message : '');
  if (code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '42883') return true;
  return /account_reserves|move_account_reserve/i.test(msg) && /schema cache|does not exist|could not find/i.test(msg);
}

export async function loadReserveRows(supabase: ReserveClient, accountId: string) {
  const { data, error } = await (supabase as ReserveReader).from('account_reserves').select('asset, amount').eq('account_id', accountId);
  if (error) {
    if (reserveStoreMissing(error)) return { ok: true as const, missing: true, rows: [] as { asset: string; amount: string }[] };
    return { ok: false as const, rows: [] as { asset: string; amount: string }[] };
  }
  const rows: { asset: string; amount: string }[] = [];
  for (const row of data || []) {
    const amount = String(row.amount ?? '').trim();
    if (!/^[A-Z][A-Z0-9]{0,15}$/.test(String(row.asset || '')) || !/^[0-9]+$/.test(amount)) {
      return { ok: false as const, rows: [] as { asset: string; amount: string }[] };
    }
    rows.push({ asset: String(row.asset), amount });
  }
  return { ok: true as const, missing: false, rows };
}

function spendRefusal(label: string, available: bigint, decimals: number): string {
  let shown = '0';
  try {
    shown = formatAmount(formatUnits(available > 0n ? available : 0n, decimals));
  } catch {
    shown = '0';
  }
  return ['Insufficient available balance.', `Available: ${shown} ${label}`, 'Savings is not included in available funds.'].join('\n');
}

export function savingsShortfall(label: string, reservedBase: bigint, decimals: number): string {
  let shown = '0';
  try {
    shown = formatAmount(formatUnits(reservedBase > 0n ? reservedBase : 0n, decimals));
  } catch {
    shown = '0';
  }
  return ['Insufficient Savings balance.', `Available in Savings: ${shown} ${label}`].join('\n');
}

export async function assertSpendable(
  supabase: ReserveClient,
  accountId: string,
  spec: { asset: string; holding: bigint; amount: bigint; gas?: bigint; decimals: number; label?: string }
): Promise<{ ok: true } | { ok: false; message: string }> {
  let loaded;
  try {
    loaded = await loadReserveRows(supabase, accountId);
  } catch {
    return { ok: false, message: 'Could not read Savings. Nothing was sent.' };
  }
  if (!loaded.ok) return { ok: false, message: 'Could not read Savings. Nothing was sent.' };
  if (loaded.missing) return { ok: true };
  const row = loaded.rows.find((item) => item.asset === spec.asset);
  const reserved = row ? BigInt(row.amount) : 0n;
  const gas = spec.gas ?? 0n;
  let fitsReserved: boolean;
  let fitsRaw: boolean;
  try {
    fitsReserved = covers(spec.holding, reserved, spec.amount, gas);
    fitsRaw = covers(spec.holding, 0n, spec.amount, gas);
  } catch {
    return { ok: false, message: 'Could not read Savings. Nothing was sent.' };
  }
  if (fitsReserved) return { ok: true };
  if (!fitsRaw) return { ok: true };
  return { ok: false, message: spendRefusal(spec.label || spec.asset, availableBase(spec.holding, reserved, gas), spec.decimals) };
}

function errorText(error: DbError): string {
  if (!error) return '';
  return [error.message, error.details, error.hint].filter(Boolean).join(' ');
}

export function mapReserveMoveError(
  error: DbError,
  spec: { label: string; holding: bigint; reserved: bigint; gas?: bigint; decimals: number }
): { missing: boolean; message: string } {
  if (reserveStoreMissing(error)) return { missing: true, message: 'Savings is not on yet.' };
  const text = errorText(error);
  if (/insufficient available/i.test(text)) {
    return {
      missing: false,
      message: spendRefusal(spec.label, availableBase(spec.holding, spec.reserved, spec.gas ?? 0n), spec.decimals),
    };
  }
  if (/insufficient savings/i.test(text)) {
    return { missing: false, message: savingsShortfall(spec.label, spec.reserved, spec.decimals) };
  }
  return { missing: false, message: 'Could not move that. Nothing changed.' };
}
