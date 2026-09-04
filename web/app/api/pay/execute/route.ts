import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { isSavedMerchant, resolvePayRef } from '../../../../lib/payCode.ts';
import { deriveAgentWallet, getWebChain, explorerTxUrl, resolveToken } from '../../../../lib/dexServer';
import { maybeMarkFirstTx } from '../../../../lib/invite.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { normalizePayAsset } from '../../../../lib/payAsset.ts';
import { tryAccountTxLock, releaseAccountTxLock } from '../../../../lib/accountTxLock.ts';
import {
  executeGatorCall,
  pointerIsGator,
  gatorGasReserveWei,
} from '../../../../lib/gatorExecute.ts';
import { predictGatorAddress } from '../../../../lib/gatorAccount.ts';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

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
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const payerId = await getAccountIdFromCookie();
    if (!payerId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const supabase = getSupabase();
    const gate = await requirePassword(supabase, payerId, String(body.password || ''), 'pay');
    if (!gate.ok) {
      return NextResponse.json({ error: gate.error, code: gate.code }, { status: gate.status });
    }

    const merchant = await resolvePayRef(supabase, body.ref);
    if (!merchant?.accountId) {
      return NextResponse.json({ error: 'Pay identity not found.' }, { status: 404 });
    }
    if (merchant.accountId === payerId) {
      return NextResponse.json({ error: 'You cannot pay your own account.' }, { status: 400 });
    }

    let asset: 'ETH' | 'FLZ';
    try {
      asset = normalizePayAsset(body.asset);
    } catch {
      return NextResponse.json({ error: 'Unknown token. Listed: ETH, FLZ.' }, { status: 400 });
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

    const lock = await tryAccountTxLock(supabase, payerId, 'pay');
    if (!lock.ok) {
      return NextResponse.json({ error: lock.error }, { status: 409 });
    }

    try {
    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    // Funds sit on the gator once the pointer is flipped; the HMAC EOA only
    // signs the UserOp. Ops submits the outer tx but there is no paymaster, so
    // EntryPoint still takes its prefund from the gator: it needs a reserve.
    const { data: payer } = await supabase
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', payerId)
      .maybeSingle();
    const viaGator = pointerIsGator(payerId, payer?.agent_wallet_address);
    const signer = deriveAgentWallet(payerId).connect(provider);
    const walletAddr = viaGator ? predictGatorAddress(payerId) : signer.address;
    const ethBal = await provider.getBalance(walletAddr);
    const gasBuf = viaGator ? await gatorGasReserveWei(provider, walletAddr) : gasBufferWei();

    let amountHuman: string;
    let tokenAddress: string | null = null;
    let txHash: string;

    if (asset === 'ETH') {
      let amountWei: bigint;
      try {
        amountWei = ethers.parseEther(String(body.amount || ''));
      } catch {
        return NextResponse.json({ error: 'Invalid amount.' }, { status: 400 });
      }
      if (amountWei <= 0n) {
        return NextResponse.json({ error: 'Amount must be greater than zero.' }, { status: 400 });
      }
      if (ethBal < amountWei + gasBuf) {
        return NextResponse.json(
          { error: 'Not enough ETH in your Flizy wallet (amount + gas).' },
          { status: 400 }
        );
      }
      amountHuman = ethers.formatEther(amountWei);
      const { data: logRow } = await supabase
        .from('transfers')
        .insert({
          account_id: payerId,
          phone: 'site',
          to_address: to,
          amount_eth: amountHuman,
          status: 'pending',
          chain_id: chain.chainId,
          kind: 'transfer',
          asset: 'ETH',
          counterparty_label: merchant.username ? `@${merchant.username}` : 'flizy pay',
          direction: 'out',
        })
        .select('id')
        .maybeSingle();

      let receipt: ethers.TransactionReceipt | null;
      if (viaGator) {
        const sent = await executeGatorCall({
          accountId: payerId,
          provider,
          chainId: chain.chainId,
          target: to,
          value: amountWei,
          data: '0x',
        });
        txHash = sent.txHash;
        receipt = sent.receipt;
      } else {
        const tx = await signer.sendTransaction({ to, value: amountWei });
        txHash = tx.hash;
        receipt = await tx.wait(1);
      }
      const ok = Boolean(receipt && receipt.status === 1);

      if (logRow?.id) {
        await supabase
          .from('transfers')
          .update({
            status: ok ? 'confirmed' : 'failed',
            tx_hash: txHash,
            error: ok ? null : 'receipt status not successful',
          })
          .eq('id', logRow.id);
      }

      if (!ok) {
        return NextResponse.json({ error: 'Payment failed on-chain.' }, { status: 502 });
      }
    } else {
      let flzAddr: string | null;
      try {
        flzAddr = resolveToken('FLZ');
      } catch {
        return NextResponse.json({ error: 'FLZ is not configured on this chain.' }, { status: 400 });
      }
      if (!flzAddr || !ethers.isAddress(flzAddr)) {
        return NextResponse.json({ error: 'FLZ is not configured on this chain.' }, { status: 400 });
      }
      tokenAddress = ethers.getAddress(flzAddr);
      const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, viaGator ? provider : signer);
      const decimals = Number(await erc20.decimals());
      let amountTok: bigint;
      try {
        amountTok = ethers.parseUnits(String(body.amount || ''), decimals);
      } catch {
        return NextResponse.json({ error: 'Invalid amount.' }, { status: 400 });
      }
      if (amountTok <= 0n) {
        return NextResponse.json({ error: 'Amount must be greater than zero.' }, { status: 400 });
      }
      if (ethBal < gasBuf) {
        return NextResponse.json(
          { error: 'Need a little ETH in your Flizy wallet for gas.' },
          { status: 400 }
        );
      }
      const tokBal = await erc20.balanceOf(walletAddr);
      if (tokBal < amountTok) {
        return NextResponse.json(
          { error: 'Not enough FLZ in your Flizy wallet.' },
          { status: 400 }
        );
      }
      amountHuman = ethers.formatUnits(amountTok, decimals);
      const { data: logRow } = await supabase
        .from('transfers')
        .insert({
          account_id: payerId,
          phone: 'site',
          to_address: to,
          amount_eth: amountHuman,
          status: 'pending',
          chain_id: chain.chainId,
          kind: 'transfer',
          asset: 'FLZ',
          token_address: tokenAddress,
          counterparty_label: merchant.username ? `@${merchant.username}` : 'flizy pay',
          direction: 'out',
        })
        .select('id')
        .maybeSingle();

      let receipt: ethers.TransactionReceipt | null;
      if (viaGator) {
        const sent = await executeGatorCall({
          accountId: payerId,
          provider,
          chainId: chain.chainId,
          target: tokenAddress,
          value: 0n,
          data: erc20.interface.encodeFunctionData('transfer', [to, amountTok]),
        });
        txHash = sent.txHash;
        receipt = sent.receipt;
      } else {
        const tx = await erc20.transfer(to, amountTok);
        txHash = tx.hash;
        receipt = await tx.wait(1);
      }
      const ok = Boolean(receipt && receipt.status === 1);

      if (logRow?.id) {
        await supabase
          .from('transfers')
          .update({
            status: ok ? 'confirmed' : 'failed',
            tx_hash: txHash,
            error: ok ? null : 'receipt status not successful',
          })
          .eq('id', logRow.id);
      }

      if (!ok) {
        return NextResponse.json({ error: 'Payment failed on-chain.' }, { status: 502 });
      }
    }

    try {
      await maybeMarkFirstTx(supabase, {
        accountId: payerId,
        kind: 'outbound_send',
        amount: amountHuman,
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
      txHash,
      explorerUrl: explorerTxUrl(chain, txHash),
      to: merchant.username ? `@${merchant.username}` : 'account',
      alreadySaved,
    });
    } finally {
      await releaseAccountTxLock(supabase, payerId);
    }
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
