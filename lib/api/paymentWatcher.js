/**
 * Payments through FlizyPaymentReceiver, on the VPS: finds checkout and pay
 * page payments on chain, and expires open checkouts.
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
 *
 * Every other log is a pay page payment from a wallet outside Flizy
 * (/pay/<name>). The page reports it too (web/app/api/pay/external), but only
 * while it stays open, so the watcher records it the same way
 * (web/lib/externalPay.ts): to an account that takes outside payments, in ETH
 * or a listed token, once per log in external_payments whichever side saw it
 * first. Only the side that wrote it tells the payee, in chat and in the site's
 * notices; the email goes only when the page reported it. The note is the
 * page's to add: the watcher cannot read it.
 *
 * Open checkouts past their expiry move to `expired`, with their webhook
 * event. A payment that lands later is still recorded and reported.
 */

const { ethers } = require('ethers');
const { resolveListedSendAsset } = require('../dex');
const { config } = require('../config');
const { notifyAccount, formatReceivedNotice } = require('../notify');
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

/** Payments below these are recorded but not announced, as on the pay page. */
const DUST = { ETH: 0.0001, FLZ: 0.01, TUSD: 0.01 };
/** Payment notices one account may get in an hour, as on the site (web/lib/incomingNotice.ts). */
const NOTICES_PER_HOUR = 30;

function makePaymentWatcher({ supabase, provider, chain, log = console, notify = notifyAccount }) {
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

  /** Which pay-list asset a token address is: ETH, FLZ or tUSD at its listed contract. */
  function payAssetFor(token) {
    const t = String(token).toLowerCase();
    if (t === ethers.ZeroAddress) return 'ETH';
    for (const asset of ['FLZ', 'TUSD']) {
      if (tokenFor(asset) === t) return asset;
    }
    return null;
  }

  /** One pay page payment, recorded once. The payee hears about it only when this call wrote it. */
  async function recordPayPageLog(entry) {
    const parsed = IFACE.parseLog({ topics: [...entry.topics], data: entry.data });
    if (!parsed) return 'skip';
    const [invoiceId, payer, payee, token, units] = parsed.args;
    const asset = payAssetFor(token);
    if (!asset || units <= 0n) return 'skip';
    const payeeAddr = ethers.getAddress(payee);
    const { data: acct, error: accErr } = await supabase
      .from('accounts')
      .select('id, accept_outside_pay')
      .ilike('agent_wallet_address', payeeAddr)
      .maybeSingle();
    if (accErr) throw new Error(accErr.message);
    if (!acct || acct.accept_outside_pay !== true) return 'skip';

    const txHash = String(entry.transactionHash).toLowerCase();
    const payerAddr = String(payer).toLowerCase();
    const amount = ethers.formatUnits(units, DECIMALS[asset]);
    const tokenAddr = asset === 'ETH' ? null : String(token).toLowerCase();
    const { data: inserted, error } = await supabase
      .from('external_payments')
      .upsert(
        {
          tx_hash: txHash,
          log_index: Number(entry.index),
          invoice_id: String(invoiceId).toLowerCase(),
          payer_address: payerAddr,
          payee_account_id: acct.id,
          payee_address: payeeAddr.toLowerCase(),
          asset,
          token_address: tokenAddr,
          amount_units: units.toString(),
          amount,
          note: null,
        },
        { onConflict: 'tx_hash,log_index', ignoreDuplicates: true }
      )
      .select('id');
    if (error) throw new Error(error.message);
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!row || !row.id) return 'duplicate';

    // The payee's history reads transfers by the wallet paid; the payer has no account.
    const payerShort = `${payerAddr.slice(0, 6)}...${payerAddr.slice(-4)}`;
    const fromLabel = `an outside wallet (${payerShort})`;
    const { data: transfer, error: tErr } = await supabase
      .from('transfers')
      .insert({
        account_id: null,
        phone: 'external',
        to_address: payeeAddr,
        amount_eth: amount,
        status: 'confirmed',
        tx_hash: txHash,
        kind: 'transfer',
        asset,
        token_address: tokenAddr ? ethers.getAddress(tokenAddr) : null,
        counterparty_label: payerShort,
        direction: 'out',
        note: null,
      })
      .select('id')
      .maybeSingle();
    if (tErr) throw new Error(tErr.message);
    if (transfer && transfer.id) {
      const { error: linkErr } = await supabase.from('external_payments').update({ transfer_id: transfer.id }).eq('id', row.id);
      if (linkErr) throw new Error(linkErr.message);
    }

    if (Number(amount) >= DUST[asset]) {
      try {
        await notify(acct.id, formatReceivedNotice({ amountEth: amount, asset, fromLabel }));
      } catch (err) {
        log.warn(`[pay-page] payee chat notice was not queued: ${short(err)}`);
      }
      const label = asset === 'TUSD' ? 'tUSD' : asset;
      const body = [`You received ${amount} ${label} from ${fromLabel}.`, '', `It is in your Flizy wallet: ${config.siteUrl}/dashboard/wallet`].join('\n');
      const dedupeKey = `in:${txHash}:payment-${Number(entry.index)}:${asset.toLowerCase()}`;
      // The site's hourly cap on payment notices (web/lib/incomingNotice.ts), so a
      // stream of payments cannot flood an account's notices from here either.
      const { count, error: cErr } = await supabase
        .from('account_notices')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', acct.id)
        .gte('created_at', new Date(Date.now() - 3600e3).toISOString());
      if (cErr) log.warn(`[pay-page] payee site notices could not be counted: ${short(cErr)}`);
      else if ((count || 0) >= NOTICES_PER_HOUR) log.warn('[pay-page] payee site notice skipped: hourly cap reached');
      else {
        const { error: nErr } = await supabase
          .from('account_notices')
          .upsert({ account_id: acct.id, kind: 'payment', body, dedupe_key: dedupeKey }, { onConflict: 'account_id,dedupe_key', ignoreDuplicates: true });
        if (nErr) log.warn(`[pay-page] payee site notice was not stored: ${short(nErr)}`);
      }
    }
    return 'recorded';
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
      // A checkout's invoice id is the API's; any other is a pay page payment.
      const isCheckout = payments.has(String(entry.topics[1]).toLowerCase());
      const outcome = isCheckout ? await recordLog(entry, payments) : await recordPayPageLog(entry);
      if (outcome !== 'skip' && outcome !== 'duplicate') log.info(`[${isCheckout ? 'api-payments' : 'pay-page'}] ${outcome} in block ${entry.blockNumber}`);
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

  return { tick, scanOnce, expire, recordLog, recordPayPageLog };
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
