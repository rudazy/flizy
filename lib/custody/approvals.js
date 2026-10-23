/**
 * Chat payments over a secured account's daily cap, approved with its passkey.
 *
 * The engine does not send an over-cap payment on Flizy's owner key. It opens
 * an approval here (createApproval) and replies with a one-time link. On
 * flizy.app the account's passkey signs a one-off permission for exactly that
 * payment (web/lib/custody/approvals.ts). This module's worker, on the bot
 * host where the relayer key lives, then sends it (sendSignedApprovals), or
 * expires it. A cancel, from chat or the page, closes it before it is sent.
 *
 * Every status change is compare-and-set, so the two bot processes, the page
 * and the worker can never both act on one approval. Database and chain arrive
 * as arguments; nothing here reaches for a global client.
 */

const crypto = require('crypto');
const { ethers } = require('ethers');
const { signedFromRow, sendWithPermission, relayerWallet, PermissionNotUsed } = require('./redeem');

const TTL_MS = 10 * 60 * 1000;
const SEND_BATCH = 5;

/** The link token is stored only as this. */
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function approvalUrl(siteUrl, token) {
  return `${String(siteUrl || '').replace(/\/$/, '')}/approve/${token}`;
}

/**
 * Opens an approval for one payment. Returns the one-time link.
 * @param {object} p
 * @param {bigint} p.amount raw units
 */
async function createApproval({ supabase, accountId, gator, delegate, symbol, to, amount, amountDisplay, recipientLabel, transferId, siteUrl, now = new Date() }) {
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('amount must be a positive bigint');
  const token = crypto.randomBytes(16).toString('base64url');
  const expiresAt = new Date(now.getTime() + TTL_MS);
  const { data, error } = await supabase
    .from('custody_approvals')
    .insert({
      account_id: accountId,
      token_hash: tokenHash(token),
      transfer_id: transferId || null,
      symbol,
      gator: ethers.getAddress(gator),
      delegate: ethers.getAddress(delegate),
      to_address: ethers.getAddress(to),
      recipient_label: recipientLabel || null,
      amount: amount.toString(),
      amount_display: amountDisplay,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
    })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, url: approvalUrl(siteUrl, token), expiresAt };
}

async function failTransfer(supabase, transferId, reason) {
  if (!transferId) return;
  await supabase.from('transfers').update({ status: 'failed', error: reason }).eq('id', transferId).eq('status', 'pending');
}

function describe(row) {
  return `${row.amount_display}${row.recipient_label ? ` to ${row.recipient_label}` : ''}`;
}

/** Cancels every open approval of an account. Returns how many it closed. */
async function cancelOpenApprovals({ supabase, accountId, now = new Date() }) {
  const { data, error } = await supabase
    .from('custody_approvals')
    .update({ status: 'cancelled', updated_at: now.toISOString() })
    .eq('account_id', accountId)
    .in('status', ['pending', 'signed'])
    .select('id, transfer_id');
  if (error) throw new Error(error.message);
  for (const row of data || []) await failTransfer(supabase, row.transfer_id, 'Cancelled before it was sent. Nothing moved.');
  return (data || []).length;
}

/** Closes open approvals past their expiry and tells each account. Returns how many. */
async function expireApprovals({ supabase, notify, now = new Date() }) {
  const { data, error } = await supabase
    .from('custody_approvals')
    .update({ status: 'expired', updated_at: now.toISOString() })
    .in('status', ['pending', 'signed'])
    .lt('expires_at', now.toISOString())
    .select('id, account_id, transfer_id, amount_display, recipient_label');
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    await failTransfer(supabase, row.transfer_id, 'Not approved in time. Nothing moved.');
    await notify(row.account_id, `Your payment of ${describe(row)} was not approved in time, so it was not sent.`);
  }
  return (data || []).length;
}

/**
 * Sends approvals the passkey has signed. Each is claimed (signed -> sending)
 * before anything else, so no approval is sent twice.
 */
async function sendSignedApprovals({ supabase, provider, notify, explorerUrl, relayer = relayerWallet(provider), now = new Date(), log = console }) {
  const { data: rows, error } = await supabase
    .from('custody_approvals')
    .select('id, account_id, transfer_id, symbol, gator, delegate, to_address, recipient_label, amount, amount_display, salt, caveats, digest, signature, expires_at')
    .eq('status', 'signed')
    .gt('expires_at', now.toISOString())
    .limit(SEND_BATCH);
  if (error) throw new Error(error.message);
  if (!rows?.length) return 0;
  if (!relayer) {
    log.warn('[custody] approved payments are waiting: relayer key unset');
    return 0;
  }

  let sent = 0;
  for (const row of rows) {
    const { data: claimed } = await supabase
      .from('custody_approvals')
      .update({ status: 'sending', updated_at: now.toISOString() })
      .eq('id', row.id)
      .eq('status', 'signed')
      .select('id');
    if (!claimed?.length) continue;

    const finish = async (status, extra = {}) => {
      await supabase.from('custody_approvals').update({ status, updated_at: new Date().toISOString(), ...extra }).eq('id', row.id);
    };
    try {
      const signed = signedFromRow(row);
      if (signed.delegation.delegate !== relayer.address) throw new PermissionNotUsed('the approval names another relayer');
      const out = await sendWithPermission({
        provider,
        relayer,
        signed,
        to: row.to_address,
        amount: BigInt(row.amount),
        onBroadcast: async (hash) => {
          await finish('submitted', { tx_hash: hash });
          if (row.transfer_id) {
            await supabase.from('transfers').update({ status: 'submitted', tx_hash: hash, error: null }).eq('id', row.transfer_id);
          }
        },
      });
      await finish('sent');
      if (row.transfer_id) await supabase.from('transfers').update({ status: 'confirmed', error: null }).eq('id', row.transfer_id);
      await notify(row.account_id, `Approved and sent: ${describe(row)}.\n${explorerUrl(out.txHash)}`);
      sent += 1;
    } catch (err) {
      if (err instanceof PermissionNotUsed) {
        await finish('failed', { error: String(err.reason || err.message).slice(0, 200) });
        if (row.transfer_id) {
          await supabase.from('transfers').update({ status: 'failed', error: 'Approved, but could not be sent. Nothing moved.' }).eq('id', row.transfer_id);
        }
        await notify(row.account_id, `Your approved payment of ${describe(row)} could not be sent. Nothing moved.`);
        log.warn(`[custody] approved ${row.symbol} payment not sent: ${err.reason || err.message}`);
        continue;
      }
      // Outcome unknown: the row stays 'submitted' with its hash. The transfer
      // is 'submitted' too, and the reconciler settles it and tells the account.
      log.warn(`[custody] approved ${row.symbol} payment sent, outcome not known yet`);
    }
  }
  return sent;
}

/** One worker pass: expire what is late, send what is signed. Never throws. */
async function approvalTick(deps) {
  try {
    await expireApprovals(deps);
  } catch (err) {
    (deps.log || console).warn(`[custody] approval expiry failed: ${err.message}`);
  }
  try {
    await sendSignedApprovals(deps);
  } catch (err) {
    (deps.log || console).warn(`[custody] approval send failed: ${err.message}`);
  }
}

/** Runs approvalTick every intervalMs, one pass at a time. */
function startApprovalWorker({ supabase, provider, intervalMs = 5000 }) {
  const { notifyAccount } = require('../notify');
  const { explorerTxUrl, getChain } = require('../chains');
  const deps = {
    supabase,
    provider,
    notify: async (accountId, body) => {
      await notifyAccount(accountId, body).catch(() => null);
    },
    explorerUrl: (hash) => explorerTxUrl(getChain(), hash),
  };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await approvalTick({ ...deps, now: new Date() });
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  createApproval,
  cancelOpenApprovals,
  expireApprovals,
  sendSignedApprovals,
  startApprovalWorker,
};
