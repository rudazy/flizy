/**
 * Call-through minting for collections Flizy does not control.
 *
 * A contract that does not name FlizyDrop as its minter is "Contract-managed":
 * Flizy only calls the contract's own public mint function from the person's
 * wallet. Its price, limits, phases and allowlists are whatever the contract
 * enforces; Flizy shows what it can read and claims nothing else.
 *
 * V1 supports four mint shapes, found by their selector in the runtime
 * bytecode (a PUSH4 of the selector):
 *   claim()              one token, free
 *   mint()               one token, payable
 *   mint(uint256)        quantity, payable
 *   publicMint(uint256)  quantity, payable
 * A price is read from mintPrice(), price(), cost() or PRICE() when the
 * contract has one. Whether a given wallet can mint right now is never
 * assumed: the exact call is simulated from that wallet first.
 *
 * Detection and call building are pure (bytecode in, answer out) and covered
 * by test/mintExternal.test.js.
 */

import { ethers } from 'ethers';

export type ExternalMintFn = 'claim' | 'mint' | 'mint_qty' | 'public_mint_qty';

const SELECTORS: Record<ExternalMintFn, string> = {
  claim: '4e71d92d', // claim()
  mint: '1249c58b', // mint()
  mint_qty: 'a0712d68', // mint(uint256)
  public_mint_qty: '2db11544', // publicMint(uint256)
};

const FRAGMENTS: Record<ExternalMintFn, string> = {
  claim: 'function claim()',
  mint: 'function mint() payable',
  mint_qty: 'function mint(uint256 quantity) payable',
  public_mint_qty: 'function publicMint(uint256 quantity) payable',
};

/** Preference when a contract has several: quantity mints first, the free claim before a bare mint(). */
const ORDER: ExternalMintFn[] = ['public_mint_qty', 'mint_qty', 'claim', 'mint'];

export const EXTERNAL_MINT_FNS = ORDER;

/** Which supported mint functions the runtime bytecode contains. */
export function detectMintFns(runtimeHex: string): ExternalMintFn[] {
  const code = runtimeHex.toLowerCase().replace(/^0x/, '');
  return ORDER.filter((fn) => code.includes(`63${SELECTORS[fn]}`));
}

export function takesQuantity(fn: ExternalMintFn): boolean {
  return fn === 'mint_qty' || fn === 'public_mint_qty';
}

/** The call to send: data and value for `quantity` tokens at `priceWei` each (null = free / unknown). */
export function externalMintCall(
  fn: ExternalMintFn,
  quantity: number,
  priceWei: string | null
): { data: string; value: bigint } {
  if (!takesQuantity(fn) && quantity !== 1) throw new Error('This collection mints one token at a time.');
  const iface = new ethers.Interface([FRAGMENTS[fn]]);
  const name = fn === 'public_mint_qty' ? 'publicMint' : fn === 'claim' ? 'claim' : 'mint';
  const data = takesQuantity(fn) ? iface.encodeFunctionData(name, [BigInt(quantity)]) : iface.encodeFunctionData(name, []);
  const each = fn === 'claim' || priceWei == null ? 0n : BigInt(priceWei);
  return { data, value: each * BigInt(quantity) };
}

const READ_ABI = [
  'function name() view returns (string)',
  'function owner() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function PRICE() view returns (uint256)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function flizyMinter() view returns (address)',
];

export type ExternalDetection = {
  isContract: boolean;
  erc721: boolean;
  name: string | null;
  owner: string | null;
  totalSupply: number | null;
  maxSupply: number | null;
  priceWei: string | null;
  mintFns: ExternalMintFn[];
  flizyMinter: string | null;
};

async function first<T>(calls: Array<() => Promise<T>>): Promise<T | null> {
  for (const call of calls) {
    try {
      return await call();
    } catch {
      // try the next accessor
    }
  }
  return null;
}

/** Everything Flizy can read about a contract it might mint through. Read-only. */
export async function detectExternal(provider: ethers.Provider, address: string): Promise<ExternalDetection> {
  const code = await provider.getCode(address);
  const empty: ExternalDetection = {
    isContract: false,
    erc721: false,
    name: null,
    owner: null,
    totalSupply: null,
    maxSupply: null,
    priceWei: null,
    mintFns: [],
    flizyMinter: null,
  };
  if (!code || code === '0x') return empty;
  const c = new ethers.Contract(address, READ_ABI, provider);
  const [erc721, name, owner, totalSupply, maxSupply, priceWei, flizyMinter] = await Promise.all([
    c.supportsInterface('0x80ac58cd').then(Boolean).catch(() => false),
    c.name().then(String).catch(() => null),
    c.owner().then((v: string) => ethers.getAddress(v)).catch(() => null),
    c.totalSupply().then((v: bigint) => Number(v)).catch(() => null),
    first([() => c.maxSupply(), () => c.MAX_SUPPLY()]).then((v) => (v == null ? null : Number(v))),
    first([() => c.mintPrice(), () => c.price(), () => c.cost(), () => c.PRICE()]).then((v) =>
      v == null ? null : (v as bigint).toString()
    ),
    c.flizyMinter().then((v: string) => ethers.getAddress(v)).catch(() => null),
  ]);
  return {
    isContract: true,
    erc721,
    name,
    owner,
    totalSupply,
    maxSupply,
    priceWei,
    mintFns: detectMintFns(code),
    flizyMinter,
  };
}

export type Simulation = { ok: true } | { ok: false; reason: string };

/** Revert text a person can read, from an eth_call error. */
export function revertReason(err: unknown): string {
  const e = err as { reason?: string; shortMessage?: string; data?: string; info?: { error?: { message?: string } } };
  // The contract's own text, shown as text; capped because the contract chooses it.
  if (typeof e?.reason === 'string' && e.reason) return e.reason.slice(0, 200);
  const data = typeof e?.data === 'string' ? e.data : null;
  if (data && data.startsWith('0x08c379a0')) {
    try {
      return String(ethers.AbiCoder.defaultAbiCoder().decode(['string'], ethers.dataSlice(data, 4))[0]).slice(0, 200);
    } catch {
      // fall through
    }
  }
  return 'The contract refused this mint for your wallet.';
}

/** Run the exact call from `from` without sending it. */
export async function simulateCall(
  provider: ethers.Provider,
  from: string,
  to: string,
  call: { data: string; value: bigint }
): Promise<Simulation> {
  try {
    await provider.call({ from, to, data: call.data, value: call.value });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: revertReason(err) };
  }
}
