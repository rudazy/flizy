/**
 * Display amount for a claim row or plan input.
 * amount_eth is the human decimal for every asset (ETH and listed tokens).
 */

function claimAssetSymbol(row) {
  const s = String((row && (row.asset || row.tokenSymbol)) || 'ETH')
    .trim()
    .toUpperCase();
  if (!s || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  return s;
}

function formatClaimAmount(row) {
  const amt =
    String(
      (row && (row.amount_eth != null ? row.amount_eth : row.amount)) ?? ''
    ).trim() || '?';
  return `${amt} ${claimAssetSymbol(row)}`;
}

function isNativeClaim(row) {
  if (!row) return true;
  if (row.token_address || row.tokenAddress) return false;
  return claimAssetSymbol(row) === 'ETH';
}

module.exports = {
  claimAssetSymbol,
  formatClaimAmount,
  isNativeClaim,
};
