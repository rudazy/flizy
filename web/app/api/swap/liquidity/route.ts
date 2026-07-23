import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import {
  getWebChain,
  getDexAddresses,
  resolveToken,
  addLiquidityEth,
  deriveAgentWallet,
  explorerTxUrl,
} from '../../../../lib/dexServer';

/** Site-only: add ETH + FLZ liquidity from agent wallet. */
export async function POST(req: Request) {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const amountEth = String(body.amountEth || '');
    const amountToken = String(body.amountToken || body.amountFlz || '');
    const tokenRaw = String(body.token || 'FLZ');

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const dex = getDexAddresses();
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

    const signer = deriveAgentWallet(accountId).connect(provider);
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
      txHash: result.txHash,
      explorerUrl: explorerTxUrl(chain, result.txHash),
      pair: dex.pair,
      note: 'Liquidity added. LP tokens are in your agent wallet.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Add liquidity failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
