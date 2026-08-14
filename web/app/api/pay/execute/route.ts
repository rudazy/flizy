import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { isSavedMerchant, resolvePayRef } from '../../../../lib/payCode.ts';
import { deriveAgentWallet, getWebChain, explorerTxUrl } from '../../../../lib/dexServer';
import { maybeMarkFirstTx } from '../../../../lib/invite.ts';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/pay/execute';

function gasBufferWei(): bigint {
  try {
    return ethers.parseEther(String(process.env.GAS_BUFFER_ETH || '0.0001'));
  } catch {
    return ethers.parseEther('0.0001');
  }
}

export async function POST(req: Request) {
  try {
    const payerId = await getAccountIdFromCookie();
    if (!payerId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const supabase = getSupabase();
    const gate = await requirePassword(supabase, payerId, String(body.password || ''), 'pay');
    if (!gate.ok) {
      return NextResponse.json({ error: gate.error }, { status: gate.status });
    }

    const merchant = await resolvePayRef(supabase, body.ref);
    if (!merchant?.accountId) {
      return NextResponse.json({ error: 'Pay identity not found.' }, { status: 404 });
    }
    if (merchant.accountId === payerId) {
      return NextResponse.json({ error: 'You cannot pay your own account.' }, { status: 400 });
    }

    let amountWei: bigint;
    try {
      amountWei = ethers.parseEther(String(body.amount || ''));
    } catch {
      return NextResponse.json({ error: 'Invalid amount.' }, { status: 400 });
    }
    if (amountWei <= 0n) {
      return NextResponse.json({ error: 'Amount must be greater than zero.' }, { status: 400 });
    }

    const { data: dest } = await supabase
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', merchant.accountId)
      .maybeSingle();
    const to = dest?.agent_wallet_address;
    if (!to || !ethers.isAddress(to)) {
      return NextResponse.json({ error: 'That account has no wallet yet.' }, { status: 400 });
    }

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const signer = deriveAgentWallet(payerId).connect(provider);
    const bal = await provider.getBalance(signer.address);
    if (bal < amountWei + gasBufferWei()) {
      return NextResponse.json(
        { error: 'Not enough ETH in your Flizy wallet (amount + gas).' },
        { status: 400 }
      );
    }

    const amountEth = ethers.formatEther(amountWei);
    const { data: logRow } = await supabase
      .from('transfers')
      .insert({
        account_id: payerId,
        phone: 'site',
        to_address: to,
        amount_eth: amountEth,
        status: 'pending',
        chain_id: chain.chainId,
        kind: 'transfer',
        asset: 'ETH',
        counterparty_label: merchant.username ? `@${merchant.username}` : 'flizy pay',
        direction: 'out',
      })
      .select('id')
      .maybeSingle();

    const tx = await signer.sendTransaction({ to, value: amountWei });
    const receipt = await tx.wait(1);
    const ok = Boolean(receipt && receipt.status === 1);

    if (logRow?.id) {
      await supabase
        .from('transfers')
        .update({
          status: ok ? 'confirmed' : 'failed',
          tx_hash: tx.hash,
          error: ok ? null : 'receipt status not successful',
        })
        .eq('id', logRow.id);
    }

    if (!ok) {
      return NextResponse.json({ error: 'Payment failed on-chain.' }, { status: 502 });
    }

    try {
      await maybeMarkFirstTx(supabase, {
        accountId: payerId,
        kind: 'outbound_send',
        amount: amountEth,
        ok: true,
        counterpartyAccountId: merchant.accountId,
      });
    } catch (hookErr) {
      console.warn(
        '[invite] first tx hook:',
        hookErr instanceof Error ? hookErr.message : hookErr
      );
    }

    let alreadySaved = false;
    try {
      alreadySaved = await isSavedMerchant(supabase, payerId, to);
    } catch {
      alreadySaved = false;
    }

    return NextResponse.json({
      ok: true,
      txHash: tx.hash,
      explorerUrl: explorerTxUrl(chain, tx.hash),
      to: merchant.username ? `@${merchant.username}` : 'account',
      alreadySaved,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
