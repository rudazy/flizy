/**
 * Ammora on the site swap: quote and execute against native ETH.
 *
 * Called from the existing routes (/api/swap/quote and /api/swap/execute)
 * when the request names the Ammora venue. Tokens are named by contract
 * address on the site (the picker sends the address), and resolved through
 * resolveAmmoraToken so a token that is not in the inventory, not tradable,
 * or flagged is refused. The swap runs through Flizy's executor
 * (web/lib/ammora/execute.ts), never the SDK's execute().
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { ClientError } from '../apiError.ts';
import { ammoraEnabled, ammoraFeeView, bpsText, checkPrepared, resolveAmmoraToken, shortAddress } from './venue.ts';
import { ensureAttested } from './attest.ts';
import { getRouteClient, loadInventory, prepareAmmora, quoteAmmora, AmmoraQuoteError } from './routes.ts';
import { flizySymbols, toView } from './catalog.ts';
import { executeAmmoraSwap } from './execute.ts';
import { markTransferSubmitted } from '../gatorOutcome.ts';
import { outcomeUnknown } from '../gatorExecute.ts';

export const AMMORA_ROUTE_REFUSALS: Record<string, string> = {
  off: 'Ammora is not available right now.',
  not_tradable: 'That Ammora token is not tradable right now.',
  unknown: 'That Ammora token is not in Flizy yet.',
  flizy_symbol: 'Use the contract address for that Ammora token.',
  ambiguous: 'More than one Ammora token has that symbol. Use the contract address.',
  unavailable: 'Could not get an Ammora quote right now. Try again shortly.',
  price_moved: 'The Ammora price moved past your minimum, so nothing was sent. Review the new quote.',
  policy: 'That Ammora route is not one Flizy sends, so nothing was sent.',
  no_gator: 'Ammora swaps need your Flizy smart account.',
};

function refuse(reason: string): ClientError {
  return new ClientError(AMMORA_ROUTE_REFUSALS[reason] || AMMORA_ROUTE_REFUSALS.unavailable);
}

export type AmmoraSide = 'buy' | 'sell';

async function venue(supabase: SupabaseClient, provider: ethers.Provider, token: string) {
  if (!ammoraEnabled()) throw refuse('off');
  const attested = await ensureAttested(provider);
  if (!attested.ok) throw refuse('off');
  // The stored inventory decides first, so a refusal never waits for the
  // SDK's route client. A route client that cannot be built is 'unavailable'.
  const inventory = await loadInventory(supabase).catch(() => {
    throw refuse('unavailable');
  });
  const hit = resolveAmmoraToken(String(token || ''), inventory, flizySymbols());
  if (!hit.ok) throw refuse(hit.reason);
  const { routes } = await getRouteClient(supabase, { inventory }).catch(() => {
    throw refuse('unavailable');
  });
  return { routes, token: hit.token, pools: inventory.map((t) => t.pool) };
}

function parseAmount(side: AmmoraSide, amount: string, decimals: number | null): bigint {
  let wei: bigint;
  try {
    wei = side === 'buy' ? ethers.parseEther(String(amount)) : ethers.parseUnits(String(amount), decimals ?? 18);
  } catch {
    throw new ClientError('Invalid amount');
  }
  if (wei <= 0n) throw new ClientError('Invalid amount');
  return wei;
}

/** A quote the swap screen shows: output, minimum, fee, price impact, label. */
export async function ammoraSiteQuote(
  supabase: SupabaseClient,
  provider: ethers.Provider,
  args: { side: AmmoraSide; token: string; amount: string; slippageBps?: number }
) {
  const { routes, token } = await venue(supabase, provider, args.token);
  const amountIn = parseAmount(args.side, args.amount, token.decimals);
  const nativeIn = args.side === 'buy';
  let quote;
  try {
    quote = await quoteAmmora(routes, {
      tokenIn: nativeIn ? null : token.baseToken,
      tokenOut: nativeIn ? token.baseToken : null,
      amountIn,
      slippageBps: args.slippageBps,
    });
  } catch (err) {
    throw refuse(err instanceof AmmoraQuoteError ? err.reason : 'unavailable');
  }
  const fee = ammoraFeeView(quote, { nativeIn });
  const outDecimals = nativeIn ? token.decimals ?? 18 : 18;
  return {
    venue: 'ammora' as const,
    token: toView(token, 'ACTIVE'),
    amountOut: ethers.formatUnits(quote.expectedAmountOut, outDecimals),
    amountOutMin: ethers.formatUnits(quote.minimumAmountOut, outDecimals),
    fee: { amountEth: ethers.formatEther(fee.feeWei), rate: bpsText(fee.rateBps), label: fee.label },
    priceImpact: fee.priceImpact,
    hops: quote.hops.length,
  };
}

/** ETH per token, from a small quote, for the swap screen's price line. */
export async function ammoraSitePrice(supabase: SupabaseClient, provider: ethers.Provider, token: string) {
  const { routes, token: t } = await venue(supabase, provider, token);
  const probe = ethers.parseEther('0.001');
  const quote = await quoteAmmora(routes, { tokenIn: null, tokenOut: t.baseToken, amountIn: probe }).catch((err) => {
    throw refuse(err instanceof AmmoraQuoteError ? err.reason : 'unavailable');
  });
  const tokens = Number(ethers.formatUnits(quote.expectedAmountOut, t.decimals ?? 18));
  return { symbol: toView(t, 'ACTIVE').label, ethPerToken: tokens > 0 ? 0.001 / tokens : null, venue: 'ammora' as const };
}

/**
 * Execute an Ammora swap for the site. Called under the account lock, after
 * the PIN. A fresh quote is taken and held to the minimum the person reviewed;
 * the prepared swap must pass the pinned-venue policy before anything is sent.
 */
export async function ammoraSiteExecute(
  supabase: SupabaseClient,
  provider: ethers.JsonRpcProvider,
  args: {
    accountId: string;
    chainId: number;
    gator: string | null;
    side: AmmoraSide;
    token: string;
    amount: string;
    slippageBps?: number;
    confirmedMin: string | null;
  }
) {
  if (!args.gator) throw refuse('no_gator');
  const { routes, token, pools } = await venue(supabase, provider, args.token);
  const nativeIn = args.side === 'buy';
  const amountIn = parseAmount(args.side, args.amount, token.decimals);
  const outDecimals = nativeIn ? token.decimals ?? 18 : 18;
  let quote;
  try {
    quote = await quoteAmmora(routes, {
      tokenIn: nativeIn ? null : token.baseToken,
      tokenOut: nativeIn ? token.baseToken : null,
      amountIn,
      slippageBps: args.slippageBps,
      recipient: args.gator,
    });
  } catch (err) {
    throw refuse(err instanceof AmmoraQuoteError ? err.reason : 'unavailable');
  }
  if (args.confirmedMin != null && String(args.confirmedMin).trim() !== '') {
    let reviewed: bigint;
    try {
      reviewed = ethers.parseUnits(String(args.confirmedMin), outDecimals);
    } catch {
      throw new ClientError('Invalid minimum');
    }
    if (quote.minimumAmountOut < reviewed) throw refuse('price_moved');
  }
  const prepared = await prepareAmmora(routes, quote, args.gator).catch((err) => {
    throw refuse(err instanceof AmmoraQuoteError ? err.reason : 'unavailable');
  });
  const attested = await ensureAttested(provider);
  const policy = checkPrepared(prepared, {
    attested: attested.ok,
    tokenIn: nativeIn ? null : token.baseToken,
    tokenOut: nativeIn ? token.baseToken : null,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut,
    recipient: args.gator,
    pools,
  });
  if (!policy.ok) throw refuse('policy');

  const view = toView(token, 'ACTIVE');
  const { data: logRow } = await supabase
    .from('transfers')
    .insert({
      account_id: args.accountId,
      phone: 'site',
      to_address: prepared.transaction.to,
      amount_eth: nativeIn ? ethers.formatEther(amountIn) : ethers.formatUnits(amountIn, token.decimals ?? 18),
      status: 'pending',
      chain_id: args.chainId,
      kind: 'swap',
      venue: 'ammora',
      asset: nativeIn ? 'ETH' : view.symbol,
      asset_secondary: nativeIn ? view.symbol : 'ETH',
      amount_secondary: ethers.formatUnits(quote.expectedAmountOut, outDecimals),
      counterparty_label: `Ammora swap: ${nativeIn ? `ETH to ${view.symbol}` : `${view.symbol} to ETH`} (${shortAddress(token.baseToken)})`,
      direction: 'out',
    })
    .select('id')
    .maybeSingle();
  if (!logRow?.id) throw new Error('could not log the Ammora swap');

  try {
    const sent = await executeAmmoraSwap({
      accountId: args.accountId,
      provider,
      chainId: args.chainId,
      gator: args.gator,
      prepared,
      onBroadcast: (hash) => markTransferSubmitted(supabase, logRow.id, hash),
    });
    await supabase.from('transfers').update({ status: 'confirmed', tx_hash: sent.txHash }).eq('id', logRow.id);
    const fee = ammoraFeeView(quote, { nativeIn });
    return {
      txHash: sent.txHash,
      venue: 'ammora' as const,
      token: view,
      amountOut: ethers.formatUnits(quote.expectedAmountOut, outDecimals),
      fee: { amountEth: ethers.formatEther(fee.feeWei), rate: bpsText(fee.rateBps), label: fee.label },
    };
  } catch (err) {
    // Unknown outcome: the row stays 'submitted' for the reconciler.
    if (!outcomeUnknown(err)) {
      await supabase.from('transfers').update({ status: 'failed', error: 'not sent' }).eq('id', logRow.id);
    }
    throw err;
  }
}
