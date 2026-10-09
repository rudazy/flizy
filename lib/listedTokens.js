/**
 * Tokens Flizy lists beside FLZ, each with an ETH pool Flizy seeded and holds
 * the liquidity of (deployments/giwa-sepolia.json, "listings").
 *
 * IZY and MAKI carry the verified mark, DCAT does not. Either way only ETH and
 * FLZ can be sent on socials.
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
  }),
  Object.freeze({
    symbol: 'IZY',
    name: 'Izy',
    verified: true,
    address: '0x8CA7A8F78abC8dA471df82BE4F374e1661e34473',
    decimals: 18,
    pair: '0x2fC40Df0c997310E07370cE547c56A0014B029Da',
  }),
  Object.freeze({
    symbol: 'MAKI',
    name: 'Maki',
    verified: true,
    address: '0xd08d83cdf19Db8CCd53Ed462034c8631De5F693d',
    decimals: 18,
    pair: '0xf9A9FCF725bE455E9523a4846C649BC86d6533c5',
  }),
]);

/** @param {string|null|undefined} address */
function listedByAddress(address) {
  if (!address) return null;
  const lower = String(address).toLowerCase();
  return LISTED_TOKENS.find((token) => token.address.toLowerCase() === lower) || null;
}

/** @param {string|null|undefined} symbol */
function listedBySymbol(symbol) {
  if (!symbol) return null;
  const upper = String(symbol).trim().toUpperCase();
  return LISTED_TOKENS.find((token) => token.symbol === upper) || null;
}

module.exports = { LISTED_TOKENS, listedByAddress, listedBySymbol };
