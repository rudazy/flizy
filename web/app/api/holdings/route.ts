import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { getDexAddresses } from '../../../lib/dexServer';

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
    }> = [];

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
      const tracked: Array<{ address: string; symbol: string; decimals: number | null }> = [
        { address: dex.flz, symbol: 'FLZ', decimals: 18 },
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

      const erc20Abi = [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
      ];
      for (const t of tracked) {
        try {
          const c = new ethers.Contract(t.address, erc20Abi, provider);
          const [b, d, s] = await Promise.all([
            c.balanceOf(wallet),
            t.decimals != null ? Promise.resolve(t.decimals) : c.decimals(),
            t.symbol ? Promise.resolve(t.symbol) : c.symbol(),
          ]);
          tokens.push({
            symbol: String(s),
            address: t.address,
            balance: ethers.formatUnits(b, Number(d)),
          });
        } catch {
          tokens.push({
            symbol: t.symbol || 'TOKEN',
            address: t.address,
            balance: null,
            error: 'Could not read',
          });
        }
      }
    }

    return NextResponse.json({
      credit: account.balance_eth ?? 0,
      agent_wallet_address: account.agent_wallet_address,
      holdings: {
        chain: { name: 'GIWA Sepolia', chainId, explorerBaseUrl: explorer },
        native,
        tokens,
        note:
          tokens.length === 0
            ? 'Native balance shown. FLZ appears once the agent wallet is funded and DEX is live.'
            : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Holdings failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
