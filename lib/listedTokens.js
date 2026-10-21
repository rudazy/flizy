/**
 * Tokens Flizy lists beside FLZ, each with an ETH pool Flizy seeded and holds
 * the liquidity of (deployments/giwa-sepolia.json, "listings").
 *
 * IZY, MAKI and TUSD carry the verified mark, DCAT does not. Only ETH, FLZ and
 * the tokens marked sendable (TUSD) can be sent on socials; the rest are
 * traded and held.
 *
 * TUSD is Flizy Test USD, the testnet dollar payments are priced in. Its
 * contract symbol is "tUSD", which is how `label` prints it. The key stays
 * upper case like every other symbol here, so a lookup never depends on casing.
 *
 * Mirror of web/lib/listedTokens.ts. test/listedTokensDrift.test.js keeps the
 * two equal.
 */

const LISTED_TOKENS = Object.freeze([
  Object.freeze({
    symbol: 'DCAT',
    name: 'deus cat',
    verified: false,
    address: '0x58fB4D3DA82F5d610ad36E6e39e674C17B32Ffd1',
    decimals: 18,
    pair: '0x3083C7Aa86Bc20256439c102156E7fCbe7b91797',
    logo: '/tokens/dcat.webp',
  }),
  Object.freeze({
    symbol: 'IZY',
    name: 'Izy',
    verified: true,
    address: '0x8CA7A8F78abC8dA471df82BE4F374e1661e34473',
    decimals: 18,
    pair: '0x2fC40Df0c997310E07370cE547c56A0014B029Da',
    logo: '/tokens/izy.svg',
  }),
  Object.freeze({
    symbol: 'MAKI',
    name: 'Maki',
    verified: true,
    address: '0xd08d83cdf19Db8CCd53Ed462034c8631De5F693d',
    decimals: 18,
    pair: '0xf9A9FCF725bE455E9523a4846C649BC86d6533c5',
    logo: '/tokens/maki.svg',
  }),
  Object.freeze({
    symbol: 'TUSD',
    label: 'tUSD',
    name: 'Flizy Test USD',
    verified: true,
    sendable: true,
    address: '0x4F28C18600c312Bfa8e8281D882e0EC306F82446',
    decimals: 6,
    pair: '0xa20728AF77F48b1cabeA5A95DE770eC405334e50',
    logo: '/tokens/tusd.svg',
  }),
]);

/** What "usd" in a command means: Flizy has one dollar, and it is test money. */
const SYMBOL_ALIASES = Object.freeze({ USD: 'TUSD' });

/** @param {string|null|undefined} address */
function listedByAddress(address) {
  if (!address) return null;
  const lower = String(address).toLowerCase();
  return LISTED_TOKENS.find((token) => token.address.toLowerCase() === lower) || null;
}

/** @param {string|null|undefined} symbol */
function listedBySymbol(symbol) {
  if (!symbol) return null;
  const typed = String(symbol).trim().toUpperCase();
  const upper = SYMBOL_ALIASES[typed] || typed;
  return LISTED_TOKENS.find((token) => token.symbol === upper) || null;
}

/** Listed symbols that can be sent on socials, beside ETH and FLZ. */
const SENDABLE_LISTED_SYMBOLS = Object.freeze(
  LISTED_TOKENS.filter((token) => token.sendable === true).map((token) => token.symbol)
);

/**
 * How a symbol prints: a listed token's label when it has one ("tUSD"),
 * otherwise the symbol as given. Exact registry symbols only, never an alias,
 * so another token calling itself "USD" is not printed as Flizy's dollar.
 * @param {string|null|undefined} symbol
 */
function symbolLabel(symbol) {
  const upper = String(symbol || '').trim().toUpperCase();
  const listed = LISTED_TOKENS.find((token) => token.symbol === upper);
  return (listed && listed.label) || String(symbol || '');
}

module.exports = {
  LISTED_TOKENS,
  SENDABLE_LISTED_SYMBOLS,
  listedByAddress,
  listedBySymbol,
  symbolLabel,
};
