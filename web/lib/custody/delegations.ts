/**
 * The bounded permissions a secured account gives Flizy.
 *
 * Deliberate mirror of lib/custody/delegations.js, which documents the caps and
 * caveats. The web bundle cannot import root lib/ or deployments/, so the
 * addresses are written here and test/webCustodyDelegations.test.js pins this
 * file to the root module and to the deployment records, byte for byte.
 *
 * Pure encoding and hashing. Nothing here signs, sends or reads the chain.
 */

import { ethers } from 'ethers';
import { listedBySymbol } from '../listedTokens.ts';

export const CHAIN_ID = 91342;

export const CONTRACTS = Object.freeze({
  delegationManager: '0xB04c9b180d5C0F9854B3f9da5e702d10f0030d4B',
  timestampEnforcer: '0x24DD7326ae2275fD9D505526f62a3843d174C2eF',
  nativeTokenPeriodTransferEnforcer: '0x4AEa7d5c1f46dbBC989bCe6fED1c308969e02B4b',
  erc20PeriodTransferEnforcer: '0x5f7e9B1133b40b7fE5898952409f5092291F85e1',
  exactCalldataEnforcer: '0x9c2E6f6986eeF48b8E8BD1239EDd231b3e96fe4F',
  valueLteEnforcer: '0xCDfF89B4f7D0F44Dc056C33B18f575D7B7fA0505',
  // One-off permissions (oneOffCaveats below).
  nativeTokenTransferAmountEnforcer: '0x163bD4BDcb68c4913deeFFa265ec54007d6C03CF',
  allowedTargetsEnforcer: '0x6b50AD84c6Ba42d227bD8f88bCdC4B53d3fdA405',
  erc20TransferAmountEnforcer: '0x90aBb16aED4C6aE5202EaD16D241b4F32297be68',
});

export const ROOT_AUTHORITY = '0x' + 'f'.repeat(64);
export const PERIOD_SECONDS = 86400;
export const EXPIRY_SECONDS = 30 * 86400;

const TUSD = listedBySymbol('TUSD');
if (!TUSD) throw new Error('tUSD is not listed; its delegation cannot be formed');

export type AssetSymbol = 'ETH' | 'FLZ' | 'TUSD';
type Asset = { kind: 'native' | 'erc20'; token: string | null; periodAmount: bigint };

/** FLZ is written out, not read from configuration: a signed permission must not follow an env change. */
export const ASSETS: Readonly<Record<AssetSymbol, Asset>> = Object.freeze({
  ETH: Object.freeze({ kind: 'native', token: null, periodAmount: 10n ** 17n }),
  FLZ: Object.freeze({ kind: 'erc20', token: ethers.getAddress('0x308be8f71da695f18e70d2243a446e1fd1566ba6'), periodAmount: 1000n * 10n ** 18n }),
  TUSD: Object.freeze({ kind: 'erc20', token: ethers.getAddress(TUSD.address), periodAmount: 50n * 10n ** BigInt(TUSD.decimals) }),
}) as Readonly<Record<AssetSymbol, Asset>>;

export const ASSET_ORDER: readonly AssetSymbol[] = ['ETH', 'FLZ', 'TUSD'];

export type Caveat = { enforcer: string; terms: string; args: string };
export type Delegation = {
  delegate: string;
  delegator: string;
  authority: string;
  caveats: Caveat[];
  salt: bigint;
  signature: string;
};
export type AssetDelegation = { symbol: AssetSymbol; delegation: Delegation };

const DELEGATION_TYPEHASH = ethers.id(
  'Delegation(address delegate,address delegator,bytes32 authority,Caveat[] caveats,uint256 salt)Caveat(address enforcer,bytes terms)'
);
const CAVEAT_TYPEHASH = ethers.id('Caveat(address enforcer,bytes terms)');
const abi = ethers.AbiCoder.defaultAbiCoder();

function u256(n: bigint | number): string {
  return ethers.toBeHex(n, 32);
}

function wholeSeconds(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number of seconds`);
  return value;
}

function timestampTerms(expiresAt: number): string {
  return ethers.concat([ethers.toBeHex(0, 16), ethers.toBeHex(expiresAt, 16)]);
}

export function caveatsFor(symbol: AssetSymbol, signedAt: number): Caveat[] {
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
      terms: ethers.concat([asset.token as string, u256(asset.periodAmount), u256(PERIOD_SECONDS), u256(signedAt)]),
      args: '0x',
    },
    { enforcer: CONTRACTS.valueLteEnforcer, terms: ethers.ZeroHash, args: '0x' },
    expiry,
  ];
}

const ERC20 = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);

/**
 * A one-off permission's caveats: exactly this recipient, exactly this amount,
 * spendable once, until expiresAt. Mirror of oneOffCaveats in
 * lib/custody/delegations.js, which explains each caveat.
 */
export function oneOffCaveats(symbol: AssetSymbol, p: { to: string; amount: bigint; expiresAt: number }): Caveat[] {
  const asset = ASSETS[symbol];
  if (!asset) throw new Error(`no permission is defined for ${symbol}`);
  if (typeof p.amount !== 'bigint' || p.amount <= 0n) throw new Error('amount must be a positive bigint');
  wholeSeconds(p.expiresAt, 'expiresAt');
  const recipient = ethers.getAddress(p.to);
  const expiry = { enforcer: CONTRACTS.timestampEnforcer, terms: timestampTerms(p.expiresAt), args: '0x' };
  if (asset.kind === 'native') {
    return [
      { enforcer: CONTRACTS.nativeTokenTransferAmountEnforcer, terms: u256(p.amount), args: '0x' },
      { enforcer: CONTRACTS.allowedTargetsEnforcer, terms: recipient.toLowerCase(), args: '0x' },
      { enforcer: CONTRACTS.exactCalldataEnforcer, terms: '0x', args: '0x' },
      expiry,
    ];
  }
  return [
    { enforcer: CONTRACTS.erc20TransferAmountEnforcer, terms: ethers.concat([asset.token as string, u256(p.amount)]), args: '0x' },
    { enforcer: CONTRACTS.exactCalldataEnforcer, terms: ERC20.encodeFunctionData('transfer', [recipient, p.amount]), args: '0x' },
    { enforcer: CONTRACTS.valueLteEnforcer, terms: ethers.ZeroHash, args: '0x' },
    expiry,
  ];
}

/** An unsigned one-off permission for one payment. */
export function buildOneOff(p: {
  account: string;
  delegate: string;
  symbol: AssetSymbol;
  to: string;
  amount: bigint;
  expiresAt: number;
  salt: bigint;
}): AssetDelegation {
  const delegator = ethers.getAddress(p.account);
  const relayer = ethers.getAddress(p.delegate);
  if (delegator === relayer) throw new Error('an account cannot delegate to itself');
  if (typeof p.salt !== 'bigint' || p.salt <= 0n) throw new Error('a positive salt is required');
  return {
    symbol: p.symbol,
    delegation: {
      delegate: relayer,
      delegator,
      authority: ROOT_AUTHORITY,
      caveats: oneOffCaveats(p.symbol, { to: p.to, amount: p.amount, expiresAt: p.expiresAt }),
      salt: p.salt,
      signature: '0x',
    },
  };
}

export function buildDelegations(p: {
  account: string;
  delegate: string;
  signedAt: number;
  salts: Partial<Record<AssetSymbol, bigint>>;
}): AssetDelegation[] {
  const delegator = ethers.getAddress(p.account);
  const to = ethers.getAddress(p.delegate);
  if (delegator === to) throw new Error('an account cannot delegate to itself');
  return ASSET_ORDER.map((symbol) => {
    const salt = p.salts?.[symbol];
    if (typeof salt !== 'bigint' || salt <= 0n) throw new Error(`a positive salt is required for ${symbol}`);
    return {
      symbol,
      delegation: { delegate: to, delegator, authority: ROOT_AUTHORITY, caveats: caveatsFor(symbol, p.signedAt), salt, signature: '0x' },
    };
  });
}

function caveatsHash(caveats: Caveat[]): string {
  return ethers.keccak256(
    ethers.concat(
      caveats.map((c) => ethers.keccak256(abi.encode(['bytes32', 'address', 'bytes32'], [CAVEAT_TYPEHASH, c.enforcer, ethers.keccak256(c.terms)])))
    )
  );
}

export function delegationStructHash(d: Delegation): string {
  return ethers.keccak256(
    abi.encode(
      ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'uint256'],
      [DELEGATION_TYPEHASH, d.delegate, d.delegator, d.authority, caveatsHash(d.caveats), d.salt]
    )
  );
}

/** The digest the account's passkey signs and isValidSignature is asked about. */
export function delegationDigest(d: Delegation): string {
  const domain = { name: 'DelegationManager', version: '1', chainId: CHAIN_ID, verifyingContract: CONTRACTS.delegationManager };
  return ethers.keccak256(ethers.concat(['0x1901', ethers.TypedDataEncoder.hashDomain(domain), delegationStructHash(d)]));
}
