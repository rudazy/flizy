/**
 * How a shared receipt (/r/{token}) prints its figures. Shared by the page and
 * the receipt image so both read the same.
 */

/** At least two decimals, at most six, digits grouped: "2.00", "0.0125". */
export function receiptAmount(amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/**
 * The dollar line under the amount. tUSD is Flizy's dollar token, one to one;
 * ETH uses the mainnet rate when there is one. Anything else has no line.
 */
export function receiptUsd(amount: string, unit: string, usdPerEth: number | null): string | null {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const upper = unit.toUpperCase();
  const usd = upper === 'TUSD' ? n : upper === 'ETH' && usdPerEth != null ? n * usdPerEth : null;
  if (usd == null) return null;
  return `≈ $${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "22 Oct 2026, 10:42 UTC". */
export function receiptWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}

/** "0x2d7a...91ed0769": enough of both ends to match against an explorer. */
export function receiptHash(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 6)}...${hash.slice(-8)}` : hash;
}

/** The line under each name: who holds that side of the payment. */
export function partyNote(kind: 'flizy' | 'wallet', side: 'from' | 'to'): string {
  if (kind === 'wallet') return 'Outside wallet';
  return side === 'from' ? 'Flizy wallet' : 'Flizy user';
}
