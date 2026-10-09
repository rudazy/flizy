/**
 * Tokens Flizy lists beside FLZ: each trades against an ETH pool that Flizy
 * seeded and whose liquidity Flizy holds (deployments/giwa-sepolia.json,
 * "listings"). That is what puts them in Explore and lets them trade without
 * the unverified-token warning.
 *
 * IZY and MAKI are Flizy's own tokens and carry the verified mark; DCAT is a
 * third-party token and does not. Either way only ETH and FLZ can be sent on
 * socials; a listed token is traded and held.
 *
 * Mirror of lib/listedTokens.js, which the chat bot reads. web/ cannot import
 * root lib/ on Vercel, so test/listedTokensDrift.test.js keeps the two equal.
 */

export type ListedToken = {
  symbol: string;
  name: string;
  /** Flizy vouches for the token itself, not only its pool. Display only: sending on socials stays ETH and FLZ. */
  verified: boolean;
  address: string;
  decimals: number;
  pair: string;
};

export const LISTED_TOKENS: readonly ListedToken[] = [
  {
    symbol: 'DCAT',
    name: 'deus cat',
    verified: false,
    address: '0x58fB4D3DA82F5d610ad36E6e39e674C17B32Ffd1',
    decimals: 18,
    pair: '0x3083C7Aa86Bc20256439c102156E7fCbe7b91797',
  },
  {
    symbol: 'IZY',
    name: 'Izy',
    verified: true,
    address: '0x8CA7A8F78abC8dA471df82BE4F374e1661e34473',
    decimals: 18,
    pair: '0x2fC40Df0c997310E07370cE547c56A0014B029Da',
  },
  {
    symbol: 'MAKI',
    name: 'Maki',
    verified: true,
    address: '0xd08d83cdf19Db8CCd53Ed462034c8631De5F693d',
    decimals: 18,
    pair: '0xf9A9FCF725bE455E9523a4846C649BC86d6533c5',
  },
];

/** The listed token at this contract address, in any casing. */
export function listedByAddress(address: string | null | undefined): ListedToken | null {
  if (!address) return null;
  const lower = String(address).toLowerCase();
  return LISTED_TOKENS.find((token) => token.address.toLowerCase() === lower) ?? null;
}

/** The listed token with this symbol, in any casing. */
export function listedBySymbol(symbol: string | null | undefined): ListedToken | null {
  if (!symbol) return null;
  const upper = String(symbol).trim().toUpperCase();
  return LISTED_TOKENS.find((token) => token.symbol === upper) ?? null;
}
