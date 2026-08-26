/**
 * Display amount for a claim row or plan input.
 * amount_eth is the human decimal for every asset (ETH and listed tokens).
 * NFT holds render as "giwaforge #1842" from nft_token_id.
 */

function claimAssetSymbol(row) {
  const s = String((row && (row.asset || row.tokenSymbol)) || 'ETH')
    .trim()
    .toUpperCase();
  if (!s || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  return s;
}

function nftTokenIdOf(row) {
  if (!row) return null;
  const v = row.nft_token_id != null ? row.nft_token_id : row.nftTokenId;
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^[0-9]+$/.test(s)) return null;
  return s.replace(/^0+(?=\d)/, '') || '0';
}

function isNftClaim(row) {
  return nftTokenIdOf(row) != null;
}

function formatClaimAmount(row) {
  const id = nftTokenIdOf(row);
  if (id != null) {
    const ticker = String((row && row.asset) || 'NFT')
      .trim()
      .toLowerCase() || 'nft';
    return `${ticker} #${id}`;
  }
  const amt =
    String(
      (row && (row.amount_eth != null ? row.amount_eth : row.amount)) ?? ''
    ).trim() || '?';
  return `${amt} ${claimAssetSymbol(row)}`;
}

function isNativeClaim(row) {
  if (!row) return true;
  if (isNftClaim(row)) return false;
  if (row.token_address || row.tokenAddress) return false;
  return claimAssetSymbol(row) === 'ETH';
}

module.exports = {
  claimAssetSymbol,
  formatClaimAmount,
  isNativeClaim,
  isNftClaim,
  nftTokenIdOf,
};
