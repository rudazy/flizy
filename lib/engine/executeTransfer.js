/**
 * Execution Engine — native and ERC-20 transfer paths.
 * Only runs after policy ALLOW* and user confirm on an unexpired plan.
 * Destinations must already have passed trusted/peer policy (WhatsApp only).
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const { insertTransfer, logSubmitted, logReceipt } = require('../transferLog');
const { debitUserCredit, creditUserCredit } = require('../credit');
const { ensureAgentWallet, getAgentSigner } = require('../agentWallet');
const { publicErrorMessage } = require('../sanitize');
const { explorerTxUrl } = require('../chains');

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

/**
 * @param {object} args
 * @returns {Promise<{
 *   ok: boolean,
 *   submitted?: boolean,
 *   txHash?: string,
 *   explorerUrl?: string,
 *   error?: string,
 *   transferId?: string|null,
 * }>}
 *   `submitted` says whether a transaction actually reached the network. The
 *   caller needs it to decide whether undoing side effects is safe: undoing
 *   after submission risks paying twice.
 */
async function executeNativeSend({
  plan,
  provider,
  chain,
  user,
  supabase,
}) {
  if (!plan || plan.intent !== 'SEND') {
    return { ok: false, error: 'Invalid plan.' };
  }
  if (plan.route?.kind === 'erc20_transfer') {
    return executeTokenSend({ plan, provider, chain, user });
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

  // Reserve the credit before the money moves, not after. The check above reads
  // a balance that a send on another channel may already have spent; only the
  // guarded decrement is authoritative. Reserving first also means a concurrent
  // pair of sends can never both pass on the same funds.
  const spendsCredit = config.enforceCredit && !admin;
  let reserved = false;
  if (spendsCredit) {
    let debit;
    try {
      debit = await debitUserCredit(user.id, amountEth);
    } catch (err) {
      console.error('credit reserve failed:', publicErrorMessage(err));
      return { ok: false, error: 'Could not verify your credit. Try again shortly.' };
    }
    if (!debit.ok) {
      return {
        ok: false,
        error: [
          'Not enough spendable credit.',
          `You have ${debit.balanceEth} ETH credit.`,
          `Need ${amountEth} ETH.`,
          '',
          'Send: flizy deposit',
        ].join('\n'),
      };
    }
    reserved = true;
  }

  /** Give the reservation back when nothing reached the chain. */
  const releaseReservation = async (why) => {
    if (!reserved) return;
    reserved = false;
    try {
      await creditUserCredit(user.id, amountEth);
    } catch (err) {
      console.error(
        `credit release failed (${why}) user=${user.id} amount=${amountEth}:`,
        publicErrorMessage(err)
      );
    }
  };

  // Anything that can fail between the reservation and the send has to give the
  // reservation back, or a user loses credit to a transfer that never happened.
  let transferRow;
  try {
    transferRow = await insertTransfer({
      user_id: user.id,
      account_id: accountId,
      phone: plan.actor.waSenderId,
      to_address: to,
      amount_eth: amountEth,
      status: 'pending',
      chain_id: chain.chainId,
      kind: 'transfer',
      asset: plan.input.asset || 'ETH',
      counterparty_label: plan.input.recipientLabel || null,
      direction: 'out',
    });
  } catch (err) {
    await releaseReservation('could not open the transfer log row');
    console.error('insertTransfer failed:', publicErrorMessage(err));
    return {
      ok: false,
      submitted: false,
      error: 'Could not start the transfer. Nothing was sent. Try again shortly.',
      transferId: null,
    };
  }

  // Flips the instant sendTransaction resolves. Past that point the credit
  // reservation is not returned, because the transfer may still confirm.
  let submitted = false;

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
      await releaseReservation('insufficient agent wallet balance');
      return {
        ok: false,
        submitted: false,
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
    submitted = true;

    await logSubmitted(transferRow?.id, tx.hash);

    const receipt = await tx.wait(1);
    const ok = Boolean(receipt && receipt.status === 1);
    const link = explorerTxUrl(chain, tx.hash);

    if (!ok) {
      // Mined and reverted, so nothing left the agent wallet.
      await releaseReservation('transaction reverted');
    }

    if (ok && spendsCredit && supabase) {
      // Mirror the ledger onto the account row the site reads. The users row is
      // authoritative and was already decremented atomically above.
      try {
        const { data: fresh } = await supabase
          .from('users')
          .select('balance_eth')
          .eq('id', user.id)
          .maybeSingle();
        if (fresh) {
          await supabase
            .from('accounts')
            .update({ balance_eth: fresh.balance_eth })
            .eq('id', accountId);
        }
      } catch {
        // non-fatal
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
        asset: plan.input.asset || 'ETH',
        counterparty_label: plan.input.recipientLabel || null,
        direction: 'out',
        error: ok ? null : 'receipt status not successful',
      });
    }

    return {
      ok,
      submitted: true,
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

    if (!submitted) {
      await releaseReservation('send failed before submission');
      return {
        ok: false,
        submitted: false,
        error: 'Transfer failed. Your funds were not sent. Try again or check balance.',
        transferId: transferRow?.id || null,
      };
    }

    // Submitted, outcome unknown. The reservation stays spent and the caller is
    // told not to blind retry: guessing here is how one send becomes two.
    console.error(
      `[transfer] ${transferRow?.id || 'unlogged'} submitted but unconfirmed for account ${accountId}. Check the chain before retrying.`
    );
    return {
      ok: false,
      submitted: true,
      error: 'Transfer was sent but could not be confirmed. Check your balance before retrying.',
      transferId: transferRow?.id || null,
    };
  }
}

/**
 * ERC-20 send to a trusted (or peer) address — WhatsApp confirm path only.
 */
async function executeTokenSend({ plan, provider, chain, user }) {
  if (!plan || plan.intent !== 'SEND' || plan.route?.kind !== 'erc20_transfer') {
    return { ok: false, error: 'Invalid token plan.' };
  }
  if (Date.now() > plan.expiresAt) {
    return { ok: false, error: 'Plan expired. Start again with flizy send ...' };
  }

  const accountId = plan.actor.accountId;
  const to = plan.route.toAddress;
  const tokenAddress = plan.route.tokenAddress || plan.input.tokenAddress;
  const amountRaw = plan.input.amount;
  const asset = String(plan.input.asset || 'TOKEN').toUpperCase();

  if (!accountId) {
    return { ok: false, error: 'No agent wallet linked. Open the site and flizy link CODE first.' };
  }
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return { ok: false, error: 'Unknown token. Try FLZ or ETH.' };
  }
  if (!to || !ethers.isAddress(to)) {
    return { ok: false, error: 'Invalid destination.' };
  }

  const transferRow = await insertTransfer({
    user_id: user?.id || null,
    account_id: accountId,
    phone: plan.actor.waSenderId,
    to_address: to,
    amount_eth: amountRaw,
    status: 'pending',
    chain_id: chain.chainId,
    kind: 'transfer',
    asset,
    token_address: ethers.getAddress(tokenAddress),
    counterparty_label: plan.input.recipientLabel || null,
    direction: 'out',
  });

  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== chain.chainId) {
      throw new Error(`Wrong chain id ${network.chainId}, expected ${chain.chainId}`);
    }

    await ensureAgentWallet(accountId);
    const agentSigner = getAgentSigner(accountId, provider);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, agentSigner);
    const decimals = Number(await token.decimals());
    let amountTok;
    try {
      amountTok = ethers.parseUnits(String(amountRaw), decimals);
    } catch {
      return { ok: false, error: 'Invalid token amount.' };
    }
    if (amountTok <= 0n) {
      return { ok: false, error: 'Amount must be greater than 0.' };
    }

    const tokBal = await token.balanceOf(agentSigner.address);
    if (tokBal < amountTok) {
      if (transferRow?.id) {
        await logReceipt(transferRow.id, {
          ok: false,
          txHash: '',
          error: 'insufficient token balance',
        });
      }
      return {
        ok: false,
        error: [
          `Not enough ${asset} in your agent wallet.`,
          `Fund: ${agentSigner.address}`,
        ].join('\n'),
        transferId: transferRow?.id || null,
      };
    }

    const ethBal = await provider.getBalance(agentSigner.address);
    const gasBuffer = ethers.parseEther(config.gasBufferEth);
    if (ethBal < gasBuffer) {
      return {
        ok: false,
        error: [
          'Need a little ETH in your agent wallet for gas.',
          `Fund: ${agentSigner.address}`,
        ].join('\n'),
        transferId: transferRow?.id || null,
      };
    }

    const tx = await token.transfer(to, amountTok);
    await logSubmitted(transferRow?.id, tx.hash);
    const receipt = await tx.wait(1);
    const ok = Boolean(receipt && receipt.status === 1);
    const link = explorerTxUrl(chain, tx.hash);

    await logReceipt(transferRow?.id, {
      ok,
      txHash: tx.hash,
      error: ok ? null : 'receipt status not successful',
    });

    if (!transferRow?.id) {
      await insertTransfer({
        user_id: user?.id || null,
        account_id: accountId,
        phone: plan.actor.waSenderId,
        to_address: to,
        amount_eth: amountRaw,
        status: ok ? 'confirmed' : 'failed',
        tx_hash: tx.hash,
        chain_id: chain.chainId,
        kind: 'transfer',
        asset,
        token_address: ethers.getAddress(tokenAddress),
        counterparty_label: plan.input.recipientLabel || null,
        direction: 'out',
        error: ok ? null : 'receipt status not successful',
      });
    }

    return {
      ok,
      txHash: tx.hash,
      explorerUrl: link,
      error: ok ? undefined : 'Token transfer failed on-chain.',
      transferId: transferRow?.id || null,
    };
  } catch (err) {
    const reason = publicErrorMessage(err);
    console.error('executeTokenSend error:', reason);
    if (transferRow?.id) {
      await logReceipt(transferRow.id, { ok: false, txHash: '', error: reason });
    }
    return {
      ok: false,
      error: 'Token transfer failed. Funds were not sent. Check balance and try again.',
      transferId: transferRow?.id || null,
    };
  }
}

module.exports = {
  executeNativeSend,
  executeTokenSend,
};
