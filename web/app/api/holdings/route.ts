import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';

export async function GET() {
  try {
    const accountId = getAccountIdFromCookie();
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

    // Inline holdings fetch so web does not depend on broken parent require on Vercel
    const { ethers } = await import('ethers');
    const rpc = process.env.GIWA_RPC || 'https://sepolia-rpc.giwa.io';
    const chainId = Number(process.env.GIWA_CHAIN_ID || 91342);
    const explorer = (process.env.GIWA_EXPLORER || 'https://sepolia-explorer.giwa.io').replace(
      /\/$/,
      ''
    );
    const nativeSymbol = 'ETH';

    let native = null;
    const tokens: Array<{
      symbol: string;
      address: string | null;
      balance: string | null;
      error?: string;
    }> = [];

    if (account.agent_wallet_address && ethers.isAddress(account.agent_wallet_address)) {
      const provider = new ethers.JsonRpcProvider(rpc, chainId);
      const bal = await provider.getBalance(account.agent_wallet_address);
      native = {
        symbol: nativeSymbol,
        balance: ethers.formatEther(bal),
        address: null as string | null,
      };

      const raw = process.env.TRACKED_TOKENS || '';
      const tracked = raw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const erc20Abi = [
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
      ];
      for (const part of tracked) {
        const [address, symbol, decimals] = part.split(':');
        if (!address || !ethers.isAddress(address)) continue;
        try {
          const c = new ethers.Contract(address, erc20Abi, provider);
          const [b, d, s] = await Promise.all([
            c.balanceOf(account.agent_wallet_address),
            decimals != null && decimals !== '' ? Promise.resolve(Number(decimals)) : c.decimals(),
            symbol ? Promise.resolve(symbol) : c.symbol(),
          ]);
          tokens.push({
            symbol: String(s),
            address: ethers.getAddress(address),
            balance: ethers.formatUnits(b, Number(d)),
          });
        } catch {
          tokens.push({
            symbol: symbol || 'TOKEN',
            address,
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
            ? 'Native balance shown. Extra tokens via TRACKED_TOKENS. Full DEX token list later.'
            : null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Holdings failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
