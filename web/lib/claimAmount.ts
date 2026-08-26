/**
 * Display amount for a claim row. Mirrors lib/claimAmount.js.
 */

type ClaimAmountRow = {
  amount_eth?: string | number | null;
  amount?: string | number | null;
  asset?: string | null;
  tokenSymbol?: string | null;
  token_address?: string | null;
  tokenAddress?: string | null;
  nft_token_id?: string | number | null;
  nftTokenId?: string | number | null;
} | null | undefined;

export function claimAssetSymbol(row: ClaimAmountRow): string {
  const s = String((row && (row.asset || row.tokenSymbol)) || 'ETH')
    .trim()
    .toUpperCase();
  if (!s || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  return s;
}

export function nftTokenIdOf(row: ClaimAmountRow): string | null {
  if (!row) return null;
  const v = row.nft_token_id != null ? row.nft_token_id : row.nftTokenId;
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^[0-9]+$/.test(s)) return null;
  return s.replace(/^0+(?=\d)/, '') || '0';
}

export function isNftClaim(row: ClaimAmountRow): boolean {
  return nftTokenIdOf(row) != null;
}

export function formatClaimAmount(row: ClaimAmountRow): string {
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

export function isNativeClaim(row: ClaimAmountRow): boolean {
  if (!row) return true;
  if (isNftClaim(row)) return false;
  if (row.token_address || row.tokenAddress) return false;
  return claimAssetSymbol(row) === 'ETH';
}
