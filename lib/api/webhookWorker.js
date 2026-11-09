/**
 * Flizy Pay API webhook delivery, on the VPS.
 *
 * Every payout state change writes its event (api_webhook_events) in the same
 * transaction as the change. This worker:
 *   1. fans each new event out to a delivery (api_webhook_deliveries) for every
 *      enabled endpoint of that platform that wants the event's type;
 *   2. delivers what is due, a batch at a time sent together, so one slow
 *      endpoint cannot hold up everyone else's: signed (lib/api/webhookSign.js)
 *      with the endpoint's secret, sent only to a public https address
 *      (lib/api/webhookSend.js), every attempt recorded (api_webhook_attempts);
 *   3. retries with backoff (30 s, doubling, at most 6 h apart) and gives up 24
 *      hours after the event, leaving the delivery failed for the Developers
 *      page to retry by hand.
 * A delivery is claimed before it is sent (next_attempt_at moved forward only
 * where it still holds the value read), so two passes never send the same one.
 * Nothing here reads or writes a payout: a failed delivery never changes one.
 *
 * Needs API_WEBHOOK_KEY (the secrets are stored encrypted); without it,
 * deliveries wait.
 */

const { webhookKey, decryptWebhookSecret } = require('./webhookSecret');
const { signWebhook, SIGNATURE_HEADER } = require('./webhookSign');
const { sendWebhook } = require('./webhookSend');

const INTERVAL_MS = 10 * 1000;
const EVENTS_PER_TICK = 50;
const DELIVERIES_PER_TICK = 10;
/** How long a claimed delivery is held before another pass may take it. */
const CLAIM_MS = 60 * 1000;
const FIRST_RETRY_MS = 30 * 1000;
const MAX_RETRY_MS = 6 * 3600 * 1000;
const GIVE_UP_MS = 24 * 3600 * 1000;

/** The wait before attempt n + 1, after n failed attempts. */
function backoffMs(attempts) {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
}

function makeWebhookWorker({ supabase, env = process.env, send = sendWebhook, now = () => Date.now(), log = console }) {
  let warnedNoKey = false;
  const short = (err) => String(err && err.message ? err.message : err).slice(0, 160);

  /** New events become deliveries for the endpoints that want them. */
  async function dispatch() {
    const { data: events, error } = await supabase
      .from('api_webhook_events')
      .select('id, platform_id, type')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(EVENTS_PER_TICK);
    if (error) throw new Error(error.message);
    for (const ev of events || []) {
      const { data: endpoints, error: epErr } = await supabase
        .from('api_webhook_endpoints')
        .select('id, events')
        .eq('platform_id', ev.platform_id)
        .eq('enabled', true);
      if (epErr) throw new Error(epErr.message);
      const wanted = (endpoints || []).filter((e) => !Array.isArray(e.events) || e.events.length === 0 || e.events.includes(ev.type));
      if (wanted.length) {
        const { error: insErr } = await supabase
          .from('api_webhook_deliveries')
          .upsert(
            wanted.map((e) => ({ event_id: ev.id, endpoint_id: e.id, platform_id: ev.platform_id })),
            { onConflict: 'event_id,endpoint_id', ignoreDuplicates: true }
          );
        if (insErr) throw new Error(insErr.message);
      }
      await supabase.from('api_webhook_events').update({ status: 'dispatched' }).eq('id', ev.id).eq('status', 'pending');
    }
    return (events || []).length;
  }

  /** One delivery, sent and recorded. */
  async function deliverOne(row, key) {
    const t = now();
    // Claimed only if no other pass moved it since it was read.
    const { data: claimed } = await supabase
      .from('api_webhook_deliveries')
      .update({ next_attempt_at: new Date(t + CLAIM_MS).toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .eq('next_attempt_at', row.next_attempt_at)
      .select('id');
    if (!Array.isArray(claimed) || claimed.length === 0) return 'taken';

    const [{ data: ev }, { data: ep }] = await Promise.all([
      supabase.from('api_webhook_events').select('id, type, payload, created_at').eq('id', row.event_id).maybeSingle(),
      supabase.from('api_webhook_endpoints').select('id, url, secret_ciphertext, enabled').eq('id', row.endpoint_id).maybeSingle(),
    ]);
    const finishWith = async (fields) => {
      await supabase.from('api_webhook_deliveries').update(fields).eq('id', row.id);
    };
    if (!ev || !ep || !ep.enabled) {
      await finishWith({ status: 'failed', last_error: 'endpoint removed or disabled' });
      return 'failed';
    }

    let result;
    const started = now();
    try {
      const secret = decryptWebhookSecret(ep.secret_ciphertext, ep.id, key);
      const body = JSON.stringify({ id: ev.id, type: ev.type, created_at: ev.created_at, data: ev.payload });
      result = await send({
        url: ep.url,
        body,
        headers: { [SIGNATURE_HEADER]: signWebhook(secret, body), 'Flizy-Event-Id': ev.id, 'Flizy-Event-Type': ev.type },
      });
    } catch (err) {
      result = { ok: false, status: null, error: short(err) };
    }
    const attempts = Number(row.attempts || 0) + 1;
    await supabase.from('api_webhook_attempts').insert({
      event_id: ev.id,
      endpoint_id: ep.id,
      delivery_id: row.id,
      http_status: result.status,
      error: result.ok ? null : String(result.error || '').slice(0, 300),
      duration_ms: Math.max(0, now() - started),
    });

    if (result.ok) {
      await finishWith({ status: 'delivered', attempts, last_status: result.status, last_error: null, delivered_at: new Date(now()).toISOString() });
      return 'delivered';
    }
    const tooLate = now() - Date.parse(ev.created_at) >= GIVE_UP_MS;
    await finishWith({
      status: tooLate ? 'failed' : 'pending',
      attempts,
      last_status: result.status,
      last_error: String(result.error || 'failed').slice(0, 300),
      next_attempt_at: new Date(now() + backoffMs(attempts)).toISOString(),
    });
    return tooLate ? 'failed' : 'retry';
  }

  /** What is due, oldest first. */
  async function deliverDue() {
    let key;
    try {
      key = webhookKey(env);
    } catch (err) {
      log.warn(`[api-webhooks] ${short(err)}`);
      return 0;
    }
    if (!key) {
      if (!warnedNoKey) log.warn('[api-webhooks] API_WEBHOOK_KEY is not set; webhook deliveries wait');
      warnedNoKey = true;
      return 0;
    }
    const { data: due, error } = await supabase
      .from('api_webhook_deliveries')
      .select('id, event_id, endpoint_id, attempts, next_attempt_at')
      .eq('status', 'pending')
      .lte('next_attempt_at', new Date(now()).toISOString())
      .order('next_attempt_at', { ascending: true })
      .limit(DELIVERIES_PER_TICK);
    if (error) throw new Error(error.message);
    // Each delivery is claimed on its own, so they can go out together; the
    // pass takes as long as its slowest one (at most the 10 s send timeout).
    const outcomes = await Promise.all(
      (due || []).map((row) =>
        deliverOne(row, key).catch((err) => {
          log.warn(`[api-webhooks] delivery ${row.id}: ${short(err)}`);
          return 'error';
        })
      )
    );
    return outcomes.filter((o) => o === 'delivered').length;
  }

  /** One pass. Never throws. */
  async function tick() {
    try {
      await dispatch();
    } catch (err) {
      log.warn(`[api-webhooks] dispatch: ${short(err)}`);
    }
    try {
      return await deliverDue();
    } catch (err) {
      log.warn(`[api-webhooks] deliver: ${short(err)}`);
      return 0;
    }
  }

  return { tick, dispatch, deliverDue, deliverOne };
}

/** Started from the WhatsApp process only, like the payout worker. */
function startApiWebhookWorker(deps) {
  const worker = makeWebhookWorker(deps);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await worker.tick();
    } finally {
      running = false;
    }
  }, deps.intervalMs || INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { makeWebhookWorker, startApiWebhookWorker, backoffMs };
