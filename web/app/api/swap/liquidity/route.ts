import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import {
  getWebChain,
  getDexAddresses,
  resolveToken,
  addLiquidityEth,
  removeLiquidityEth,
  getLpPosition,
  deriveAgentWallet,
  explorerTxUrl,
} from '../../../../lib/dexServer';

/** Site-only: current LP position for the logged-in agent wallet. */
export async function GET() {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const wallet = deriveAgentWallet(accountId);
    const position = await getLpPosition(provider, wallet.address);
    const dex = getDexAddresses();

    return NextResponse.json({
      agentWallet: wallet.address,
      pair: dex.pair,
      flz: dex.flz,
      lpBalanceFormatted: position.lpBalanceFormatted,
      totalSupply: position.totalSupply,
      ethShare: position.ethShare,
      flzShare: position.flzShare,
      poolShareBps: position.poolShareBps,
      hasPosition: position.lpBalance > 0n,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Position failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Site-only liquidity mutations.
 * body.action: "add" (default) | "remove"
 * remove: percent 1-100 or liquidity amount (LP token units as decimal string)
 */
export async function POST(req: Request) {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const action = String(body.action || 'add').toLowerCase();
    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const dex = getDexAddresses();
    const signer = deriveAgentWallet(accountId).connect(provider);

    if (action === 'remove') {
      const position = await getLpPosition(provider, signer.address);
      if (position.lpBalance <= 0n) {
        return NextResponse.json({ error: 'No LP tokens to remove' }, { status: 400 });
      }

      let liquidityWei: bigint;
      if (body.liquidity != null && String(body.liquidity).trim() !== '') {
        liquidityWei = ethers.parseEther(String(body.liquidity));
      } else {
        const pct = Math.min(100, Math.max(1, Number(body.percent || 100)));
        if (!Number.isFinite(pct)) {
          return NextResponse.json({ error: 'Invalid percent' }, { status: 400 });
        }
        liquidityWei = (position.lpBalance * BigInt(Math.floor(pct))) / 100n;
      }

      if (liquidityWei <= 0n) {
        return NextResponse.json({ error: 'Liquidity amount too small' }, { status: 400 });
      }
      if (liquidityWei > position.lpBalance) liquidityWei = position.lpBalance;

      // 2% min slip vs proportional share of current reserves
      let ethMin = 0n;
      let tokenMin = 0n;
      if (position.lpBalance > 0n) {
        ethMin = (position.ethShareWei * liquidityWei * 98n) / (position.lpBalance * 100n);
        tokenMin = (position.flzShareWei * liquidityWei * 98n) / (position.lpBalance * 100n);
      }

      const result = await removeLiquidityEth({
        signer,
        liquidityWei,
        amountTokenMin: tokenMin,
        amountEthMin: ethMin,
        recipient: signer.address,
      });

      return NextResponse.json({
        ok: true,
        action: 'remove',
        txHash: result.txHash,
        explorerUrl: explorerTxUrl(chain, result.txHash),
        liquidityBurned: ethers.formatEther(liquidityWei),
        pair: dex.pair,
        note: 'Liquidity removed. ETH and FLZ returned to your agent wallet.',
      });
    }

    // add (default)
    const amountEth = String(body.amountEth || '');
    const amountToken = String(body.amountToken || body.amountFlz || '');
    const tokenRaw = String(body.token || 'FLZ');
    const tokenAddress = resolveToken(tokenRaw);
    if (!tokenAddress) {
      return NextResponse.json({ error: 'Token required (e.g. FLZ)' }, { status: 400 });
    }

    const ethWei = ethers.parseEther(amountEth);
    const tokenWei = ethers.parseEther(amountToken);
    if (ethWei <= 0n || tokenWei <= 0n) {
      return NextResponse.json({ error: 'Invalid amounts' }, { status: 400 });
    }

    const amountTokenMin = tokenWei - tokenWei / 50n;
    const amountEthMin = ethWei - ethWei / 50n;

    const result = await addLiquidityEth({
      signer,
      tokenAddress,
      amountToken: tokenWei,
      amountEth: ethWei,
      amountTokenMin,
      amountEthMin,
      recipient: signer.address,
    });

    return NextResponse.json({
      ok: true,
      action: 'add',
      txHash: result.txHash,
      explorerUrl: explorerTxUrl(chain, result.txHash),
      pair: dex.pair,
      note: 'Liquidity added. LP tokens are in your agent wallet.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Liquidity failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
