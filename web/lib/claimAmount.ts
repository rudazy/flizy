/**
 * Display amount for a claim row. Mirrors lib/claimAmount.js.
 */

export function claimAssetSymbol(row: { asset?: string | null; tokenSymbol?: string | null } | null | undefined): string {
  const s = String((row && (row.asset || row.tokenSymbol)) || 'ETH')
    .trim()
    .toUpperCase();
  if (!s || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  return s;
}

export function formatClaimAmount(row: {
  amount_eth?: string | number | null;
  amount?: string | number | null;
  asset?: string | null;
} | null | undefined): string {
  const amt =
    String(
      (row && (row.amount_eth != null ? row.amount_eth : row.amount)) ?? ''
    ).trim() || '?';
  return `${amt} ${claimAssetSymbol(row)}`;
}

export function isNativeClaim(row: {
  asset?: string | null;
  token_address?: string | null;
  tokenAddress?: string | null;
} | null | undefined): boolean {
  if (!row) return true;
  if (row.token_address || row.tokenAddress) return false;
  return claimAssetSymbol(row) === 'ETH';
}
