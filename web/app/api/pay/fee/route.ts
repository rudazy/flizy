import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { getDexAddresses, getWebChain, resolveToken } from '../../../../lib/dexServer';
import { normalizePayAsset, UNKNOWN_PAY_ASSET, type PayAsset } from '../../../../lib/payAsset.ts';
import { gatorGasReserveWei, pointerIsGator } from '../../../../lib/gatorExecute.ts';
import { predictGatorAddress } from '../../../../lib/gatorAccount.ts';
import { feeView, planPayFee, sitePayFee, spendableUnits } from '../../../../lib/payFee.ts';
import { activeFeeConfig } from '../../../../lib/feeQuote.ts';
import { resolvePayRef } from '../../../../lib/payCode.ts';

const ROUTE = 'GET /api/pay/fee';

/**
 * The fee the pay page shows before the payer confirms (web/lib/payFee.ts),
 * planned against what the wallet can spend: on top, or out of the amount
 * with what the payee gets. { fee: null } when none applies, including a
 * payment to a business, whose merchant fee the business pays and the payer
 * never sees. /api/pay/execute plans again and never charges more, or sends
 * less, than this.
 */
export async function GET(req: Request) {
  try {
    const payerId = await getAccountIdFromCookie();
    if (!payerId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const url = new URL(req.url);
    let asset: PayAsset;
    try {
      asset = normalizePayAsset(url.searchParams.get('asset'));
    } catch {
      return NextResponse.json({ error: UNKNOWN_PAY_ASSET }, { status: 400 });
    }

    // Fees off: no fee, and nothing read from the chain. Malformed settings are refused below.
    let on = true;
    try {
      on = activeFeeConfig() !== null;
    } catch {
      on = true;
    }
    if (!on) return NextResponse.json({ fee: null });

    const supabase = getSupabase();
    const payee = await resolvePayRef(supabase, url.searchParams.get('ref'));
    if (!payee?.accountId) return NextResponse.json({ error: 'Pay identity not found.' }, { status: 404 });
    const { data: payeeRow, error: payeeErr } = await supabase.from('accounts').select('is_business').eq('id', payee.accountId).maybeSingle();
    if (payeeErr) return NextResponse.json({ error: 'Could not work out the fee right now. Try again shortly.' }, { status: 503 });
    if (payeeRow?.is_business) return NextResponse.json({ fee: null });

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    let decimals = 18;
    let erc20: ethers.Contract | null = null;
    if (asset !== 'ETH') {
      const token = resolveToken(asset);
      if (!token || !ethers.isAddress(token)) {
        return NextResponse.json({ error: 'That asset is not configured on this chain.' }, { status: 400 });
      }
      erc20 = new ethers.Contract(token, ['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)'], provider);
      decimals = Number(await erc20.decimals());
    }
    let amountUnits: bigint;
    try {
      amountUnits = ethers.parseUnits(String(url.searchParams.get('amount') || ''), decimals);
    } catch {
      return NextResponse.json({ error: 'Invalid amount.' }, { status: 400 });
    }
    if (amountUnits <= 0n) {
      return NextResponse.json({ error: 'Amount must be greater than zero.' }, { status: 400 });
    }

    const { data: payer } = await supabase.from('accounts').select('agent_wallet_address').eq('id', payerId).maybeSingle();
    const d = getDexAddresses();
    const feed = await sitePayFee({
      supabase,
      provider,
      viaGator: pointerIsGator(payerId, payer?.agent_wallet_address),
      asset,
      amountUnits,
      flzPool: { flz: d.flz, pair: d.pair },
    });
    if (!feed.ok) return NextResponse.json({ error: feed.error }, { status: feed.status });
    if (!feed.fee) return NextResponse.json({ fee: null });

    // Only a smart-account wallet carries a fee, so the wallet is its gator.
    const wallet = predictGatorAddress(payerId);
    const holding = erc20 ? BigInt(await erc20.balanceOf(wallet)) : await provider.getBalance(wallet);
    const gas = erc20 ? 0n : await gatorGasReserveWei(provider, wallet);
    const spendable = await spendableUnits(supabase, payerId, asset, holding, gas);
    if (spendable === null) return NextResponse.json({ error: 'Could not read Savings. Try again shortly.' }, { status: 503 });
    const planned = planPayFee(feed.fee, amountUnits, spendable, asset);
    if (!planned.ok) return NextResponse.json({ error: planned.error }, { status: 400 });
    return NextResponse.json({ fee: feeView(feed.fee, planned.plan, asset) });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
