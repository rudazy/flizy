/**
 * The bounded permissions a secured account gives Flizy, and the challenge that
 * proves control of the wallet ownership moves to.
 *
 * The secure-account sequence: Flizy, still owner, adds the user's passkey to
 * the account (addKey); the passkey signs these delegations; ownership then
 * moves to the user's own wallet. A passkey signature stays valid across that
 * move and an owner-key signature does not, which is why the passkey signs.
 * Contracts: MetaMask delegation-framework v1.3.0 (bfbdf97) as deployed on
 * GIWA Sepolia, addresses in deployments/giwa-sepolia-delegation.json and
 * deployments/giwa-sepolia-period-enforcers.json; measurements in
 * docs/DELEGATION-GIWA.md.
 *
 * One delegation per asset. Each carries a 24 hour period allowance that starts
 * at the moment the passkey signed, and expires 30 days after it:
 *
 *   ETH   NativeTokenPeriodTransferEnforcer + ExactCalldataEnforcer(empty)
 *         + TimestampEnforcer
 *   ERC20 ERC20PeriodTransferEnforcer + ValueLteEnforcer(0) + TimestampEnforcer
 *
 * The second caveat on each closes a full drain the period enforcer leaves
 * open: a zero-value call with arbitrary calldata on the native allowance, and
 * native value riding on an ERC-20 transfer.
 *
 * Pure encoding and hashing. Nothing here signs a delegation, sends a
 * transaction or reads the chain.
 */

const { ethers } = require('ethers');
const delegationDeploy = require('../../deployments/giwa-sepolia-delegation.json');
const periodDeploy = require('../../deployments/giwa-sepolia-period-enforcers.json');
const transferAmountDeploy = require('../../deployments/giwa-sepolia-transfer-amount-enforcer.json');
const { listedBySymbol } = require('../listedTokens');

const CHAIN_ID = 91342;

const CONTRACTS = Object.freeze({
  delegationManager: ethers.getAddress(delegationDeploy.contracts.delegationManager),
  timestampEnforcer: ethers.getAddress(delegationDeploy.contracts.timestampEnforcer),
  nativeTokenPeriodTransferEnforcer: ethers.getAddress(periodDeploy.contracts.nativeTokenPeriodTransferEnforcer),
  erc20PeriodTransferEnforcer: ethers.getAddress(periodDeploy.contracts.erc20PeriodTransferEnforcer),
  exactCalldataEnforcer: ethers.getAddress(periodDeploy.contracts.exactCalldataEnforcer),
  valueLteEnforcer: ethers.getAddress(periodDeploy.contracts.valueLteEnforcer),
  // One-off permissions (oneOffCaveats below).
  nativeTokenTransferAmountEnforcer: ethers.getAddress(delegationDeploy.contracts.nativeTokenTransferAmountEnforcer),
  allowedTargetsEnforcer: ethers.getAddress(delegationDeploy.contracts.allowedTargetsEnforcer),
  erc20TransferAmountEnforcer: ethers.getAddress(transferAmountDeploy.contracts.erc20TransferAmountEnforcer),
});

/** A delegation signed by the account itself, not re-delegated from another. */
const ROOT_AUTHORITY = '0x' + 'f'.repeat(64);

const PERIOD_SECONDS = 86400;
const EXPIRY_SECONDS = 30 * 86400;

const TUSD = listedBySymbol('TUSD');
if (!TUSD) throw new Error('tUSD is not listed; its delegation cannot be formed');

/**
 * The per-period caps, in raw units: 0.1 ETH, 1000 FLZ and 50 tUSD a day. They
 * are the most Flizy could move in a day if the server that redeems were taken.
 * FLZ is written out rather than read from lib/chains.js, which lets an
 * environment variable replace it: a signed permission must not follow one.
 */
const ASSETS = Object.freeze({
  ETH: Object.freeze({ kind: 'native', token: null, periodAmount: 10n ** 17n }),
  FLZ: Object.freeze({
    kind: 'erc20',
    token: ethers.getAddress('0x308be8f71DA695f18E70D2243a446e1fD1566BA6'),
    periodAmount: 1000n * 10n ** 18n,
  }),
  TUSD: Object.freeze({
    kind: 'erc20',
    token: ethers.getAddress(TUSD.address),
    periodAmount: 50n * 10n ** BigInt(TUSD.decimals),
  }),
});

const DELEGATION_TYPEHASH = ethers.id(
  'Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'
);
const CAVEAT_TYPEHASH = ethers.id('Caveat(address enforcer,bytes terms)');

const abi = ethers.AbiCoder.defaultAbiCoder();

function u256(n) {
  return ethers.toBeHex(n, 32);
}

function wholeSeconds(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number of seconds`);
  }
  return value;
}

/** TimestampEnforcer terms: 16 bytes "after" (0, no start bound), 16 bytes "before". */
function timestampTerms(expiresAt) {
  return ethers.concat([ethers.toBeHex(0, 16), ethers.toBeHex(expiresAt, 16)]);
}

/** The caveats for one asset, in the order the decision lists them. */
function caveatsFor(symbol, signedAt) {
  const asset = ASSETS[symbol];
  if (!asset) throw new Error(`no delegation is defined for ${symbol}`);
  wholeSeconds(signedAt, 'signedAt');
  const expiry = { enforcer: CONTRACTS.timestampEnforcer, terms: timestampTerms(signedAt + EXPIRY_SECONDS), args: '0x' };

  if (asset.kind === 'native') {
    return [
      {
        enforcer: CONTRACTS.nativeTokenPeriodTransferEnforcer,
        terms: ethers.concat([u256(asset.periodAmount), u256(PERIOD_SECONDS), u256(signedAt)]),
        args: '0x',
      },
      { enforcer: CONTRACTS.exactCalldataEnforcer, terms: '0x', args: '0x' },
      expiry,
    ];
  }
  return [
    {
      enforcer: CONTRACTS.erc20PeriodTransferEnforcer,
      terms: ethers.concat([asset.token, u256(asset.periodAmount), u256(PERIOD_SECONDS), u256(signedAt)]),
      args: '0x',
    },
    { enforcer: CONTRACTS.valueLteEnforcer, terms: ethers.ZeroHash, args: '0x' },
    expiry,
  ];
}

/**
 * The unsigned delegations for one account: ETH, FLZ and tUSD.
 *
 * @param {{ account: string, delegate: string, signedAt: number, salts: Record<string, bigint> }} p
 *   account is the HybridDeleGator, delegate the Flizy relayer that will
 *   redeem, signedAt the passkey signing time in unix seconds, salts one fresh
 *   random value per asset so a re-sign never collides with an old hash.
 */
function buildDelegations({ account, delegate, signedAt, salts }) {
  const delegator = ethers.getAddress(account);
  const to = ethers.getAddress(delegate);
  if (delegator === to) throw new Error('an account cannot delegate to itself');
  return Object.keys(ASSETS).map((symbol) => {
    const salt = salts?.[symbol];
    if (typeof salt !== 'bigint' || salt <= 0n) throw new Error(`a positive salt is required for ${symbol}`);
    return {
      symbol,
      delegation: {
        delegate: to,
        delegator,
        authority: ROOT_AUTHORITY,
        caveats: caveatsFor(symbol, signedAt),
        salt,
        signature: '0x',
      },
    };
  });
}

/**
 * The caveats of a one-off permission: exactly this recipient, exactly this
 * amount, spendable once, until expiresAt (unix seconds). For one chat payment
 * over the daily cap, approved with the passkey.
 *
 *   ETH   NativeTokenTransferAmountEnforcer(amount) + AllowedTargetsEnforcer(to)
 *         + ExactCalldataEnforcer(empty) + TimestampEnforcer
 *   ERC20 ERC20TransferAmountEnforcer(token, amount)
 *         + ExactCalldataEnforcer(transfer(to, amount)) + ValueLteEnforcer(0) + TimestampEnforcer
 *
 * Both amount enforcers keep a running total per permission, so a second
 * redeem exceeds it on chain.
 */
function oneOffCaveats(symbol, { to, amount, expiresAt }) {
  const asset = ASSETS[symbol];
  if (!asset) throw new Error(`no permission is defined for ${symbol}`);
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('amount must be a positive bigint');
  wholeSeconds(expiresAt, 'expiresAt');
  const recipient = ethers.getAddress(to);
  const expiry = { enforcer: CONTRACTS.timestampEnforcer, terms: timestampTerms(expiresAt), args: '0x' };
  if (asset.kind === 'native') {
    return [
      { enforcer: CONTRACTS.nativeTokenTransferAmountEnforcer, terms: u256(amount), args: '0x' },
      { enforcer: CONTRACTS.allowedTargetsEnforcer, terms: recipient.toLowerCase(), args: '0x' },
      { enforcer: CONTRACTS.exactCalldataEnforcer, terms: '0x', args: '0x' },
      expiry,
    ];
  }
  return [
    { enforcer: CONTRACTS.erc20TransferAmountEnforcer, terms: ethers.concat([asset.token, u256(amount)]), args: '0x' },
    { enforcer: CONTRACTS.exactCalldataEnforcer, terms: ERC20.encodeFunctionData('transfer', [recipient, amount]), args: '0x' },
    { enforcer: CONTRACTS.valueLteEnforcer, terms: ethers.ZeroHash, args: '0x' },
    expiry,
  ];
}

/** An unsigned one-off permission for one payment. */
function buildOneOff({ account, delegate, symbol, to, amount, expiresAt, salt }) {
  const delegator = ethers.getAddress(account);
  const relayer = ethers.getAddress(delegate);
  if (delegator === relayer) throw new Error('an account cannot delegate to itself');
  if (typeof salt !== 'bigint' || salt <= 0n) throw new Error('a positive salt is required');
  return {
    symbol,
    delegation: {
      delegate: relayer,
      delegator,
      authority: ROOT_AUTHORITY,
      caveats: oneOffCaveats(symbol, { to, amount, expiresAt }),
      salt,
      signature: '0x',
    },
  };
}

function caveatsHash(caveats) {
  return ethers.keccak256(
    ethers.concat(
      caveats.map((c) => ethers.keccak256(abi.encode(['bytes32', 'address', 'bytes32'], [CAVEAT_TYPEHASH, c.enforcer, ethers.keccak256(c.terms)])))
    )
  );
}

/** EIP-712 struct hash, as DelegationManager computes it (args are not signed). */
function delegationStructHash(d) {
  return ethers.keccak256(
    abi.encode(
      ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
      [DELEGATION_TYPEHASH, d.delegate, d.delegator, d.authority, caveatsHash(d.caveats), d.salt]
    )
  );
}

/** The digest the account's passkey signs and isValidSignature is asked about. */
function delegationDigest(d) {
  const domain = { name: 'DelegationManager', version: '1', chainId: CHAIN_ID, verifyingContract: CONTRACTS.delegationManager };
  return ethers.keccak256(ethers.concat(['0x1901', ethers.TypedDataEncoder.hashDomain(domain), delegationStructHash(d)]));
}

/** ERC-7579 single-call execution: target, value, calldata packed. */
function encodeExecution(target, value, callData) {
  return ethers.concat([ethers.getAddress(target), u256(value), callData || '0x']);
}

const ERC20 = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const DM = new ethers.Interface([
  'function redeemDelegations(bytes[] _permissionContexts, bytes32[] _modes, bytes[] _executionCallDatas)',
]);
const DELEGATION_TUPLE =
  'tuple(address delegate, address delegator, bytes32 authority, tuple(address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)[]';

/**
 * Calldata for the relayer to move `amount` of one asset out of the account
 * under its signed delegation. Single-call, default mode.
 */
function redeemCalldata(signed, { to, amount }) {
  const asset = ASSETS[signed.symbol];
  if (!asset) throw new Error(`no delegation is defined for ${signed.symbol}`);
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('amount must be a positive bigint');
  const d = signed.delegation;
  if (!d.signature || d.signature === '0x') throw new Error('the delegation is not signed');
  const recipient = ethers.getAddress(to);
  const execution =
    asset.kind === 'native'
      ? encodeExecution(recipient, amount, '0x')
      : encodeExecution(asset.token, 0n, ERC20.encodeFunctionData('transfer', [recipient, amount]));
  const context = abi.encode(
    [DELEGATION_TUPLE],
    [[[d.delegate, d.delegator, d.authority, d.caveats.map((c) => [c.enforcer, c.terms, c.args]), d.salt, d.signature]]]
  );
  return DM.encodeFunctionData('redeemDelegations', [[context], [ethers.ZeroHash], [execution]]);
}

// ---- Control challenge: the user's wallet proves it controls itself before
// ownership moves to it. One-time server nonce, ten-minute expiry, bound to the
// account and the chain.

const OWNERSHIP_PURPOSE = 'Flizy: become owner of this account';
const OWNERSHIP_TTL_SECONDS = 600;
const OWNERSHIP_TYPES = Object.freeze({
  FlizyOwnership: [
    { name: 'account', type: 'address' },
    { name: 'purpose', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiry', type: 'uint256' },
  ],
});

/** The typed data the Privy wallet signs, for a nonce the server just issued. */
function ownershipChallenge({ account, nonce, issuedAt }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(nonce))) throw new Error('nonce must be 32 bytes');
  const gator = ethers.getAddress(account);
  return {
    domain: { name: 'Flizy', version: '1', chainId: CHAIN_ID, verifyingContract: gator },
    types: OWNERSHIP_TYPES,
    primaryType: 'FlizyOwnership',
    message: {
      account: gator,
      purpose: OWNERSHIP_PURPOSE,
      nonce: ethers.hexlify(nonce),
      expiry: wholeSeconds(issuedAt, 'issuedAt') + OWNERSHIP_TTL_SECONDS,
    },
  };
}

/**
 * Whether `signature` proves `wallet` controls itself for this challenge.
 * The caller still burns the nonce; this only checks the bytes and the clock.
 */
function verifyOwnershipChallenge(challenge, signature, wallet, now) {
  const expected = ethers.getAddress(wallet);
  if (wholeSeconds(now, 'now') >= Number(challenge.message.expiry)) return false;
  if (challenge.message.purpose !== OWNERSHIP_PURPOSE) return false;
  if (challenge.message.account !== challenge.domain.verifyingContract) return false;
  if (challenge.domain.chainId !== CHAIN_ID) return false;
  let signer;
  try {
    signer = ethers.verifyTypedData(challenge.domain, challenge.types, challenge.message, signature);
  } catch {
    return false;
  }
  return signer === expected;
}

module.exports = {
  CHAIN_ID,
  CONTRACTS,
  ASSETS,
  ROOT_AUTHORITY,
  PERIOD_SECONDS,
  EXPIRY_SECONDS,
  OWNERSHIP_PURPOSE,
  OWNERSHIP_TTL_SECONDS,
  caveatsFor,
  buildDelegations,
  oneOffCaveats,
  buildOneOff,
  delegationStructHash,
  delegationDigest,
  redeemCalldata,
  ownershipChallenge,
  verifyOwnershipChallenge,
};
