import { subtractHolding } from './reservesMath.ts';

/**
 * What a spend screen may offer from a Flizy wallet: the chain balance minus
 * Savings. The server refuses a spend that reaches into Savings
 * (reserveStore.assertSpendable); this keeps Balance and Max from offering it
 * in the first place. An outside wallet has no Savings and is not read here.
 */

export type SavingsRow = { asset: string; amountBase: string; decimals: number };

/**
 * The signed-in account's Savings rows from /api/reserves. An empty list when
 * there is no Savings book; null when it could not be read, so the caller
 * shows no balance rather than one that counts Savings.
 */
export async function fetchSavings(): Promise<SavingsRow[] | null> {
  try {
    const res = await fetch('/api/reserves', { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) return null;
    if (body.missing) return [];
    if (!Array.isArray(body.rows)) return null;
    return body.rows.filter(
      (r: Partial<SavingsRow>) => typeof r?.asset === 'string' && typeof r?.amountBase === 'string' && Number.isInteger(r?.decimals)
    ) as SavingsRow[];
  } catch {
    return null;
  }
}

/** A balance with this asset's Savings taken off. A symbol is matched upper case (tUSD is TUSD). */
export function spendable(balance: string, symbol: string, rows: SavingsRow[]): string {
  const key = String(symbol || '').trim().toUpperCase();
  const saved = rows.find((r) => r.asset === key);
  if (!saved) return balance;
  return subtractHolding(balance, saved.decimals, saved.amountBase);
}
