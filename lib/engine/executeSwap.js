/**
 * Execute a confirmed SWAP plan via the Flizy fee router.
 */

const { ethers } = require('ethers');
const { ensureAgentWallet, getAgentSigner } = require('../agentWallet');
const { executeSwap, executeSwapViaGator, isAllowedSwapRouter } = require('../dex');
const { pointerIsGator, gatorGasReserveWei, outcomeUnknown, gatorErrorCopy } = require('../gatorExecute');
const { predictGatorAddress } = require('../gatorAccount');
const { explorerTxUrl } = require('../chains');
const { publicErrorMessage } = require('../sanitize');
const { config } = require('../config');
const { insertTransfer, logSubmitted, logReceipt, recordBroadcast } = require('../transferLog');
const { FUND_REASON, fundingWallText } = require('./fundingWall');
const { assertSpendable, resolveReserveAsset } = require('../reserves');
const { normalizeSendAsset } = require('../commands/parse');
const { getSupabase } = require('../supabase');
const { shortAddress } = require('../ammora/venue');

/** History fields for an Ammora swap row. */
function ammoraRowFields(plan) {
  const a = plan.input.ammora;
  const buy = plan.input.inIsNative;
  return {
    asset: buy ? 'ETH' : a.symbol,
    asset_secondary: buy ? a.symbol : 'ETH',
    counterparty_label: `Ammora swap: ${buy ? `ETH to ${a.symbol}` : `${a.symbol} to ETH`} (${shortAddress(a.token)})`,
  };
}

/**
 * @param {object} args
 * @param {object} args.plan  SWAP execution plan
 * @param {import('ethers').Provider} args.provider
 * @param {object} args.chain
 * @param {(txHash: string) => Promise<void>|void} [args.onBroadcast] also called
 *   at broadcast, before the swap is sent (the limit-order watcher records the
 *   hash on the order). A throw refuses the send.
 */
async function executeSwapPlan({ plan, provider, chain, onBroadcast }) {
  if (!plan || plan.intent !== 'SWAP') {
    return { ok: false, error: 'Not a swap plan.' };
  }
  const router = plan.route?.routerAddress;
  if (!isAllowedSwapRouter(router, chain?.id || chain?.chainId)) {
    return { ok: false, error: 'Router not allowlisted.' };
  }

  const accountId = plan.actor?.accountId;
  if (!accountId) return { ok: false, error: 'Not linked.' };

  const ammora = plan.route?.venue === 'ammora' ? plan.input.ammora : null;
  const rowPayload = {
    account_id: accountId,
    phone: plan.actor?.waSenderId || 'wa',
    to_address: router || '0x0000000000000000000000000000000000000000',
    // From the exact input, not plan.input.amount: that is the display string
    // ("1,000,000"), which a numeric column refuses, and a refused row stops
    // the swap at broadcast. Flizy's chat swaps read amounts as 18 decimals;
    // an Ammora token has its own.
    amount_eth:
      ammora && !plan.input.inIsNative
        ? ethers.formatUnits(BigInt(plan.input.amountInWei), ammora.decimals ?? 18)
        : ethers.formatEther(BigInt(plan.input.amountInWei)),
    status: 'pending',
    chain_id: chain.chainId,
    kind: 'swap',
    asset: plan.input.tokenInLabel || 'ETH',
    amount_secondary: plan.input.amountOut != null ? String(plan.input.amountOut) : null,
    asset_secondary: plan.input.tokenOutLabel || null,
    counterparty_label: `swap → ${plan.input.tokenOutLabel || '?'}`,
    // An Ammora row names the token by its symbol and contract, as the site's
    // does (web/lib/ammora/siteSwap.ts), not by the long chat label.
    ...(ammora ? ammoraRowFields(plan) : {}),
    direction: 'out',
    // Ammora swaps say so in history. Flizy's own swaps carry no venue key at
    // all, so their insert is unchanged.
    ...(ammora ? { venue: 'ammora' } : {}),
  };
  let transferRow = await insertTransfer(rowPayload);
  if (!transferRow?.id) {
    console.error('executeSwapPlan: history insert failed (swap will still run)');
  }

  try {
    const account = await ensureAgentWallet(accountId);
    const viaGator = pointerIsGator(accountId, account.agent_wallet_address);
    const signer = getAgentSigner(accountId, provider);
    const walletAddr = viaGator ? predictGatorAddress(accountId) : signer.address;
    const amountIn = BigInt(plan.input.amountInWei);
    const amountOutMin = BigInt(plan.input.amountOutMinWei);
    const gasBuffer = viaGator
      ? await gatorGasReserveWei(provider, walletAddr)
      : ethers.parseEther(config.gasBufferEth);
    const ethBal = await provider.getBalance(walletAddr);

    if (plan.input.inIsNative) {
      const fence = await assertSpendable(getSupabase(), accountId, {
        asset: 'ETH',
        holding: ethBal,
        amount: amountIn,
        gas: gasBuffer,
        decimals: 18,
        label: 'ETH',
      });
      if (!fence.ok) {
        if (transferRow?.id) {
          await logReceipt(transferRow.id, { ok: false, txHash: '', error: 'insufficient available balance' });
        }
        return { ok: false, error: fence.message };
      }
      // No paymaster: the gator funds EntryPoint's prefund itself.
      if (ethBal < amountIn + gasBuffer) {
        if (transferRow?.id) {
          await logReceipt(transferRow.id, {
            ok: false,
            txHash: '',
            error: 'insufficient balance',
          });
        }
        return {
          ok: false,
          reason: FUND_REASON,
          error: fundingWallText({ kind: 'native', address: walletAddr }),
        };
      }
    } else {
      const fenceEth = await assertSpendable(getSupabase(), accountId, {
        asset: 'ETH',
        holding: ethBal,
        amount: 0n,
        gas: gasBuffer,
        decimals: 18,
        label: 'ETH',
      });
      if (!fenceEth.ok) {
        if (transferRow?.id) {
          await logReceipt(transferRow.id, { ok: false, txHash: '', error: 'insufficient available balance' });
        }
        return { ok: false, error: fenceEth.message };
      }
      const tokenIn = plan.input.tokenIn;
      const named = resolveReserveAsset(normalizeSendAsset(plan.input.tokenInLabel || ''), chain);
      const decimals = named ? named.decimals : Number.isInteger(ammora?.decimals) ? ammora.decimals : 18;
      const asset = named ? named.asset : normalizeSendAsset(plan.input.tokenInLabel || 'ETH');
      let tokBal = 0n;
      if (tokenIn) {
        const erc20 = new ethers.Contract(
          tokenIn,
          ['function balanceOf(address) view returns (uint256)'],
          provider
        );
        tokBal = await erc20.balanceOf(walletAddr);
      }
      const fenceTok = await assertSpendable(getSupabase(), accountId, {
        asset,
        holding: tokBal,
        amount: amountIn,
        gas: 0n,
        decimals,
        label: named ? named.label : asset,
      });
      if (!fenceTok.ok) {
        if (transferRow?.id) {
          await logReceipt(transferRow.id, { ok: false, txHash: '', error: 'insufficient available balance' });
        }
        return { ok: false, error: fenceTok.message };
      }
    }

    // The Ammora venue (lib/ammora/chat.js): fresh quote held to the plan's
    // minimum, policy on the prepared swap, then Flizy's executor.
    if (ammora) {
      const { executeAmmoraPlan } = require('../ammora/chat');
      const { getSupabase } = require('../supabase');
      return await executeAmmoraPlan({
        plan,
        provider,
        chain,
        supabase: getSupabase(),
        gator: viaGator ? walletAddr : null,
        recordBroadcast,
        transferRow,
        rowPayload,
        onBroadcast,
        logReceipt,
      });
    }

    const result = viaGator
      ? await executeSwapViaGator({
          accountId,
          provider,
          chainId: chain.chainId,
          amountIn,
          tokenIn: plan.input.inIsNative ? null : plan.input.tokenIn,
          tokenOut: plan.input.outIsNative ? null : plan.input.tokenOut,
          amountOutMinWei: amountOutMin,
          chainKey: chain?.id,
          recipient: walletAddr,
          onBroadcast: async (hash) => {
            transferRow = { id: await recordBroadcast(transferRow?.id, hash, rowPayload) };
            if (onBroadcast) await onBroadcast(hash);
          },
        })
      : await executeSwap({
          signer,
          amountIn,
          tokenIn: plan.input.inIsNative ? null : plan.input.tokenIn,
          tokenOut: plan.input.outIsNative ? null : plan.input.tokenOut,
          amountOutMinWei: amountOutMin,
          chainKey: chain?.id,
          recipient: signer.address,
        });

    await logSubmitted(transferRow?.id, result.txHash);
    await logReceipt(transferRow?.id, { ok: true, txHash: result.txHash });

    try {
      const { maybeMarkFirstTx } = require('../invite');
      const { getSupabase } = require('../supabase');
      const side = String(plan.input?.side || '').toLowerCase();
      const kind = side === 'buy' || side === 'sell' ? side : 'swap';
      await maybeMarkFirstTx(getSupabase(), {
        accountId,
        kind,
        amount: plan.input?.amount || '0',
        ok: true,
      });
    } catch (hookErr) {
      console.warn('[invite] first tx hook:', publicErrorMessage(hookErr));
    }

    return {
      ok: true,
      txHash: result.txHash,
      explorerUrl: explorerTxUrl(chain, result.txHash),
      submitted: true,
      confirmed: true,
    };
  } catch (err) {
    console.error('executeSwapPlan:', publicErrorMessage(err));
    // Broadcast with no answer: the row stays 'submitted' for the reconciler.
    if (outcomeUnknown(err)) {
      return {
        ok: false,
        submitted: true,
        txHash: err.txHash,
        error: gatorErrorCopy(err),
      };
    }
    if (transferRow?.id) {
      await logReceipt(transferRow.id, {
        ok: false,
        txHash: err?.txHash || '',
        error: publicErrorMessage(err),
      });
    }
    return {
      ok: false,
      submitted: false,
      error: gatorErrorCopy(err) || 'Swap failed on-chain. Check balance, allowance, and try again.',
    };
  }
}

module.exports = {
  executeSwapPlan,
};
