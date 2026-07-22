/**
 * Execution Engine — native transfer path.
 * Only runs after policy ALLOW* and user confirm on an unexpired plan.
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const { insertTransfer, logSubmitted, logReceipt } = require('../transferLog');
const { ensureAgentWallet, getAgentSigner } = require('../agentWallet');
const { publicErrorMessage } = require('../sanitize');
const { explorerTxUrl } = require('../chains');

/**
 * @param {object} args
 * @param {import('./plan').ExecutionPlan} args.plan
 * @param {import('ethers').Provider} args.provider
 * @param {import('../chains').ChainConfig} args.chain
 * @param {{ id: string, balance_eth?: number|string }} args.user
 * @param {(userId: string, bal: number) => Promise<unknown>} [args.setUserBalance]
 * @param {import('@supabase/supabase-js').SupabaseClient} [args.supabase]
 * @returns {Promise<{ ok: boolean, txHash?: string, explorerUrl?: string, error?: string, transferId?: string|null }>}
 */
async function executeNativeSend({
  plan,
  provider,
  chain,
  user,
  setUserBalance,
  supabase,
}) {
  if (!plan || plan.intent !== 'SEND') {
    return { ok: false, error: 'Invalid plan.' };
  }
  if (Date.now() > plan.expiresAt) {
    return { ok: false, error: 'Plan expired. Start again with flizy send ...' };
  }

  const amountEth = plan.input.amount;
  const to = plan.route.toAddress;
  const accountId = plan.actor.accountId;
  let amountWei;
  try {
    amountWei = ethers.parseEther(String(amountEth));
  } catch {
    return { ok: false, error: 'Pending amount was invalid. Start again.' };
  }

  const amountNum = Number(amountEth);
  const credit = Number(user.balance_eth || 0);
  const admin = Boolean(user.is_admin);

  if (config.enforceCredit && !admin && credit < amountNum) {
    return {
      ok: false,
      error: 'Not enough credit to complete. Send flizy deposit for options.',
    };
  }

  if (!accountId) {
    return { ok: false, error: 'No agent wallet linked. Open the site and flizy link CODE first.' };
  }

  const transferRow = await insertTransfer({
    user_id: user.id,
    account_id: accountId,
    phone: plan.actor.waSenderId,
    to_address: to,
    amount_eth: amountEth,
    status: 'pending',
    chain_id: chain.chainId,
    kind: 'transfer',
  });

  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== chain.chainId) {
      throw new Error(`Wrong chain id ${network.chainId}, expected ${chain.chainId}`);
    }

    await ensureAgentWallet(accountId);
    const agentSigner = getAgentSigner(accountId, provider);

    const balanceWei = await provider.getBalance(agentSigner.address);
    const gasBuffer = ethers.parseEther(config.gasBufferEth);
    if (balanceWei < amountWei + gasBuffer) {
      if (transferRow?.id) {
        await logReceipt(transferRow.id, {
          ok: false,
          txHash: '',
          error: 'insufficient agent wallet balance',
        });
      }
      return {
        ok: false,
        error: [
          'Not enough ETH in your agent wallet.',
          `Fund: ${agentSigner.address}`,
        ].join('\n'),
        transferId: transferRow?.id || null,
      };
    }

    const tx = await agentSigner.sendTransaction({
      to,
      value: amountWei,
    });

    await logSubmitted(transferRow?.id, tx.hash);

    const receipt = await tx.wait(1);
    const ok = Boolean(receipt && receipt.status === 1);
    const link = explorerTxUrl(chain, tx.hash);

    if (ok && config.enforceCredit && credit >= amountNum && setUserBalance) {
      await setUserBalance(user.id, credit - amountNum);
      if (supabase) {
        try {
          await supabase
            .from('accounts')
            .update({ balance_eth: credit - amountNum })
            .eq('id', accountId);
        } catch {
          // non-fatal
        }
      }
    }

    await logReceipt(transferRow?.id, {
      ok,
      txHash: tx.hash,
      error: ok ? null : 'receipt status not successful',
    });

    if (!transferRow?.id) {
      await insertTransfer({
        user_id: user.id,
        account_id: accountId,
        phone: plan.actor.waSenderId,
        to_address: to,
        amount_eth: amountEth,
        status: ok ? 'confirmed' : 'failed',
        tx_hash: tx.hash,
        chain_id: chain.chainId,
        kind: 'transfer',
        error: ok ? null : 'receipt status not successful',
      });
    }

    return {
      ok,
      txHash: tx.hash,
      explorerUrl: link,
      error: ok ? undefined : 'Transaction failed on-chain.',
      transferId: transferRow?.id || null,
    };
  } catch (err) {
    const reason = publicErrorMessage(err);
    console.error('executeNativeSend error:', reason);
    if (transferRow?.id) {
      await logReceipt(transferRow.id, { ok: false, txHash: '', error: reason });
    }
    return {
      ok: false,
      error: 'Transfer failed. Your funds were not sent. Try again or check balance.',
      transferId: transferRow?.id || null,
    };
  }
}

module.exports = {
  executeNativeSend,
};
