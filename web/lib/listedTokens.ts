/**
 * Tokens Flizy lists beside FLZ: each trades against an ETH pool that Flizy
 * seeded and whose liquidity Flizy holds (deployments/giwa-sepolia.json,
 * "listings"). That is what puts them in Explore and lets them trade at all:
 * Flizy's pools refuse any other token (web/lib/swapGate.ts).
 *
 * IZY, MAKI and TUSD are Flizy's own tokens and carry the verified mark; DCAT
 * is a third-party token and does not. Only ETH, FLZ and the tokens marked
 * sendable (TUSD) can be sent on socials; the rest are traded and held.
 *
 * TUSD is Flizy Test USD, the testnet dollar payments are priced in. Its
 * contract symbol is "tUSD", which is how `label` prints it. The key stays
 * upper case like every other symbol here, so a lookup never depends on casing.
 *
 * Mirror of lib/listedTokens.js, which the chat bot reads. web/ cannot import
 * root lib/ on Vercel, so test/listedTokensDrift.test.js keeps the two equal.
 */

export type ListedToken = {
  symbol: string;
  /** How the symbol prints when it is not all upper case on chain ("tUSD"). */
  label?: string;
  name: string;
  /** Flizy vouches for the token itself, not only its pool. Display only: it does not make a token sendable. */
  verified: boolean;
  /** Can be sent on socials and paid with, beside ETH and FLZ. */
  sendable?: boolean;
  address: string;
  decimals: number;
  pair: string;
  /** Served from web/public. DCAT's is the art its own contract points to. */
  logo: string;
};

export const LISTED_TOKENS: readonly ListedToken[] = [
  {
    symbol: 'DCAT',
    name: 'deus cat',
    verified: false,
    address: '0x58fB4D3DA82F5d610ad36E6e39e674C17B32Ffd1',
    decimals: 18,
    pair: '0x3083C7Aa86Bc20256439c102156E7fCbe7b91797',
    logo: '/tokens/dcat.webp',
  },
  {
    symbol: 'IZY',
    name: 'Izy',
    verified: true,
    address: '0x8CA7A8F78abC8dA471df82BE4F374e1661e34473',
    decimals: 18,
    pair: '0x2fC40Df0c997310E07370cE547c56A0014B029Da',
    logo: '/tokens/izy.svg',
  },
  {
    symbol: 'MAKI',
    name: 'Maki',
    verified: true,
    address: '0xd08d83cdf19Db8CCd53Ed462034c8631De5F693d',
    decimals: 18,
    pair: '0xf9A9FCF725bE455E9523a4846C649BC86d6533c5',
    logo: '/tokens/maki.svg',
  },
  {
    symbol: 'TUSD',
    label: 'tUSD',
    name: 'Flizy Test USD',
    verified: true,
    sendable: true,
    address: '0x4F28C18600c312Bfa8e8281D882e0EC306F82446',
    decimals: 6,
    pair: '0xa20728AF77F48b1cabeA5A95DE770eC405334e50',
    logo: '/tokens/tusd.svg',
  },
];

/** What "usd" in a command means: Flizy has one dollar, and it is test money. */
const SYMBOL_ALIASES: Readonly<Record<string, string>> = { USD: 'TUSD' };

/** The listed token at this contract address, in any casing. */
export function listedByAddress(address: string | null | undefined): ListedToken | null {
  if (!address) return null;
  const lower = String(address).toLowerCase();
  return LISTED_TOKENS.find((token) => token.address.toLowerCase() === lower) ?? null;
}

/** The listed token with this symbol, in any casing. */
export function listedBySymbol(symbol: string | null | undefined): ListedToken | null {
  if (!symbol) return null;
  const typed = String(symbol).trim().toUpperCase();
  const upper = SYMBOL_ALIASES[typed] || typed;
  return LISTED_TOKENS.find((token) => token.symbol === upper) ?? null;
}

/** Listed symbols that can be sent on socials, beside ETH and FLZ. */
export const SENDABLE_LISTED_SYMBOLS: readonly string[] = LISTED_TOKENS.filter(
  (token) => token.sendable === true
).map((token) => token.symbol);

/**
 * How a symbol prints: a listed token's label when it has one ("tUSD"),
 * otherwise the symbol as given. Exact registry symbols only, never an alias,
 * so another token calling itself "USD" is not printed as Flizy's dollar.
 */
export function symbolLabel(symbol: string | null | undefined): string {
  const upper = String(symbol || '').trim().toUpperCase();
  return LISTED_TOKENS.find((token) => token.symbol === upper)?.label || String(symbol || '');
}
