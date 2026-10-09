import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import {
  getWebChain,
  liquidityPool,
  addLiquidityEth,
  addLiquidityEthViaGator,
  removeLiquidityEth,
  removeLiquidityEthViaGator,
  getLpPosition,
  deriveAgentWallet,
  explorerTxUrl,
} from '../../../../lib/dexServer';
import { apiErrorBody } from '../../../../lib/apiError';
import { getSupabase } from '../../../../lib/supabase';
import { maybeMarkFirstTx } from '../../../../lib/invite.ts';
import { tryAccountTxLock, releaseAccountTxLock } from '../../../../lib/accountTxLock.ts';
import { pointerIsGator } from '../../../../lib/gatorExecute.ts';
import { predictGatorAddress } from '../../../../lib/gatorAccount.ts';

const ROUTE_GET = 'GET /api/swap/liquidity';
const ROUTE_POST = 'POST /api/swap/liquidity';

/** Refused before anything is read: liquidity is only for pools Flizy seeded. */
const NOT_A_POOL = 'Liquidity is for FLZ and the listed tokens only.';

/** Site-only: current LP position in one pool (?token=FLZ by default) for the logged-in agent wallet. */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const pool = liquidityPool(new URL(req.url).searchParams.get('token'));
    if (!pool) return NextResponse.json({ error: NOT_A_POOL }, { status: 400 });

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const { data: acct } = await getSupabase()
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', accountId)
      .maybeSingle();
    // LP tokens follow the pointer, so read the position off the gator.
    const walletAddr = pointerIsGator(accountId, acct?.agent_wallet_address)
      ? predictGatorAddress(accountId)
      : deriveAgentWallet(accountId).address;
    const position = await getLpPosition(provider, walletAddr, pool);

    return NextResponse.json({
      agentWallet: walletAddr,
      symbol: pool.symbol,
      pair: pool.pair,
      token: pool.token,
      lpBalanceFormatted: position.lpBalanceFormatted,
      totalSupply: position.totalSupply,
      ethShare: position.ethShare,
      tokenShare: position.tokenShare,
      poolShareBps: position.poolShareBps,
      hasPosition: position.lpBalance > 0n,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE_GET, err), { status: 500 });
  }
}

/**
 * Site-only liquidity mutations, in one pool named by body.token (FLZ by default).
 * body.action: "add" (default) | "remove"
 * remove: percent 1-100 or liquidity amount (LP token units as decimal string)
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const supabase = getSupabase();
    const body = await req.json();
    const pool = liquidityPool(body.token == null ? null : String(body.token));
    if (!pool) return NextResponse.json({ error: NOT_A_POOL }, { status: 400 });
    const auth = await requirePassword(
      supabase,
      accountId,
      String(body.password || ''),
      'change liquidity'
    );
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }

    const lock = await tryAccountTxLock(supabase, accountId, 'liquidity');
    if (!lock.ok) {
      return NextResponse.json({ error: lock.error }, { status: 409 });
    }

    try {
    const action = String(body.action || 'add').toLowerCase();
    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const signer = deriveAgentWallet(accountId).connect(provider);
    const { data: acct } = await supabase
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', accountId)
      .maybeSingle();
    const viaGator = pointerIsGator(accountId, acct?.agent_wallet_address);
    const walletAddr = viaGator ? predictGatorAddress(accountId) : signer.address;

    if (action === 'remove') {
      const position = await getLpPosition(provider, walletAddr, pool);
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
        tokenMin = (position.tokenShareWei * liquidityWei * 98n) / (position.lpBalance * 100n);
      }

      const result = viaGator
        ? await removeLiquidityEthViaGator({
            accountId,
            provider,
            chainId: chain.chainId,
            pool,
            liquidityWei,
            amountTokenMin: tokenMin,
            amountEthMin: ethMin,
            recipient: walletAddr,
          })
        : await removeLiquidityEth({
            signer,
            pool,
            liquidityWei,
            amountTokenMin: tokenMin,
            amountEthMin: ethMin,
            recipient: signer.address,
          });

      try {
        await maybeMarkFirstTx(getSupabase(), {
          accountId,
          kind: 'remove_liquidity',
          amount: ethers.formatEther(liquidityWei),
          ok: true,
        });
      } catch (hookErr) {
        console.warn(
          '[invite] first tx hook:',
          hookErr instanceof Error ? hookErr.message : hookErr
        );
      }

      return NextResponse.json({
        ok: true,
        action: 'remove',
        txHash: result.txHash,
        explorerUrl: explorerTxUrl(chain, result.txHash),
        liquidityBurned: ethers.formatEther(liquidityWei),
        pair: pool.pair,
        note: `Liquidity removed. ETH and ${pool.symbol} returned to your Flizy wallet.`,
      });
    }

    // add (default)
    const amountEth = String(body.amountEth || '');
    const amountToken = String(body.amountToken || body.amountFlz || '');
    const tokenAddress = pool.token;

    let ethWei: bigint;
    let tokenWei: bigint;
    try {
      ethWei = ethers.parseEther(amountEth);
      tokenWei = ethers.parseUnits(amountToken, pool.decimals);
    } catch {
      return NextResponse.json({ error: 'Invalid amounts' }, { status: 400 });
    }
    if (ethWei <= 0n || tokenWei <= 0n) {
      return NextResponse.json({ error: 'Invalid amounts' }, { status: 400 });
    }

    const amountTokenMin = tokenWei - tokenWei / 50n;
    const amountEthMin = ethWei - ethWei / 50n;

    const result = viaGator
      ? await addLiquidityEthViaGator({
          accountId,
          provider,
          chainId: chain.chainId,
          tokenAddress,
          amountToken: tokenWei,
          amountEth: ethWei,
          amountTokenMin,
          amountEthMin,
          recipient: walletAddr,
        })
      : await addLiquidityEth({
          signer,
          tokenAddress,
          amountToken: tokenWei,
          amountEth: ethWei,
          amountTokenMin,
          amountEthMin,
          recipient: signer.address,
        });

    try {
      await maybeMarkFirstTx(getSupabase(), {
        accountId,
        kind: 'add_liquidity',
        amount: amountEth,
        ok: true,
      });
    } catch (hookErr) {
      console.warn(
        '[invite] first tx hook:',
        hookErr instanceof Error ? hookErr.message : hookErr
      );
    }

    return NextResponse.json({
      ok: true,
      action: 'add',
      txHash: result.txHash,
      explorerUrl: explorerTxUrl(chain, result.txHash),
      pair: pool.pair,
      note: 'Liquidity added. LP tokens are in your Flizy wallet.',
    });
    } finally {
      await releaseAccountTxLock(supabase, accountId);
    }
  } catch (err) {
    // The deliberate 400s above ("No LP tokens to remove", "Invalid amounts")
    // are user-facing on purpose and are untouched.
    return NextResponse.json(apiErrorBody(ROUTE_POST, err), { status: 500 });
  }
}
