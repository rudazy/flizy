/**
 * One on-chain Flizy Mint action from the account's own wallet: a mint, a
 * collection create, a drop configure, an allowlist publish, a pause.
 *
 * The order is the marketplace route's (web/app/api/market/[action]/route.ts),
 * so every write path takes the same gates: rate limit, the PIN, the account
 * lock, the daily ETH limit when ETH goes to someone else, a balance check, a
 * transfers row logged before the send, then the send from the EOA or the
 * gator. The row ends confirmed or failed.
 */

import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireStepUp } from './stepUp.ts';
import { tryAccountTxLock, releaseAccountTxLock } from './accountTxLock.ts';
import { checkDailyNativeLimit } from './dailyLimits.ts';
import { assertCanPay, runMarketCalls, type MarketCall } from './marketExecute.ts';
import { gatorFailure, markTransferSubmitted } from './gatorOutcome.ts';
import { outcomeUnknown } from './gatorExecute.ts';
import { MARKET_KIND, checkMarketRateLimit } from './marketRateLimit.ts';
import { ClientError } from './apiError';
import type { NftContext } from './nftApi.ts';

/** A refusal written for the person, with its HTTP status. */
export class MintError extends ClientError {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code?: string
  ) {
    super(message);
  }
}

export type MintTx = {
  calls: MarketCall[];
  /** ETH leaving the wallet in total. */
  value: bigint;
  /** Shown in history: "Mint 2 Franky", "Publish allowlist". */
  label: string;
  /** Finishes "Enter your PIN to ..." */
  reason: string;
  /** Where the transfers row says the ETH went. */
  to: string;
};

export async function runMintTx(args: {
  supabase: SupabaseClient;
  ctx: NftContext;
  accountId: string;
  viewer: { address: string; viaGator: boolean };
  pin: string;
  tx: MintTx;
  /** Runs under the account lock before anything is sent; throw to refuse. */
  underLock?: () => Promise<void>;
}): Promise<{ txHash: string }> {
  const { supabase, ctx, accountId, viewer, tx } = args;

  const rate = await checkMarketRateLimit(supabase, accountId);
  if (!rate.ok) throw new MintError(rate.error, rate.status, rate.code);

  const auth = await requireStepUp(supabase, accountId, args.pin, tx.reason);
  if (!auth.ok) throw new MintError(auth.error, auth.status, auth.code);

  const lock = await tryAccountTxLock(supabase, accountId, MARKET_KIND);
  if (!lock.ok) throw new MintError(lock.error, 409);
  try {
    if (args.underLock) await args.underLock();
    // Under the lock: a check taken before it would let two requests both
    // read today's total before either one's row exists.
    if (tx.value > 0n) {
      const daily = await checkDailyNativeLimit(supabase, accountId, tx.value);
      if (!daily.ok) throw new MintError(daily.message, 403);
    }
    await assertCanPay(ctx.provider, viewer, tx.value, tx.calls.length, { supabase, accountId });

    const { data: logRow, error: logError } = await supabase
      .from('transfers')
      .insert({
        account_id: accountId,
        phone: 'site',
        to_address: tx.to,
        amount_eth: ethers.formatEther(tx.value),
        status: 'pending',
        chain_id: ctx.chain.chainId,
        kind: MARKET_KIND,
        asset: 'ETH',
        counterparty_label: tx.label,
        direction: 'out',
      })
      .select('id')
      .maybeSingle();
    if (!logRow?.id) throw new Error(`could not log mint action: ${logError?.message || 'no row returned'}`);

    try {
      const txHash = await runMarketCalls({
        accountId,
        provider: ctx.provider,
        chainId: ctx.chain.chainId,
        viaGator: viewer.viaGator,
        calls: tx.calls,
        onBroadcast: (hash) => markTransferSubmitted(supabase, logRow.id, hash),
      });
      await supabase.from('transfers').update({ status: 'confirmed', tx_hash: txHash }).eq('id', logRow.id);
      return { txHash };
    } catch (sendErr) {
      // Broadcast with no answer: the row stays 'submitted' for the reconciler.
      if (!outcomeUnknown(sendErr)) {
        await supabase
          .from('transfers')
          .update({ status: 'failed', error: sendErr instanceof Error ? sendErr.message.slice(0, 500) : 'failed' })
          .eq('id', logRow.id);
      }
      const executorOutcome = gatorFailure(sendErr);
      if (executorOutcome) throw new MintError(executorOutcome.body.error, executorOutcome.status, executorOutcome.body.code);
      throw sendErr;
    }
  } finally {
    await releaseAccountTxLock(supabase, accountId);
  }
}
