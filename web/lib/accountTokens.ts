/**
 * Tokens a person added so a deposit shows on the wallet.
 *
 * The chain already accepts any token sent to the Flizy address. This list is
 * how the wallet knows which contracts to read. A row here is not a
 * verification, and it is not a market listing.
 */

import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';
import {
  MAX_ACCOUNT_TOKENS,
  parseTokenContract,
  tokenDecimalsFromChain,
  tokenSymbolFromChain,
} from './accountToken.ts';
import { listedByAddress } from './listedTokens.ts';

/** Same fallback the swap config uses when the chain env is unset. */
const FLZ_FALLBACK = '0x308be8f71da695f18e70d2243a446e1fd1566ba6';

export type Db = ReturnType<typeof getSupabase>;

function db(client?: Db): Db {
  return client ?? getSupabase();
}

export type SavedToken = {
  address: string;
  symbol: string;
  decimals: number;
};

export type TokenChain = {
  meta(address: string): Promise<{ symbol: string; decimals: number }>;
  balance(token: string, wallet: string): Promise<string | null>;
};

export type HeldToken = {
  address: string;
  symbol: string;
  decimals: number;
  balance: string | null;
  verified: false;
  /** A token Flizy lists with a pool it seeded (listedTokens.ts). Still not verified. */
  listed: boolean;
  chainName: string;
  explorerBaseUrl: string;
};

type Deps = {
  client?: Db;
  chain?: TokenChain;
  flzAddress?: string;
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

const NOT_IN_WALLET =
  'This token is not in your Flizy wallet. Send it to your Flizy address, then add the contract on Wallet.';

function flzAddress(deps: Deps): string {
  return ethers.getAddress(deps.flzAddress || process.env.CHAIN_GIWA_SEPOLIA_FLZ || FLZ_FALLBACK);
}

function checksum(raw: string): string {
  const parsed = parseTokenContract(raw);
  if ('error' in parsed) throw new ClientError(parsed.error);
  return ethers.getAddress(parsed.address);
}

async function defaultChain(): Promise<TokenChain> {
  // Same env fallback as getWebChain in dexServer.ts, so both read one chain.
  const rpc = process.env.GIWA_RPC || process.env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io';
  const chainId = Number(process.env.GIWA_CHAIN_ID || 91342);
  const provider = new ethers.JsonRpcProvider(rpc, chainId);
  return {
    async meta(address) {
      const contract = new ethers.Contract(address, ERC20_ABI, provider);
      try {
        const [symbol, decimals] = await Promise.all([contract.symbol(), contract.decimals()]);
        const parsed = tokenDecimalsFromChain(decimals);
        if (parsed == null) throw new ClientError('That contract did not answer as a token.');
        return { symbol: tokenSymbolFromChain(symbol, address), decimals: parsed };
      } catch (err) {
        if (err instanceof ClientError) throw err;
        throw new ClientError('That contract did not answer as a token.');
      }
    },
    async balance(token, wallet) {
      try {
        const contract = new ethers.Contract(token, ERC20_ABI, provider);
        const [amount, decimals] = await Promise.all([contract.balanceOf(wallet), contract.decimals()]);
        const parsed = tokenDecimalsFromChain(decimals);
        if (parsed == null) return null;
        return ethers.formatUnits(amount, parsed);
      } catch {
        return null;
      }
    },
  };
}

async function walletOf(accountId: string, supabase: Db): Promise<string | null> {
  const { data, error } = await supabase
    .from('accounts')
    .select('agent_wallet_address')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  const raw = data.agent_wallet_address;
  if (!raw || !ethers.isAddress(String(raw))) return null;
  return ethers.getAddress(String(raw));
}

export async function listAccountTokens(accountId: string, client?: Db): Promise<SavedToken[]> {
  const supabase = db(client);
  const { data, error } = await supabase
    .from('account_tokens')
    .select('address, symbol, decimals')
    .eq('account_id', accountId);
  if (error) throw new Error('could not read tokens');
  return (data || []).map((row) => ({
    address: String(row.address),
    symbol: String(row.symbol),
    decimals: Number(row.decimals),
  }));
}

/** What the contract says about itself, read before anything is saved. */
export async function previewAccountToken(raw: string, deps: Deps = {}): Promise<SavedToken> {
  const address = checksum(raw);
  if (address === flzAddress(deps)) throw new ClientError('FLZ is already on your wallet.');
  const chain = deps.chain || (await defaultChain());
  const meta = await chain.meta(address);
  return { address, symbol: meta.symbol, decimals: meta.decimals };
}

/**
 * What the person typed for the symbol and decimals. The saved row always takes
 * both from the contract; a value typed here only has to agree with it, so a
 * wrong decimals can never scale a balance.
 */
export type ClaimedToken = { symbol?: string | null; decimals?: number | null };

export async function addAccountToken(accountId: string, raw: string, deps: Deps = {}, claimed: ClaimedToken = {}) {
  const address = checksum(raw);
  if (address === flzAddress(deps)) throw new ClientError('FLZ is already on your wallet.');
  const supabase = db(deps.client);
  const existing = await listAccountTokens(accountId, supabase);
  const already = existing.some((row) => row.address === address);
  if (!already && existing.length >= MAX_ACCOUNT_TOKENS) {
    throw new ClientError('50 tokens is the limit.');
  }
  const chain = deps.chain || (await defaultChain());
  const meta = await chain.meta(address);
  const symbol = typeof claimed.symbol === 'string' ? claimed.symbol.trim() : '';
  if (symbol && symbol.toUpperCase() !== meta.symbol.toUpperCase()) {
    throw new ClientError(`That contract's symbol is ${meta.symbol}.`);
  }
  if (claimed.decimals != null && claimed.decimals !== meta.decimals) {
    throw new ClientError(`That contract uses ${meta.decimals} decimals.`);
  }
  const { error } = await supabase.from('account_tokens').upsert(
    {
      account_id: accountId,
      address,
      symbol: meta.symbol,
      decimals: meta.decimals,
    },
    { onConflict: 'account_id,address' }
  );
  if (error) {
    // Raised by the account_tokens insert trigger, which holds the cap under a
    // lock where the count above cannot.
    if (/account_tokens_cap/.test(error.message || '')) {
      throw new ClientError('50 tokens is the limit.');
    }
    if (/account_tokens_rate/.test(error.message || '')) {
      throw new ClientError('Too many tokens added in the last hour. Try again later.');
    }
    throw new Error('could not save token');
  }
  const wallet = await walletOf(accountId, supabase);
  const balance = wallet ? await chain.balance(address, wallet) : null;
  return { address, symbol: meta.symbol, decimals: meta.decimals, balance };
}

export async function removeAccountToken(accountId: string, raw: string, deps: Deps = {}) {
  const address = checksum(raw);
  if (address === flzAddress(deps)) throw new ClientError('FLZ stays on the wallet.');
  const supabase = db(deps.client);
  const { data, error } = await supabase
    .from('account_tokens')
    .delete()
    .eq('account_id', accountId)
    .eq('address', address)
    .select('address');
  if (error) throw new Error('could not remove token');
  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) throw new ClientError('That token is not one you added.');
  return { address };
}

export async function describeHeldToken(
  accountId: string,
  raw: string,
  deps: Deps = {}
): Promise<{ listedSymbol: 'flz' } | { missing: string } | { held: HeldToken }> {
  let address: string;
  try {
    address = checksum(raw);
  } catch (err) {
    if (err instanceof ClientError) return { missing: 'This token is not listed.' };
    throw err;
  }
  if (address === flzAddress(deps)) return { listedSymbol: 'flz' };
  const listed = listedByAddress(address);
  const supabase = db(deps.client);
  const saved = (await listAccountTokens(accountId, supabase)).find((row) => row.address === address);
  const chain = deps.chain || (await defaultChain());
  const wallet = await walletOf(accountId, supabase);
  const balance = wallet ? await chain.balance(address, wallet) : null;
  const holdsSome = balance != null && Number(balance) > 0;
  // A listed token opens for anyone, so it can be bought before it is held.
  if (!listed && !saved && !holdsSome) return { missing: NOT_IN_WALLET };

  let symbol = listed?.symbol ?? saved?.symbol;
  let decimals = listed?.decimals ?? saved?.decimals;
  if (!listed && !saved) {
    const meta = await chain.meta(address);
    symbol = meta.symbol;
    decimals = meta.decimals;
  }
  const explorer = (
    process.env.GIWA_EXPLORER ||
    process.env.CHAIN_GIWA_SEPOLIA_EXPLORER ||
    'https://sepolia-explorer.giwa.io'
  ).replace(/\/$/, '');
  return {
    held: {
      address,
      symbol: symbol || tokenSymbolFromChain('', address),
      decimals: decimals ?? 18,
      balance,
      verified: false,
      listed: listed != null,
      chainName: 'GIWA Sepolia',
      explorerBaseUrl: explorer,
    },
  };
}
