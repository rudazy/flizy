/**
 * The Tokens chip on Explore is three jobs, and this file is only the first.
 *
 * Discovery ranks tokens Flizy can already talk about. Copy Trade is a
 * separate view, not a row in this list. The token page is a route, not a
 * filter. Flizy is not running a launchpad, so that screen has no create.
 */

export const TOKEN_FILTERS = [
  { id: 'trending', label: 'Trending' },
  { id: 'new', label: 'New' },
  { id: 'held', label: 'Most held' },
  { id: 'verified', label: 'Verified' },
  { id: 'gainers', label: 'Gainers' },
  { id: 'watchlist', label: 'Watchlist' },
] as const;

export type TokenFilterId = (typeof TOKEN_FILTERS)[number]['id'];

export const TOKEN_VIEWS = [
  { id: 'discover', label: 'Discover' },
  { id: 'copy', label: 'Copy Trade' },
] as const;

export type TokenViewId = (typeof TOKEN_VIEWS)[number]['id'];

export const NFT_VIEWS = [
  { id: 'listed', label: 'Listed' },
  { id: 'mint', label: 'Copy Mint' },
] as const;

export type NftViewId = (typeof NFT_VIEWS)[number]['id'];

export type DiscoveryToken = {
  symbol: string;
  name: string;
  priceEth: string | null;
  change1hPct: number | null;
  liquidityEth: string | null;
  /** Flizy attestation. Display only: only ETH and FLZ can be sent on socials. */
  verified: boolean;
  /** A token Flizy lists with a pool it seeded. Its page opens by this contract. */
  address?: string;
  /** Pool figures for the Explore row, all in ETH. Absent from older responses. */
  flzPerEth?: string | null;
  marketCapEth?: string | null;
  /** Closing prices of recent candles, oldest first, for the sparkline. */
  spark?: number[];
  /** This account starred it. */
  watched?: boolean;
};

const EMPTY: Record<TokenFilterId, string> = {
  trending: 'No listed token has a pool yet.',
  new: 'No token is listed.',
  held: 'Holder counts are not read yet. This list stays empty.',
  verified: 'No verified token is listed.',
  gainers: 'No listed token is up over the last hour.',
  watchlist: 'Star a token on its page to keep it here.',
};

export function isTokenFilter(id: string): id is TokenFilterId {
  return TOKEN_FILTERS.some((filter) => filter.id === id);
}

/**
 * Which listed tokens a filter is allowed to show.
 *
 * Trending and New can show a token once it has a pool price. Gainers can
 * show it only when that price is up over the hour. Verified shows the tokens
 * Flizy attests, even when the pool price is missing. Most held stays empty:
 * there is no holder count to rank. A token someone holds is traded from the
 * wallet, not invented into this list.
 */
export function tokensForFilter(
  filter: TokenFilterId,
  tokens: DiscoveryToken[]
): { tokens: DiscoveryToken[]; empty: string } {
  switch (filter) {
    case 'trending':
    case 'new':
      return {
        tokens: tokens.filter((token) => token.priceEth != null),
        empty: EMPTY[filter],
      };
    case 'gainers':
      return {
        tokens: tokens.filter(
          (token) => token.priceEth != null && token.change1hPct != null && token.change1hPct > 0
        ),
        empty: EMPTY.gainers,
      };
    case 'verified':
      return {
        tokens: tokens.filter((token) => token.verified),
        empty: EMPTY.verified,
      };
    case 'held':
      return { tokens: [], empty: EMPTY.held };
    case 'watchlist':
      return { tokens: tokens.filter((token) => token.watched === true), empty: EMPTY.watchlist };
  }
}

export function filterHelper(filter: TokenFilterId): string {
  switch (filter) {
    case 'trending':
      return 'Listed tokens with a live pool.';
    case 'new':
      return 'Listed on Flizy. There is no separate launch clock.';
    case 'held':
      return 'Most held needs a holder count. That count is not read yet.';
    case 'verified':
      return 'Tokens Flizy verified. Only ETH and FLZ can be sent on socials; any token in your wallet can still be traded.';
    case 'gainers':
      return 'Listed tokens whose pool price is up over the last hour.';
    case 'watchlist':
      return 'Tokens you starred. Tap the star on a token page to add one.';
  }
}
