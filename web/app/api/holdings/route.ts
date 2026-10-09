import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { getDexAddresses } from '../../../lib/dexServer';
import { apiErrorBody } from '../../../lib/apiError';
import { loadNftHoldings } from '../../../lib/listedNfts.ts';
import { listAccountTokens } from '../../../lib/accountTokens';
import { LISTED_TOKENS } from '../../../lib/listedTokens';

const ROUTE = 'GET /api/holdings';

const TOKEN_READ_BATCH = 8;
const TOKEN_READ_MS = 8000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('token read timed out')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const supabase = getSupabase();
    const { data: account, error } = await supabase
      .from('accounts')
      .select('id, agent_wallet_address, balance_eth')
      .eq('id', accountId)
      .single();
    if (error || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const { ethers } = await import('ethers');
    const rpc = process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
    const chainId = Number(process.env.GIWA_CHAIN_ID || 91342);
    const explorer = (process.env.GIWA_EXPLORER || 'https://sepolia-explorer.giwa.io').replace(
      /\/$/,
      ''
    );
    const nativeSymbol = 'ETH';
    const dex = getDexAddresses();

    let native = null;
    const tokens: Array<{
      symbol: string;
      address: string | null;
      balance: string | null;
      error?: string;
      verified?: boolean;
      added?: boolean;
    }> = [];
    let nfts: Awaited<ReturnType<typeof loadNftHoldings>> = [];

    if (account.agent_wallet_address && ethers.isAddress(account.agent_wallet_address)) {
      const provider = new ethers.JsonRpcProvider(rpc, chainId);
      const wallet = ethers.getAddress(account.agent_wallet_address);
      const bal = await provider.getBalance(wallet);
      native = {
        symbol: nativeSymbol,
        balance: ethers.formatEther(bal),
        address: null as string | null,
      };

      // Always include FLZ from deployed DEX addresses (not env-only)
      const tracked: Array<{
        address: string;
        symbol: string;
        decimals: number | null;
        verified?: boolean;
        added?: boolean;
      }> = [
        { address: dex.flz, symbol: 'FLZ', decimals: 18, verified: true },
        // Listed tokens are read for every wallet, so one bought on Flizy shows
        // without being added by hand.
        ...LISTED_TOKENS.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals, verified: false })),
      ];
      const raw = process.env.TRACKED_TOKENS || '';
      for (const part of raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)) {
        const [address, symbol, decimals] = part.split(':');
        if (!address || !ethers.isAddress(address)) continue;
        const addr = ethers.getAddress(address);
        if (tracked.some((t) => t.address.toLowerCase() === addr.toLowerCase())) continue;
        tracked.push({
          address: addr,
          symbol: symbol || 'TOKEN',
          decimals: decimals != null && decimals !== '' ? Number(decimals) : null,
        });
      }

      // Added tokens are extra rows, not the balance. If they cannot be read,
      // the wallet still shows ETH, FLZ and NFTs instead of failing whole.
      let saved: Awaited<ReturnType<typeof listAccountTokens>> = [];
      try {
        saved = await listAccountTokens(accountId);
      } catch {
        // listAccountTokens throws one fixed message, so there is nothing more to log.
        console.warn(`[${ROUTE}] added tokens unavailable`);
      }
      for (const row of saved) {
        if (tracked.some((t) => t.address.toLowerCase() === row.address.toLowerCase())) continue;
        tracked.push({
          address: row.address,
          symbol: row.symbol,
          decimals: row.decimals,
          verified: false,
          added: true,
        });
      }

      const erc20Abi = [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
      ];
      // Up to 50 added tokens plus the tracked ones. Read in small parallel
      // batches, each with its own deadline, so one slow or hostile contract
      // cannot hold the whole response until the platform timeout.
      const readToken = async (t: (typeof tracked)[number]) => {
        try {
          const c = new ethers.Contract(t.address, erc20Abi, provider);
          const [b, d, s] = await withDeadline(
            Promise.all([
              c.balanceOf(wallet),
              t.decimals != null ? Promise.resolve(t.decimals) : c.decimals(),
              t.symbol ? Promise.resolve(t.symbol) : c.symbol(),
            ]),
            TOKEN_READ_MS
          );
          return {
            symbol: String(s),
            address: t.address,
            balance: ethers.formatUnits(b, Number(d)),
            verified: t.verified === true,
            added: t.added === true,
          };
        } catch {
          return {
            symbol: t.symbol || 'TOKEN',
            address: t.address,
            balance: null,
            error: 'Could not read',
            verified: t.verified === true,
            added: t.added === true,
          };
        }
      };
      for (let i = 0; i < tracked.length; i += TOKEN_READ_BATCH) {
        tokens.push(...(await Promise.all(tracked.slice(i, i + TOKEN_READ_BATCH).map(readToken))));
      }

      nfts = await loadNftHoldings(provider, wallet);
    }

    return NextResponse.json({
      credit: account.balance_eth ?? 0,
      agent_wallet_address: account.agent_wallet_address,
      holdings: {
        chain: { name: 'GIWA Sepolia', chainId, explorerBaseUrl: explorer },
        native,
        tokens,
        nfts,
        note:
          tokens.length === 0 && !nfts.length
            ? 'Native balance shown. Add a token contract on Balances to see a deposit other than ETH.'
            : null,
      },
    });
  } catch (err) {
    // An RPC failure here used to hand the client the provider URL and the
    // failing call. Both belong in the journal only.
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
