/**
 * Creator and seller earnings that wait on chain to be withdrawn.
 *
 * GET answers what the signed-in account's Flizy wallet can withdraw: ETH from
 * NFT sales held by FlizyMarketplace (`market`) and ETH from mint sales held
 * by FlizyDrop (`drop`), as wei strings, or null where that contract is not
 * configured. POST withdraws the drop credits; the marketplace credits are
 * withdrawn through POST /api/market/withdraw, which already exists.
 *
 * Withdrawing is never paused (web/lib/features.ts): it only returns money to
 * the wallet it belongs to. Each contract pays msg.sender, so the call works
 * only from that wallet, and it goes through runMintTx: the PIN when the tier
 * asks, the account lock, and a History row.
 */

import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { apiErrorBody } from '../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { nftContext, viewerWallet } from '../../../lib/nftApi.ts';
import { explorerTxUrl } from '../../../lib/dexServer';
import { MARKET_ABI } from '../../../lib/nftMarket.ts';
import { DROP_IFACE, mintConfig } from '../../../lib/mintDrop.ts';
import { MintError, runMintTx } from '../../../lib/mintExecute.ts';
import { clientErrorResponse, field, readJson } from '../../../lib/mintRequest.ts';

export const dynamic = 'force-dynamic';

const MARKET = new ethers.Interface(MARKET_ABI as unknown as ethers.InterfaceAbi);

async function readCredits(provider: ethers.Provider, contract: string, iface: ethers.Interface, wallet: string): Promise<bigint> {
  const data = iface.encodeFunctionData('credits', [wallet]);
  const [value] = iface.decodeFunctionResult('credits', await provider.call({ to: contract, data }));
  return BigInt(value);
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const ctx = nftContext();
    const viewer = await viewerWallet(accountId);
    const drop = mintConfig();
    const [market, minted] = await Promise.all([
      ctx.market ? readCredits(ctx.provider, ctx.market.address, MARKET, viewer.address).catch(() => null) : null,
      drop ? readCredits(ctx.provider, drop.drop, DROP_IFACE, viewer.address).catch(() => null) : null,
    ]);
    return NextResponse.json({ market: market == null ? null : market.toString(), drop: minted == null ? null : minted.toString() });
  } catch (err) {
    return NextResponse.json(apiErrorBody('GET /api/earnings', err), { status: 500 });
  }
}

export async function POST(req: Request) {
  const route = 'POST /api/earnings';
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await readJson(req);
    const drop = mintConfig();
    if (!drop) throw new MintError('Mint sales are not on Flizy here.', 503);
    const ctx = nftContext();
    const viewer = await viewerWallet(accountId);
    const credit = await readCredits(ctx.provider, drop.drop, DROP_IFACE, viewer.address);
    if (credit === 0n) throw new MintError('Nothing to withdraw.');

    const { txHash } = await runMintTx({
      supabase: getSupabase(),
      ctx,
      accountId,
      viewer,
      pin: String(field(body, 'pin') || ''),
      tx: {
        calls: [{ target: drop.drop, value: 0n, data: DROP_IFACE.encodeFunctionData('withdraw', []) }],
        value: 0n,
        label: `Withdraw ${ethers.formatEther(credit)} ETH from mint sales`,
        reason: 'withdraw your mint sales',
        to: drop.drop,
      },
    });
    return NextResponse.json({ ok: true, txHash, explorerUrl: explorerTxUrl(ctx.chain, txHash) });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(route, err), { status: 500 });
  }
}
