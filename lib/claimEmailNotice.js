/**
 * Email for claims sent to an address that is not on Flizy, through the site.
 *
 * The bots hold no mail credentials. They name the claim and the kind of email
 * (first or reminder) to /api/internal/claim-notice; the site reads the address
 * from the claim, applies the limits and suppressions, writes the email and
 * sends it (web/lib/claimEmail.ts). The bot cannot choose the address.
 *
 *   registerClaimEmailSender   gives lib/claimNotify.js its email sender, so a
 *                              hold for an email not on Flizy sends the first
 *                              email while CLAIM_NOTIFY_EMAIL is true
 *   startClaimReminderWorker   once, after CLAIM_EMAIL_REMINDER_HOURS, for a
 *                              claim still unclaimed whose first email went out
 *
 * Never throws: the claim is held either way.
 */

const { config } = require('./config');
const { publicErrorMessage } = require('./sanitize');
const { registerNoticeSender } = require('./claimNotify');

const PATH = '/api/internal/claim-notice';
const TIMEOUT_MS = 10000;
const TICK_MS = 15 * 60 * 1000;
const BATCH = 50;
const OLDEST_DAYS = 30;

/** Where the request goes, or null when sending the secret there would be unsafe. */
function claimNoticeUrl(siteUrl = config.siteUrl) {
  let url;
  try {
    url = new URL(PATH, siteUrl);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  return url.toString();
}

/**
 * Ask the site to email a claim's recipient.
 * @param {string} claimId
 * @param {'first'|'reminder'} kind
 * @param {{ fetch?: typeof fetch, secret?: string, siteUrl?: string }} [deps]
 * @returns {Promise<string>} the site's outcome ('sent', 'limited', 'suppressed', ...), or 'unconfigured' / 'failed'
 */
async function requestClaimEmail(claimId, kind, deps = {}) {
  const secret = deps.secret ?? process.env.SECURITY_MAIL_SECRET;
  const url = claimNoticeUrl(deps.siteUrl ?? config.siteUrl);
  if (!secret || !url) {
    console.warn('[claim-email] SECURITY_MAIL_SECRET or an https SITE_URL is missing; the recipient was not emailed');
    return 'unconfigured';
  }
  try {
    const res = await (deps.fetch || fetch)(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ claimId, kind }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.result !== 'string') {
      console.warn(`[claim-email] the site answered ${res.status}`);
      return 'failed';
    }
    return body.result;
  } catch (err) {
    console.warn('[claim-email] request failed:', publicErrorMessage(err));
    return 'failed';
  }
}

/** The email sender for lib/claimNotify.js: accepted only when the site sent it. */
function registerClaimEmailSender(deps = {}) {
  registerNoticeSender('email', async ({ claim }) => (await requestClaimEmail(claim.id, 'first', deps)) === 'sent');
}

/**
 * Claims due a reminder: still pending, sent to an email, older than the delay
 * and not older than OLDEST_DAYS, whose first email went out and which have no
 * reminder yet. The site checks every rule again before it sends.
 */
async function dueReminders(supabase, now, hours) {
  const before = new Date(now - hours * 3600 * 1000).toISOString();
  const after = new Date(now - OLDEST_DAYS * 24 * 3600 * 1000).toISOString();
  const { data: claims, error } = await supabase
    .from('claims')
    .select('id')
    .eq('status', 'pending')
    .not('to_email', 'is', null)
    .lte('created_at', before)
    .gte('created_at', after)
    .limit(BATCH);
  if (error) throw new Error(error.message);
  const ids = (claims || []).map((c) => String(c.id));
  if (!ids.length) return [];
  const { data: notices, error: nErr } = await supabase.from('claim_email_notices').select('claim_id, kind, state').in('claim_id', ids);
  if (nErr) throw new Error(nErr.message);
  const firstSent = new Set((notices || []).filter((n) => n.kind === 'first' && n.state === 'sent').map((n) => String(n.claim_id)));
  const reminded = new Set((notices || []).filter((n) => n.kind === 'reminder').map((n) => String(n.claim_id)));
  return ids.filter((id) => firstSent.has(id) && !reminded.has(id));
}

/** One pass: the reminders due now. Returns how many were sent. */
async function sendDueReminders({ supabase, env = process.env, now = Date.now(), request = requestClaimEmail }) {
  const hours = Number(String(env.CLAIM_EMAIL_REMINDER_HOURS || '72').trim());
  if (!Number.isInteger(hours) || hours < 1) throw new Error('CLAIM_EMAIL_REMINDER_HOURS must be a whole number of hours');
  let sent = 0;
  for (const id of await dueReminders(supabase, now, hours)) {
    if ((await request(id, 'reminder')) === 'sent') sent += 1;
  }
  return sent;
}

/** Run on a timer, from one process only. Nothing runs while CLAIM_NOTIFY_EMAIL is off. */
function startClaimReminderWorker({ supabase, env = process.env }) {
  if (String(env.CLAIM_NOTIFY_EMAIL || '').trim().toLowerCase() !== 'true') return null;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sent = await sendDueReminders({ supabase, env });
      if (sent) console.log('[claim-email] reminders sent:', sent);
    } catch (err) {
      console.error('[claim-email] reminders:', publicErrorMessage(err));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { claimNoticeUrl, requestClaimEmail, registerClaimEmailSender, sendDueReminders, startClaimReminderWorker };
