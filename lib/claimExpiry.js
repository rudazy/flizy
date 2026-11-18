/**
 * Claims nobody receives come back to their sender.
 *
 * A chat claim can be received for CLAIM_EXPIRY_DAYS (default 90) after it was
 * sent. Its deadline is written when it is created (lib/claims.js createClaim)
 * and shown in the email, on the claim page, in chat and in the sender's
 * history. Once it passes, this worker refunds the claim to the sender's
 * wallet and tells them in chat. A claim from before deadlines existed is
 * given one, counted from when it was sent.
 *
 * Flizy Pay API claims keep their own expiry and refund
 * (lib/api/payoutWorker.js); this never touches them.
 *
 * Money safety, the same rules as the API refund:
 *   - the claim is locked (pending -> processing) before anything moves, so a
 *     recipient who got there first keeps it, and nobody can claim it while
 *     it refunds;
 *   - the refund's hash is stored on the claim before the broadcast, so a
 *     crash never sends a second refund: a stored hash is settled from its
 *     receipt instead;
 *   - when nothing reached the chain the lock is released and the next pass
 *     tries again.
 *
 * Runs from the WhatsApp process only (index.js). Requires no package at load,
 * so the deadline helpers are safe to load anywhere.
 */

const DAY_MS = 24 * 3600 * 1000;
const TICK_MS = 10 * 60 * 1000;
const PER_TICK = 10;
const FILL_PER_TICK = 50;

/** Days a chat claim can be received. A malformed setting throws: no claim is refunded on a wrong deadline. */
function claimExpiryDays(env = process.env) {
  const raw = String(env.CLAIM_EXPIRY_DAYS ?? '').trim();
  if (!raw) return 90;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 3650) {
    throw new Error('CLAIM_EXPIRY_DAYS must be a whole number of days from 1 to 3650');
  }
  return Number(raw);
}

/** The deadline of a chat claim sent at `sentAt`. */
function claimDeadline(sentAt, env = process.env) {
  return new Date(Date.parse(sentAt) + claimExpiryDays(env) * DAY_MS).toISOString();
}

/** The day a deadline falls on, for chat: 16 Feb 2027 (UTC). */
function deadlineDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}`;
}

/** To the sender: their claim was not received in time and is back in their wallet. */
function formatClaimExpiredNotice({ amount, peer, days }) {
  return [
    `A payment you sent was not received within ${days} days, so it came back to you.`,
    `${amount}${peer ? ` for ${peer}` : ''} is back in your Flizy wallet.`,
  ].join('\n');
}

/**
 * @param {{
 *   supabase: object, provider: object, chain: object,
 *   notifyAccount: (accountId: string, text: string) => Promise<unknown>,
 *   env?: object, now?: () => number, log?: Pick<Console, 'warn'|'error'>,
 *   refund?: Function, claims?: { beginClaimProcessing: Function, releaseClaimProcessing: Function, cancelClaim: Function },
 * }} deps
 */
function makeClaimExpiryWorker(deps) {
  const { supabase, provider, chain, notifyAccount, env = process.env, now = () => Date.now(), log = console } = deps;
  // Loaded on first use: the refund path pulls in the chain libraries.
  const refund = deps.refund || ((...a) => require('./engine/executeClaim').executeClaimRefund(...a));
  const claims = deps.claims || require('./claims');
  const short = (err) => String((err && err.message) || err).slice(0, 160);

  /** A pending chat claim from before deadlines: its deadline, counted from when it was sent. */
  async function fillDeadlines() {
    const { data, error } = await supabase
      .from('claims')
      .select('id, created_at')
      .eq('status', 'pending')
      .is('api_transaction_id', null)
      .is('expires_at', null)
      .limit(FILL_PER_TICK);
    if (error) throw new Error(error.message);
    let filled = 0;
    for (const row of data || []) {
      const { error: upErr } = await supabase
        .from('claims')
        .update({ expires_at: claimDeadline(row.created_at, env) })
        .eq('id', row.id)
        .is('expires_at', null);
      if (upErr) throw new Error(upErr.message);
      filled += 1;
    }
    return filled;
  }

  /** The hash goes on the claim before the broadcast; a write that fails stops the broadcast. */
  async function storeHash(claimId, hash) {
    const { error } = await supabase.from('claims').update({ refund_tx_hash: hash }).eq('id', claimId).eq('status', 'processing');
    if (error) throw new Error(error.message);
  }

  async function clearHash(claimId) {
    const { error } = await supabase.from('claims').update({ refund_tx_hash: null }).eq('id', claimId).eq('status', 'processing');
    if (error) throw new Error(error.message);
  }

  async function tellSender(claim) {
    try {
      const { claimHistoryPeer } = require('./claimHistoryLabel');
      const { formatClaimAmount } = require('./claimAmount');
      const text = formatClaimExpiredNotice({ amount: formatClaimAmount(claim), peer: claimHistoryPeer(claim).peer, days: claimExpiryDays(env) });
      await notifyAccount(claim.from_account_id, text);
    } catch (err) {
      log.warn(`[claim-expiry] ${claim.id} sender notice failed: ${short(err)}`);
    }
  }

  /** Refund a claim this worker holds. Returns true when the money is back and the claim is closed. */
  async function refundHeld(claim) {
    const out = await refund({
      claimId: claim.id,
      fromAccountId: claim.from_account_id,
      provider,
      chain,
      held: true,
      onBroadcast: (hash) => storeHash(claim.id, hash),
    });
    if (out.ok) {
      await tellSender(claim);
      return true;
    }
    // No outcome means it stopped before anything was sent (no gas in escrow,
    // the hold not found): like not_sent, nothing moved.
    if (!out.outcome || out.outcome === 'not_sent' || out.outcome === 'reverted') {
      // Nothing moved: forget any hash and hand the claim back; the next pass tries again.
      await clearHash(claim.id);
      await claims.releaseClaimProcessing(claim.id);
    } else if (out.refundTxHash) {
      // The money moved but the claim was not closed (an NFT refund records no
      // hash before it is sent): keep the hash so the receipt check closes it.
      await storeHash(claim.id, out.refundTxHash);
    }
    log.warn(`[claim-expiry] ${claim.id} refund not done yet: ${String(out.error || out.outcome || '').slice(0, 120)}`);
    return false;
  }

  /** Refunds already broadcast: confirmed, the claim is closed; reverted, it is sent again; unknown, it waits. */
  async function settleRecorded() {
    const { data, error } = await supabase
      .from('claims')
      .select('*')
      .eq('status', 'processing')
      .is('api_transaction_id', null)
      .not('refund_tx_hash', 'is', null)
      .lte('expires_at', new Date(now()).toISOString())
      .limit(PER_TICK);
    if (error) throw new Error(error.message);
    let closed = 0;
    for (const claim of data || []) {
      try {
        const receipt = await provider.getTransactionReceipt(claim.refund_tx_hash);
        if (!receipt) continue;
        if (receipt.status === 1) {
          const done = await claims.cancelClaim(claim.id, claim.from_account_id, claim.refund_tx_hash);
          if (done.ok) {
            closed += 1;
            await tellSender(claim);
          }
          continue;
        }
        await clearHash(claim.id);
        if (await refundHeld(claim)) closed += 1;
      } catch (err) {
        log.warn(`[claim-expiry] ${claim.id}: ${short(err)}`);
      }
    }
    return closed;
  }

  /** Claims past their deadline: locked, then refunded. */
  async function expireDue() {
    const { data, error } = await supabase
      .from('claims')
      .select('*')
      .eq('status', 'pending')
      .is('api_transaction_id', null)
      .not('from_account_id', 'is', null)
      .lte('expires_at', new Date(now()).toISOString())
      .order('expires_at', { ascending: true })
      .limit(PER_TICK);
    if (error) throw new Error(error.message);
    let refunded = 0;
    for (const claim of data || []) {
      try {
        // Locked first: if the recipient got there, the claim is theirs.
        const held = await claims.beginClaimProcessing(claim.id);
        if (!held) continue;
        if (await refundHeld(held)) refunded += 1;
      } catch (err) {
        log.warn(`[claim-expiry] ${claim.id}: ${short(err)}`);
      }
    }
    return refunded;
  }

  /** One pass. Never throws. */
  async function tick() {
    const out = { filled: 0, settled: 0, refunded: 0 };
    try {
      out.filled = await fillDeadlines();
    } catch (err) {
      log.warn(`[claim-expiry] deadlines: ${short(err)}`);
    }
    try {
      out.settled = await settleRecorded();
    } catch (err) {
      log.warn(`[claim-expiry] settle: ${short(err)}`);
    }
    try {
      out.refunded = await expireDue();
    } catch (err) {
      log.warn(`[claim-expiry] expire: ${short(err)}`);
    }
    return out;
  }

  return { tick, fillDeadlines, settleRecorded, expireDue };
}

/** Run on a timer, from one process only. The setting is read first, so a malformed one stops it at startup. */
function startClaimExpiryWorker(deps) {
  claimExpiryDays(deps.env || process.env);
  const worker = makeClaimExpiryWorker(deps);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const out = await worker.tick();
      if (out.refunded || out.settled) console.log('[claim-expiry] claims refunded:', out.refunded + out.settled);
    } finally {
      running = false;
    }
  }, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  claimExpiryDays,
  claimDeadline,
  deadlineDay,
  formatClaimExpiredNotice,
  makeClaimExpiryWorker,
  startClaimExpiryWorker,
};
