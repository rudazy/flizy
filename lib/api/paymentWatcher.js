/**
 * Flizy Pay API payments, on the VPS: finds checkout payments on chain and
 * expires open checkouts.
 *
 * A customer pays a checkout through FlizyPaymentReceiver, which logs
 * PaymentReceived(invoiceId, payer, payee, token, amount) and forwards the
 * money straight to the platform's wallet. The checkout page reports the
 * transaction as soon as it is sent (web/app/api/checkout/[id]/route.ts), but
 * a payer may close the page first; this watcher reads every receiver log, in
 * block order from a saved cursor (api_payment_cursor), one block behind the
 * head, and records each one that matches an API payment: its invoice id, to
 * the platform's wallet, in the payment's asset. Recording is the database's
 * api_record_payment, which counts a log once whichever side saw it first.
 * Logs with other invoice ids (the /pay pages) are left alone.
 *
 * Open checkouts past their expiry move to `expired`, with their webhook
 * event. A payment that lands later is still recorded and reported.
 */

const { ethers } = require('ethers');
const { resolveListedSendAsset } = require('../dex');
const deployment = require('../../deployments/giwa-sepolia.json');

const RECEIVER = ethers.getAddress(deployment.paymentReceiver.address);
const IFACE = new ethers.Interface(['event PaymentReceived(bytes32 indexed invoiceId, address indexed payer, address indexed payee, address token, uint256 amount)']);
const TOPIC = IFACE.getEvent('PaymentReceived').topicHash;

const INTERVAL_MS = 15 * 1000;
/** Blocks per getLogs call, and calls per pass while catching up. */
const CHUNK = 2000;
const CHUNKS_PER_TICK = 5;
/** On the very first run: start this far behind the head (no API payment exists before this code). */
const FIRST_RUN_BACK = 2000;
const DECIMALS = { ETH: 18, FLZ: 18, TUSD: 6 };

function makePaymentWatcher({ supabase, provider, chain, log = console }) {
  const short = (err) => String(err && err.message ? err.message : err).slice(0, 160);

  /** The token address each asset is paid in; null for ETH. */
  function tokenFor(asset) {
    if (asset === 'ETH') return null;
    return ethers.getAddress(resolveListedSendAsset(asset, chain.id).tokenAddress).toLowerCase();
  }

  /** One receiver log that belongs to an API payment, recorded once. */
  async function recordLog(entry, payments) {
    const parsed = IFACE.parseLog({ topics: [...entry.topics], data: entry.data });
    if (!parsed) return 'skip';
    const [invoiceId, payer, payee, token, units] = parsed.args;
    const p = payments.get(String(invoiceId).toLowerCase());
    if (!p) return 'skip';
    if (String(payee).toLowerCase() !== String(p.wallet).toLowerCase()) return 'skip';
    const expected = tokenFor(p.asset);
    const paidToken = String(token).toLowerCase() === ethers.ZeroAddress ? null : String(token).toLowerCase();
    if (paidToken !== expected || units <= 0n) return 'skip';
    const { data, error } = await supabase.rpc('api_record_payment', {
      p_transaction_id: p.id,
      p_tx_hash: String(entry.transactionHash).toLowerCase(),
      p_log_index: Number(entry.index),
      p_payer: String(payer).toLowerCase(),
      p_units: units.toString(),
      p_payee_account_id: p.accountId,
      p_payee_address: String(payee).toLowerCase(),
      p_asset: p.asset,
      p_token_address: expected,
      p_amount_text: ethers.formatUnits(units, DECIMALS[p.asset]),
    });
    if (error) throw new Error(error.message);
    return String(data);
  }

  /** The API payments these invoice ids belong to, with their platform's wallet. */
  async function paymentsFor(invoiceIds) {
    const out = new Map();
    if (!invoiceIds.length) return out;
    const { data: rows, error } = await supabase
      .from('api_transactions')
      .select('id, platform_id, asset, invoice_id')
      .eq('kind', 'payment')
      .in('invoice_id', invoiceIds);
    if (error) throw new Error(error.message);
    for (const r of rows || []) {
      const { data: plat } = await supabase.from('api_platforms').select('account_id, wallet_address').eq('id', r.platform_id).maybeSingle();
      if (plat) out.set(String(r.invoice_id).toLowerCase(), { id: r.id, asset: r.asset, accountId: plat.account_id, wallet: plat.wallet_address });
    }
    return out;
  }

  /** Read the next stretch of receiver logs and record what is ours. Returns whether it caught up. */
  async function scanOnce() {
    const head = (await provider.getBlockNumber()) - 1;
    const { data: cursor, error } = await supabase.from('api_payment_cursor').select('last_block').eq('id', true).maybeSingle();
    if (error) throw new Error(error.message);
    const last = cursor && cursor.last_block != null ? Number(cursor.last_block) : head - FIRST_RUN_BACK;
    const from = last + 1;
    if (from > head) return true;
    const to = Math.min(head, from + CHUNK - 1);
    const logs = await provider.getLogs({ address: RECEIVER, topics: [TOPIC], fromBlock: from, toBlock: to });
    const ids = [...new Set(logs.map((l) => String(l.topics[1]).toLowerCase()))];
    const payments = await paymentsFor(ids);
    for (const entry of logs) {
      const outcome = await recordLog(entry, payments);
      if (outcome !== 'skip' && outcome !== 'duplicate') log.info(`[api-payments] ${outcome} in block ${entry.blockNumber}`);
    }
    // Moved on only after every log in the stretch is recorded, so a failure
    // reads the same stretch again; recording twice is harmless.
    const { error: upErr } = await supabase.from('api_payment_cursor').update({ last_block: to, updated_at: new Date().toISOString() }).eq('id', true);
    if (upErr) throw new Error(upErr.message);
    return to >= head;
  }

  /** Open checkouts past their expiry. */
  async function expire() {
    const { data: rows, error } = await supabase
      .from('api_transactions')
      .select('id')
      .eq('kind', 'payment')
      .eq('state', 'accepted')
      .lt('expires_at', new Date().toISOString())
      .limit(50);
    if (error) throw new Error(error.message);
    for (const r of rows || []) {
      const { error: tErr } = await supabase.rpc('api_transition', { p_transaction_id: r.id, p_to_state: 'expired', p_detail: {} });
      // A payment that settled it in between wins: the move from accepted is refused.
      if (tErr) log.info(`[api-payments] ${r.id} not expired: ${short(tErr)}`);
    }
    return (rows || []).length;
  }

  /** One pass. Never throws. */
  async function tick() {
    try {
      for (let i = 0; i < CHUNKS_PER_TICK; i += 1) {
        if (await scanOnce()) break;
      }
    } catch (err) {
      log.warn(`[api-payments] scan: ${short(err)}`);
    }
    try {
      await expire();
    } catch (err) {
      log.warn(`[api-payments] expire: ${short(err)}`);
    }
  }

  return { tick, scanOnce, expire, recordLog };
}

/** Started from the WhatsApp process only, like the payout worker. */
function startApiPaymentWatcher(deps) {
  const watcher = makePaymentWatcher(deps);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await watcher.tick();
    } finally {
      running = false;
    }
  }, deps.intervalMs || INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { makePaymentWatcher, startApiPaymentWatcher, RECEIVER, TOPIC };
