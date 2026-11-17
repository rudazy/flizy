/**
 * Settles smart-account sends whose outcome was unknown when they were made.
 *
 * executeGatorCall records a transaction's hash before broadcasting it. If the
 * send then times out or the RPC fails, the record is left as broadcast:
 *
 *   transfers           status 'submitted' with tx_hash
 *   limit_orders        status 'filling' with tx_hash
 *   claim_hold_attempts status 'submitted' with hold_tx_hash
 *
 * Every minute this reads each one's receipt by hash and finishes it. Success
 * means the outer handleOps transaction succeeded AND the UserOp inside it
 * succeeded for the account's gator (userOpSucceeded); an EOA-path transfer is
 * judged by its receipt alone.
 *
 * Every status change is a compare-and-set on the status it expects, so the
 * send path and this job can never both settle the same record. With no
 * receipt after an hour nothing is guessed: the record is flagged, admins are
 * told once, and the user still sees "still confirming". Flagged records
 * (and unknown claim holds) are still read every tick in a small rotating
 * batch, so a transaction that lands late still settles.
 *
 * Runs in the WhatsApp bot process only, like the limit-order watcher.
 */

const { ethers } = require('ethers');
const { publicErrorMessage } = require('./sanitize');
const { recordClaimEvent } = require('./claimEvents');
const { claimShareMessage, telegramStartUrl } = require('./claimShare');

const TICK_MS = 60_000;
/** Younger than this, the sender may still be waiting on its own receipt. */
const SETTLE_AFTER_MS = 2 * 60_000;
/** No receipt after this long: flag for a person. */
const UNKNOWN_AFTER_MS = 60 * 60_000;
/** A 'sending' attempt this old was never broadcast (the hash is recorded first). */
const SENDING_STALE_MS = 10 * 60_000;
const BATCH = 50;
/**
 * Records already flagged (no receipt after an hour) are still checked, so one
 * that lands later still settles. They get their own small batch, read in
 * turn through a rotating cursor, so a pile of them can never crowd out fresh
 * records or each other.
 */
const FLAGGED_BATCH = 10;
const NO_RECEIPT_NOTE = 'No receipt after an hour. A person needs to check this transaction.';
const LIMIT_NO_RECEIPT_NOTE = 'Still confirming. Check History before placing it again.';

/** Where each kind's flagged batch reads from next (a created/updated time). */
const flaggedCursor = new Map();

/**
 * Fresh records, then the next slice of flagged ones.
 * @param {() => object} fresh query builder for records not yet flagged
 * @param {() => object} flagged query builder for flagged records
 * @param {string} kind cursor key
 * @param {string} timeCol column the cursor walks
 */
async function batches(fresh, flagged, kind, timeCol) {
  const a = await fresh().order(timeCol, { ascending: true }).limit(BATCH);
  if (a.error) throw new Error(a.error.message);
  const from = flaggedCursor.get(kind) || '1970-01-01T00:00:00.000Z';
  const b = await flagged().gt(timeCol, from).order(timeCol, { ascending: true }).limit(FLAGGED_BATCH);
  if (b.error) throw new Error(b.error.message);
  const slice = b.data || [];
  // A short slice means the end was reached: start over next tick.
  flaggedCursor.set(kind, slice.length < FLAGGED_BATCH ? null : slice[slice.length - 1][timeCol]);
  return [...(a.data || []), ...slice];
}

/**
 * @typedef {{
 *   supabase: import('@supabase/supabase-js').SupabaseClient,
 *   provider: import('ethers').Provider,
 *   now?: number,
 *   entryPoint?: string,
 *   gatorOf?: (accountId: string) => string,
 *   userOpSucceeded?: (receipt: object, entryPoint: string, sender: string) => boolean,
 *   alertAdmins?: (text: string) => Promise<void>,
 *   markRequestPaid?: Function,
 *   releaseRequestProcessing?: Function,
 *   creditBack?: (row: object) => Promise<void>,
 *   createClaim?: Function,
 *   notifyAccount?: Function,
 *   notifyClaimRecipient?: (attempt: object, claim: object) => Promise<void>,
 *   explorerUrl?: (txHash: string) => string,
 *   settleTransferFee?: (d: object, row: object, outcome: string) => Promise<void>,
 *   settleClaimFee?: (d: object, attempt: object, outcome: string) => Promise<void>,
 *   recordSwapFee?: (d: object, row: object) => Promise<void>,
 * }} ReconcileDeps
 */

function defaults(deps) {
  const gator = require('./gatorExecute');
  const account = require('./gatorAccount');
  return {
    now: Date.now(),
    entryPoint: account.gatorAddresses().entryPointV07,
    gatorOf: account.predictGatorAddress,
    userOpSucceeded: gator.userOpSucceeded,
    alertAdmins: (text) => alertAdmins(deps.supabase, text),
    markRequestPaid: (...a) => require('./paymentRequests').markRequestPaid(...a),
    releaseRequestProcessing: (...a) => require('./paymentRequests').releaseRequestProcessing(...a),
    creditBack: defaultCreditBack,
    createClaim: (...a) => require('./claims').createClaim(...a),
    notifyAccount: (...a) => require('./notify').notifyAccount(...a),
    notifyClaimRecipient: defaultNotifyClaimRecipient,
    explorerUrl: defaultExplorerUrl,
    settleTransferFee: defaultSettleTransferFee,
    settleClaimFee: defaultSettleClaimFee,
    recordSwapFee: defaultRecordSwapFee,
    ...deps,
  };
}

/**
 * The pending Flizy fee of a transfer the reconciler just settled
 * (lib/feeQuote.js). A payment that landed carried its fee in the same
 * transaction, so the fee is charged; one that did not, waived. A payment a
 * passkey approved carried only the payment, so its fee is collected now
 * through the daily permission, or waived (lib/engine/sendFee.js). Never throws.
 */
async function defaultSettleTransferFee(d, row, outcome) {
  try {
    const { pendingFee, settleFee, waiveFee } = require('./feeQuote');
    const pending = await pendingFee({ supabase: d.supabase, sourceKind: 'transfer', sourceId: row.id });
    if (!pending) return;
    if (outcome !== 'success') {
      await waiveFee({ supabase: d.supabase, sourceKind: 'transfer', sourceId: row.id, reason: 'reverted' });
      return;
    }
    const { data: approval } = await d.supabase.from('custody_approvals').select('gator').eq('transfer_id', row.id).maybeSingle();
    if (approval && approval.gator) {
      await require('./engine/sendFee').collectApprovedFee({ supabase: d.supabase, provider: d.provider, transferId: row.id, accountId: row.account_id, gator: approval.gator });
      return;
    }
    await settleFee({ supabase: d.supabase, sourceKind: 'transfer', sourceId: row.id, txHash: row.tx_hash });
  } catch (err) {
    console.error(`[reconcile] fee for transfer ${row.id}:`, publicErrorMessage(err));
  }
}

/**
 * A swap the reconciler just found landed: the fee router's fee, in the fee
 * ledger (lib/swapFee.js), as the executor records it for a swap that answers
 * at once. A swap sent through EntryPoint came from the account's smart
 * account. Never throws.
 */
async function defaultRecordSwapFee(d, row) {
  try {
    const receipt = await d.provider.getTransactionReceipt(row.tx_hash);
    if (!receipt) return;
    const viaGator = Boolean(receipt.to) && ethers.getAddress(receipt.to) === ethers.getAddress(d.entryPoint);
    const gator = viaGator ? d.gatorOf(row.account_id) : null;
    await require('./swapFee').recordSwapFee({
      supabase: d.supabase,
      provider: d.provider,
      receipt,
      transferId: row.id,
      accountId: row.account_id,
      payer: gator || receipt.from || null,
      gator,
    });
  } catch (err) {
    console.error(`[reconcile] swap fee for ${row.id}:`, publicErrorMessage(err));
  }
}

/**
 * The pending Flizy fee of a claim hold the reconciler just settled. The fee
 * went in the same transaction as the hold, so a hold in escrow charged it and
 * a reverted one did not. Its ledger source is the hold attempt. Never throws.
 */
async function defaultSettleClaimFee(d, attempt, outcome) {
  try {
    const { settleFee, waiveFee } = require('./feeQuote');
    if (outcome === 'success') {
      await settleFee({ supabase: d.supabase, sourceKind: 'claim', sourceId: attempt.id, txHash: attempt.hold_tx_hash });
    } else {
      await waiveFee({ supabase: d.supabase, sourceKind: 'claim', sourceId: attempt.id, reason: 'reverted' });
    }
  } catch (err) {
    console.error(`[reconcile] fee for claim hold ${attempt.id}:`, publicErrorMessage(err));
  }
}

/**
 * Tell every admin (lib/commands/chat.js adminAccountIds) on their linked chats, and
 * report to Sentry. Never throws.
 */
async function alertAdmins(supabase, text) {
  console.error(`[reconcile] ${text}`);
  try {
    require('./sentry').reportError(new Error(`[reconcile] ${text}`));
  } catch {
    /* Sentry is optional */
  }
  try {
    const { adminAccountIds } = require('./commands/chat');
    const { notifyAccount } = require('./notify');
    for (const id of await adminAccountIds(supabase)) {
      await notifyAccount(id, `Flizy reconcile: ${text}`);
    }
  } catch (err) {
    console.error('[reconcile] admin notice failed:', publicErrorMessage(err));
  }
}

/** A legacy credit reservation is only taken with ENFORCE_CREDIT on. */
async function defaultCreditBack(row) {
  const { config } = require('./config');
  if (!config.enforceCredit || !row.user_id) return;
  if (String(row.kind || 'transfer') !== 'transfer') return;
  if (!['ETH', 'NATIVE', 'ETHER'].includes(String(row.asset || 'ETH').toUpperCase())) return;
  await require('./credit').creditUserCredit(row.user_id, String(row.amount_eth));
}

/** Tells a recipient already on Flizy. Returns whether a notice went out. */
async function defaultNotifyClaimRecipient(attempt, claim) {
  const handlers = require('./handlers/claims');
  const r = (attempt.claim_args && attempt.claim_args.recipient) || {};
  // No live chat here: the notifiers only use ctx to skip the sender's chat.
  const ctx = { channel: null, externalId: null };
  const amount = claim.amount_eth || attempt.amount_eth;
  const nft = attempt.nft_token_id || null;
  if (r.kind === 'platform' && r.channel && r.externalId) {
    return handlers.notifyClaimPlatformTarget(ctx, r.channel, r.externalId, amount, attempt.from_account_id, attempt.asset, nft);
  } else if (r.kind === 'email' && r.email) {
    return handlers.notifyClaimEmailTarget(ctx, r.email, amount, attempt.from_account_id, attempt.asset, nft);
  } else if (r.kind === 'phone' && r.phone) {
    return handlers.notifyClaimTarget(ctx, r.phone, amount, attempt.from_account_id, attempt.asset, nft);
  }
  return false;
}

/**
 * Did this transaction do what it was sent to do?
 * @returns {Promise<'success'|'failed'|null>} null while there is no receipt
 */
async function outcomeOf(d, txHash, accountId) {
  const receipt = await d.provider.getTransactionReceipt(txHash);
  if (!receipt) return null;
  if (receipt.status !== 1) return 'failed';
  const to = receipt.to ? ethers.getAddress(receipt.to) : null;
  if (to && to === ethers.getAddress(d.entryPoint)) {
    return d.userOpSucceeded(receipt, d.entryPoint, d.gatorOf(accountId)) ? 'success' : 'failed';
  }
  return 'success';
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * The message an account gets when a payment it was told is pending settles.
 * Only outgoing payments from an account; null for anything else.
 */
function settledPaymentNotice(row, outcome, explorerUrlFor) {
  if (!row.account_id || String(row.kind || 'transfer') !== 'transfer' || row.direction === 'in') return null;
  const { symbolLabel } = require('./listedTokens');
  const what = `${row.amount_eth} ${symbolLabel(row.asset || 'ETH')}`;
  if (outcome === 'success') return `Your pending payment of ${what} went through.\n${explorerUrlFor(row.tx_hash)}`;
  return `Your pending payment of ${what} did not go through. The money did not move.`;
}

function defaultExplorerUrl(txHash) {
  const { explorerTxUrl, getChain } = require('./chains');
  return explorerTxUrl(getChain(), txHash);
}

async function reconcileTransfers(d, counts) {
  const base = () =>
    d.supabase
      .from('transfers')
      .select('id, account_id, user_id, tx_hash, kind, asset, amount_eth, payment_request_id, created_at, error, direction')
      .eq('status', 'submitted')
      .not('tx_hash', 'is', null)
      .lt('created_at', iso(d.now - SETTLE_AFTER_MS));
  const rowsToCheck = await batches(
    () => base().is('error', null),
    () => base().eq('error', NO_RECEIPT_NOTE),
    'transfers',
    'created_at'
  );
  for (const row of rowsToCheck) {
    try {
      const outcome = await outcomeOf(d, row.tx_hash, row.account_id);
      if (!outcome) {
        if (d.now - Date.parse(row.created_at) < UNKNOWN_AFTER_MS || row.error) continue;
        const flagged = await d.supabase
          .from('transfers')
          .update({ error: NO_RECEIPT_NOTE })
          .eq('id', row.id)
          .eq('status', 'submitted')
          .is('error', null)
          .select('id');
        if (flagged.data && flagged.data.length) {
          counts.unknown += 1;
          await d.alertAdmins(`transfer ${row.id} has no receipt after an hour (tx ${row.tx_hash}).`);
        }
        continue;
      }
      const moved = await d.supabase
        .from('transfers')
        .update(
          outcome === 'success'
            ? { status: 'confirmed', error: null }
            : { status: 'failed', error: 'Reverted on-chain. Nothing moved.' }
        )
        .eq('id', row.id)
        .eq('status', 'submitted')
        .select('id');
      if (!moved.data || !moved.data.length) continue;
      await d.settleTransferFee(d, row, outcome);
      if (outcome === 'success' && String(row.kind || '').toLowerCase() === 'swap') await d.recordSwapFee(d, row);
      if (outcome === 'success') {
        counts.confirmed += 1;
        if (row.payment_request_id) {
          await d.markRequestPaid(row.payment_request_id, row.account_id, row.tx_hash, String(row.amount_eth));
        }
      } else {
        counts.failed += 1;
        if (row.payment_request_id) await d.releaseRequestProcessing(row.payment_request_id);
        await d.creditBack(row);
      }
      // The chat said this payment was pending; now say how it settled.
      const notice = settledPaymentNotice(row, outcome, d.explorerUrl);
      if (notice) await d.notifyAccount(row.account_id, notice);
    } catch (err) {
      console.error(`[reconcile] transfer ${row.id}:`, publicErrorMessage(err));
    }
  }
}

async function reconcileLimitOrders(d, counts) {
  const base = () =>
    d.supabase
      .from('limit_orders')
      .select('id, account_id, tx_hash, updated_at, error')
      .eq('status', 'filling')
      .not('tx_hash', 'is', null)
      .lt('updated_at', iso(d.now - SETTLE_AFTER_MS));
  const orders = await batches(
    () => base().is('error', null),
    () => base().eq('error', LIMIT_NO_RECEIPT_NOTE),
    'limit_orders',
    'updated_at'
  );
  for (const order of orders) {
    try {
      const outcome = await outcomeOf(d, order.tx_hash, order.account_id);
      if (!outcome) {
        if (d.now - Date.parse(order.updated_at) < UNKNOWN_AFTER_MS || order.error) continue;
        const flagged = await d.supabase
          .from('limit_orders')
          .update({ error: LIMIT_NO_RECEIPT_NOTE })
          .eq('id', order.id)
          .eq('status', 'filling')
          .is('error', null)
          .select('id');
        if (flagged.data && flagged.data.length) {
          counts.unknown += 1;
          await d.alertAdmins(`limit order ${order.id} has no receipt after an hour (tx ${order.tx_hash}).`);
        }
        continue;
      }
      const moved = await d.supabase
        .from('limit_orders')
        .update(
          outcome === 'success'
            ? { status: 'filled', filled_at: iso(d.now), updated_at: iso(d.now), error: null }
            : { status: 'failed', updated_at: iso(d.now), error: 'The swap reverted on-chain. Nothing was traded.' }
        )
        .eq('id', order.id)
        .eq('status', 'filling')
        .select('id');
      if (moved.data && moved.data.length) counts[outcome === 'success' ? 'confirmed' : 'failed'] += 1;
    } catch (err) {
      console.error(`[reconcile] limit order ${order.id}:`, publicErrorMessage(err));
    }
  }
}

async function claimForHash(d, txHash) {
  const { data } = await d.supabase.from('claims').select('id, amount_eth').eq('hold_tx_hash', txHash).maybeSingle();
  return data || null;
}

async function reconcileClaimHolds(d, counts) {
  const attempts = require('./claimHoldAttempts');

  // Never broadcast: the hash is recorded before the broadcast, so an attempt
  // still in 'sending' moved nothing.
  await d.supabase
    .from('claim_hold_attempts')
    .update({ status: 'refused', error: 'Stopped before it was sent.' })
    .eq('status', 'sending')
    .lt('created_at', iso(d.now - SENDING_STALE_MS));

  const base = () =>
    d.supabase
      .from('claim_hold_attempts')
      .select('id, status, from_account_id, chain_id, amount_eth, asset, token_address, nft_token_id, claim_args, hold_tx_hash, created_at')
      .not('hold_tx_hash', 'is', null)
      .lt('created_at', iso(d.now - SETTLE_AFTER_MS));
  // 'unknown' attempts are still read: a hold that lands after the hour still
  // becomes its claim.
  const holds = await batches(
    () => base().eq('status', 'submitted'),
    () => base().eq('status', 'unknown'),
    'claim_hold_attempts',
    'created_at'
  );
  for (const a of holds) {
    try {
      const outcome = await outcomeOf(d, a.hold_tx_hash, a.from_account_id);
      if (!outcome) {
        if (a.status === 'unknown' || d.now - Date.parse(a.created_at) < UNKNOWN_AFTER_MS) continue;
        if (await attempts.markUnknown(a.id, 'submitted', NO_RECEIPT_NOTE)) {
          counts.unknown += 1;
          await d.alertAdmins(`claim hold ${a.id} has no receipt after an hour (tx ${a.hold_tx_hash}).`);
        }
        continue;
      }
      if (outcome === 'failed') {
        if (await attempts.markFailed(a.id, 'Reverted on-chain. Nothing moved.', a.status)) {
          counts.failed += 1;
          await d.settleClaimFee(d, a, 'failed');
          await d.notifyAccount(a.from_account_id, 'Your claim hold did not go through, so nothing was held. Nothing left your wallet.');
        }
        continue;
      }
      // In escrow. One claim per hold tx (claims_hold_tx_hash_unique), so if the
      // send path wrote it first, or a create races, the existing row is used.
      let claim = await claimForHash(d, a.hold_tx_hash);
      let created = false;
      let claimUrl = null;
      if (!claim) {
        try {
          const res = await d.createClaim({
            fromAccountId: a.from_account_id,
            fromWaSender: a.claim_args && a.claim_args.fromWaSender,
            recipient: a.claim_args && a.claim_args.recipient,
            amountEth: String(a.amount_eth),
            asset: a.asset,
            tokenAddress: a.token_address,
            nftTokenId: a.nft_token_id,
            chainId: a.chain_id,
            holdTxHash: a.hold_tx_hash,
            expiresAt: a.claim_args && a.claim_args.expiresAt,
            apiTransactionId: a.claim_args && a.claim_args.apiTransactionId,
          });
          claim = res.claim;
          claimUrl = res.claimUrl;
          created = true;
        } catch (err) {
          claim = await claimForHash(d, a.hold_tx_hash);
          if (!claim) throw err;
        }
      }
      if (await attempts.markHeld(a.id, claim.id, a.status)) {
        counts.confirmed += 1;
        await d.settleClaimFee(d, a, 'success');
        // A Flizy Pay API hold: the payout worker tells the platform (webhook)
        // and the recipient (named as the partner), not these chat notices.
        if (created && !(a.claim_args && a.claim_args.apiTransactionId)) {
          const told = await d.notifyClaimRecipient(a, claim);
          if (told) await recordClaimEvent(d.supabase, claim.id, 'notified', { channel: 'chat' });
          await d.notifyAccount(a.from_account_id, 'Your claim hold confirmed. The funds are held for the recipient.');
          // Not on Flizy: the sender gets the link to forward, as after a hold in chat.
          if (!told && claimUrl) {
            const r = (a.claim_args && a.claim_args.recipient) || {};
            await d.notifyAccount(
              a.from_account_id,
              claimShareMessage({
                amount: claim.amount_eth,
                asset: claim.asset,
                nftTokenId: claim.nft_token_id,
                url: claimUrl,
                telegramUrl: r.channel === 'telegram' ? telegramStartUrl(require('./config').config.telegramBotUsername, claim.claim_token) : null,
              })
            );
            await recordClaimEvent(d.supabase, claim.id, 'link_shared', { channel: 'share_link' });
          }
        }
      }
    } catch (err) {
      console.error(`[reconcile] claim hold ${a.id}:`, publicErrorMessage(err));
    }
  }
}

/**
 * One pass over every kind of unsettled record.
 * @param {ReconcileDeps} deps
 */
async function runReconcileTick(deps) {
  const d = defaults(deps);
  const counts = { confirmed: 0, failed: 0, unknown: 0 };
  await reconcileTransfers(d, counts);
  await reconcileLimitOrders(d, counts);
  await reconcileClaimHolds(d, counts);
  return counts;
}

/**
 * Run on a timer, one tick at a time.
 * @param {{ supabase: object, provider: object }} deps
 */
function startReconciler(deps) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const counts = await runReconcileTick({ ...deps, now: Date.now() });
      if (counts.confirmed || counts.failed || counts.unknown) console.log('[reconcile]', counts);
    } catch (err) {
      console.error('[reconcile] tick:', publicErrorMessage(err));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

/** Tests start each case from the first flagged record. */
function resetFlaggedCursors() {
  flaggedCursor.clear();
}

module.exports = {
  runReconcileTick,
  resetFlaggedCursors,
  FLAGGED_BATCH,
  LIMIT_NO_RECEIPT_NOTE,
  startReconciler,
  alertAdmins,
  SETTLE_AFTER_MS,
  UNKNOWN_AFTER_MS,
  SENDING_STALE_MS,
  NO_RECEIPT_NOTE,
  settledPaymentNotice,
};
