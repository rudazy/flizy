/**
 * Ammora in chat: buy, sell, swap against ETH, and price.
 *
 * Same flow as every Flizy swap: Intent, Policy (evaluateSwapPolicy, with the
 * pinned Ammora router on the allowlist only while the venue is attested),
 * Plan (buildSwapPlan, tagged route.venue = 'ammora'), CONFIRM and the PIN on
 * flizy.app (an Ammora token is never verified, so always Tier 1), then
 * Execute (executeSwapPlan hands an Ammora plan to executeAmmoraPlan below)
 * and the receipt. Not a parallel path.
 *
 * Identity: what someone types is resolved by resolveAmmoraToken. A Flizy
 * symbol (FLZ, ETH, a listed token) always means Flizy's own token, so an
 * Ammora token that copies one is reachable by contract address only. Every
 * plan names the token with its short contract address and "Ammora".
 */

const { ethers } = require('ethers');
const venue = require('./venue');
const { ensureAttested } = require('./attest');
const { getRouteClient, loadInventory, quoteAmmora, prepareAmmora, AmmoraQuoteError } = require('./routes');
const { displaySafeLabel } = require('../sanitize');

const REFUSAL = {
  off: 'Ammora is not available right now.',
  not_tradable: 'That Ammora token is not tradable right now.',
  ambiguous: 'More than one Ammora token has that symbol. Use its contract address.',
  unavailable: 'Could not get an Ammora quote right now. Try again shortly.',
  exact_out: 'For Ammora tokens, say how much to spend, for example: buy 0.01 ETH of 0x...',
  no_gator: 'Ammora swaps need your Flizy smart account.',
  price_moved: 'The Ammora price moved past your minimum, so nothing was sent. Start the trade again for a new quote.',
  policy: 'That Ammora route is not one Flizy sends, so nothing was sent.',
};

/** Every symbol Flizy itself means (these never resolve to Ammora). */
function flizySymbols() {
  const { LISTED_TOKENS } = require('../listedTokens');
  return ['ETH', 'WETH', 'FLZ', 'FLIZY', 'NATIVE', ...LISTED_TOKENS.map((t) => t.symbol)];
}

const isEth = (raw) => ['ETH', 'NATIVE'].includes(String(raw || '').trim().toUpperCase());

/**
 * The token side of a parsed trade against ETH, or null when the trade is not
 * one Ammora could take (token to token, or ETH to ETH).
 * @returns {{ side: 'buy'|'sell', raw: string }|null}
 */
function ammoraTarget(parsed) {
  if (parsed.kind === 'buy') {
    if (parsed.tokenIn && !isEth(parsed.tokenIn)) return null;
    return parsed.tokenOut ? { side: 'buy', raw: String(parsed.tokenOut) } : null;
  }
  if (parsed.kind === 'sell') return parsed.tokenIn ? { side: 'sell', raw: String(parsed.tokenIn) } : null;
  if (parsed.kind === 'swap') {
    if (isEth(parsed.tokenIn) && parsed.tokenOut && !isEth(parsed.tokenOut)) return { side: 'buy', raw: String(parsed.tokenOut) };
    if (isEth(parsed.tokenOut) && parsed.tokenIn && !isEth(parsed.tokenIn)) return { side: 'sell', raw: String(parsed.tokenIn) };
  }
  return null;
}

/**
 * Decide whether a typed token is an Ammora token.
 * @returns {Promise<{ use: 'flizy' } | { use: 'ammora', token: object, routes: object } | { use: 'refuse', message: string }>}
 */
async function routeForChat({ supabase, provider, raw }) {
  if (!venue.ammoraEnabled()) return { use: 'flizy' };
  const attested = await ensureAttested(provider);
  if (!attested.ok) return { use: 'flizy' };
  // The stored inventory decides first (one database read), so a Flizy trade
  // never waits for the SDK's route client.
  let inventory;
  try {
    inventory = await loadInventory(supabase);
  } catch {
    return { use: 'flizy' };
  }
  const hit = venue.resolveAmmoraToken(raw, inventory, flizySymbols());
  if (hit.reason === 'ambiguous') return { use: 'refuse', message: REFUSAL.ambiguous };
  if (hit.reason === 'not_tradable') return { use: 'refuse', message: REFUSAL.not_tradable };
  // A Flizy symbol, or not an Ammora token at all: Flizy's own path.
  if (!hit.ok) return { use: 'flizy' };
  try {
    const { routes } = await getRouteClient(supabase, { inventory });
    return { use: 'ammora', token: hit.token, routes };
  } catch {
    return { use: 'refuse', message: REFUSAL.unavailable };
  }
}

function labelFor(token) {
  return venue.ammoraTokenLabel(token.symbol, token.baseToken, (s) => displaySafeLabel(s, 16));
}

/**
 * Quote an Ammora trade and build the swap plan for it.
 * @returns {Promise<{ ok: true, plan: object, quote: object } | { ok: false, message: string }>}
 */
async function buildAmmoraChatPlan({ token, routes, side, amountStr, amountMode, actor, siteAcc, chain, gator, createSwapIntent, evaluateSwapPolicy, buildSwapPlan, formatEth, slippageBps }) {
  if (!gator) return { ok: false, message: REFUSAL.no_gator };
  if (side === 'buy' && amountMode === 'out') return { ok: false, message: REFUSAL.exact_out };
  const decimals = token.decimals == null ? 18 : token.decimals;
  let amountIn;
  try {
    amountIn = side === 'buy' ? ethers.parseEther(String(amountStr)) : ethers.parseUnits(String(amountStr), decimals);
  } catch {
    return { ok: false, message: 'Invalid amount.' };
  }
  if (amountIn <= 0n) return { ok: false, message: 'Invalid amount.' };

  const nativeIn = side === 'buy';
  const label = labelFor(token);
  const tokenIn = nativeIn ? null : token.baseToken;
  const tokenOut = nativeIn ? token.baseToken : null;
  const router = venue.VENUE.contracts.aggregationRouter.address;
  const intent = createSwapIntent({
    actor,
    side,
    amountIn: nativeIn ? ethers.formatEther(amountIn) : ethers.formatUnits(amountIn, decimals),
    tokenInLabel: nativeIn ? 'ETH' : label,
    tokenOutLabel: nativeIn ? label : 'ETH',
    tokenIn,
    tokenOut,
    routerAddress: router,
    chainId: chain.id,
    slippageBps,
  });
  const policy = await evaluateSwapPolicy(intent);
  if (policy.decision === 'DENY') return { ok: false, message: policy.message || 'Swap not allowed.' };

  let quote;
  try {
    quote = await quoteAmmora(routes, { tokenIn, tokenOut, amountIn, slippageBps, recipient: gator });
  } catch (err) {
    return { ok: false, message: REFUSAL[err instanceof AmmoraQuoteError ? err.reason : 'unavailable'] || REFUSAL.unavailable };
  }
  const fee = venue.ammoraFeeView(quote, { nativeIn });
  const outDecimals = nativeIn ? decimals : 18;
  const plan = buildSwapPlan({
    intent,
    policy,
    chain: { chainId: chain.chainId, chainName: chain.name, nativeSymbol: chain.nativeSymbol },
    fromAddress: siteAcc.agent_wallet_address,
    amountInDisplay: formatEth(nativeIn ? ethers.formatEther(amountIn) : ethers.formatUnits(amountIn, decimals)),
    amountOutDisplay: formatEth(ethers.formatUnits(quote.expectedAmountOut, outDecimals)),
    feeDisplay: formatEth(ethers.formatEther(fee.feeWei)),
    feePctDisplay: venue.bpsText(fee.rateBps),
    slippagePctDisplay: `${(slippageBps / 100).toFixed(2)}%`,
    tokenInLabel: nativeIn ? 'ETH' : label,
    tokenOutLabel: nativeIn ? label : 'ETH',
    routerAddress: router,
    amountInWei: amountIn.toString(),
    amountOutMinWei: quote.minimumAmountOut.toString(),
    inIsNative: nativeIn,
    outIsNative: !nativeIn,
    tokenIn,
    tokenOut,
  });
  plan.route.venue = 'ammora';
  plan.input.ammora = {
    token: token.baseToken,
    symbol: displaySafeLabel(token.symbol, 16),
    label,
    slippageBps,
    decimals,
    feeLabel: fee.label,
    feeEth: formatEth(ethers.formatEther(fee.feeWei)),
    priceImpact: fee.priceImpact,
    minimumOut: formatEth(ethers.formatUnits(quote.minimumAmountOut, outDecimals)),
  };
  return { ok: true, plan, quote };
}

/** The chat preview for an Ammora plan (formatSwapPlanPreview hands off here). */
function formatAmmoraPlanPreview(plan, mins, shortAddr) {
  const a = plan.input.ammora;
  return [
    'Swap plan (Ammora)',
    '',
    `You pay:    ${plan.input.amount} ${plan.input.tokenInLabel}`,
    `You get:    ~${plan.input.amountOut} ${plan.input.tokenOutLabel}`,
    `Minimum:    ${a.minimumOut} ${plan.input.tokenOutLabel}`,
    `${a.feeLabel}: ${a.feeEth} ETH${plan.input.feePct ? ` (${plan.input.feePct})` : ''}`,
    `Price impact: ${a.priceImpact === 'unavailable' ? 'unavailable from Ammora' : a.priceImpact}`,
    'Flizy fee:  none on Ammora swaps',
    `Slippage:   ${plan.input.slippagePct}`,
    `Token:      ${a.label}`,
    `Contract:   ${a.token}`,
    `From:       ${shortAddr(plan.route.fromAddress)} (your Flizy wallet)`,
    `Chain:      ${plan.route.chainName}`,
    '',
    'Ammora is a separate venue. Flizy has not reviewed this token.',
    `Reply CONFIRM to swap, or CANCEL to stop. Expires in ${mins} minutes.`,
  ].join('\n');
}

/** "price X" for an Ammora token. @returns {Promise<string>} */
async function ammoraPriceText({ token, routes }) {
  const probe = ethers.parseEther('0.001');
  const quote = await quoteAmmora(routes, { tokenIn: null, tokenOut: token.baseToken, amountIn: probe });
  const decimals = token.decimals == null ? 18 : token.decimals;
  const perEth = Number(ethers.formatUnits(quote.expectedAmountOut, decimals)) * 1000;
  const fee = venue.ammoraFeeView(quote, { nativeIn: true });
  return [
    `${labelFor(token)} price`,
    `1 ETH ~ ${perEth.toPrecision(6)} tokens`,
    `1 token ~ ${perEth > 0 ? (1 / perEth).toPrecision(6) : '?'} ETH`,
    `${fee.label} ${venue.bpsText(fee.rateBps)} per trade. Price impact unavailable from Ammora.`,
    `Contract: ${token.baseToken}`,
  ].join('\n');
}

/**
 * Execute an Ammora plan at CONFIRM: a fresh quote held to the plan's minimum,
 * the policy check on the prepared swap, then Flizy's executor.
 * @returns {Promise<{ ok: boolean, submitted?: boolean, txHash?: string, error?: string }>}
 */
async function executeAmmoraPlan({ plan, provider, chain, supabase, gator, recordBroadcast, transferRow, rowPayload, onBroadcast, logReceipt }) {
  const { executeAmmoraSwap } = require('./execute');
  const { outcomeUnknown, gatorErrorCopy } = require('../gatorExecute');
  // Refused before anything was sent: the history row is closed as failed,
  // not left pending.
  const refuse = async (error) => {
    if (transferRow && transferRow.id) await logReceipt(transferRow.id, { ok: false, txHash: '', error: 'not sent' });
    return { ok: false, submitted: false, error };
  };
  if (!gator) return refuse(REFUSAL.no_gator);
  const attested = await ensureAttested(provider);
  if (!attested.ok) return refuse(REFUSAL.off);
  const a = plan.input.ammora;
  const nativeIn = Boolean(plan.input.inIsNative);
  const amountIn = BigInt(plan.input.amountInWei);
  const tokenIn = nativeIn ? null : a.token;
  const tokenOut = nativeIn ? a.token : null;
  let prepared;
  let quote;
  let pools;
  try {
    const { routes, inventory } = await getRouteClient(supabase);
    pools = inventory.map((t) => t.pool);
    quote = await quoteAmmora(routes, { tokenIn, tokenOut, amountIn, slippageBps: a.slippageBps, recipient: gator });
    if (BigInt(quote.minimumAmountOut) < BigInt(plan.input.amountOutMinWei)) {
      return refuse(REFUSAL.price_moved);
    }
    prepared = await prepareAmmora(routes, quote, gator);
  } catch (err) {
    return refuse(REFUSAL[err instanceof AmmoraQuoteError ? err.reason : 'unavailable'] || REFUSAL.unavailable);
  }
  const policy = venue.checkPrepared(prepared, {
    attested: attested.ok,
    tokenIn,
    tokenOut,
    amountIn,
    minimumAmountOut: quote.minimumAmountOut,
    recipient: gator,
    pools,
  });
  if (!policy.ok) return refuse(REFUSAL.policy);

  let row = transferRow;
  try {
    const sent = await executeAmmoraSwap({
      accountId: plan.actor.accountId,
      provider,
      chainId: chain.chainId,
      gator,
      prepared,
      onBroadcast: async (hash) => {
        row = { id: await recordBroadcast(row && row.id, hash, rowPayload) };
        if (onBroadcast) await onBroadcast(hash);
      },
    });
    await logReceipt(row && row.id, { ok: true, txHash: sent.txHash });
    return { ok: true, submitted: true, confirmed: true, txHash: sent.txHash };
  } catch (err) {
    if (outcomeUnknown(err)) return { ok: false, submitted: true, txHash: err.txHash, error: gatorErrorCopy(err) };
    if (row && row.id) await logReceipt(row.id, { ok: false, txHash: (err && err.txHash) || '', error: 'not sent' });
    return { ok: false, submitted: false, error: gatorErrorCopy(err) || 'Ammora swap failed. Nothing was sent.' };
  }
}

module.exports = {
  REFUSAL,
  flizySymbols,
  ammoraTarget,
  routeForChat,
  buildAmmoraChatPlan,
  formatAmmoraPlanPreview,
  ammoraPriceText,
  executeAmmoraPlan,
  labelFor,
};
