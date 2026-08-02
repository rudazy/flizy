/**
 * Account identity across chat channels + site link codes.
 *
 * An identity is (channel, external_id) -> account:
 *   whatsapp -> observed WhatsApp sender id (often a LID, not a phone)
 *   telegram -> numeric Telegram user id
 *
 * One account can hold many identities (WhatsApp and Telegram at once).
 * One phone maps to exactly one account, across every channel. That rule is
 * checked here for a clear message and enforced again by a database trigger.
 *
 * Phone stays separate from identity: it is only the join key for claims and
 * payment requests, and it is only ever accepted from a verified source
 * (WhatsApp contact metadata, Telegram contact share). Never from typed text.
 */

const { getSupabase } = require('./supabase');
const { config } = require('./config');
const { normalizePhoneNumber, isPlausiblePhone } = require('./phone');
const {
  CHANNELS,
  normalizeChannel,
  isKnownChannel,
  assertChannel,
  normalizeExternalId,
} = require('./channelKey');
const { generateLinkCode } = require('./linkCode');
const {
  linkLockState,
  recordFailedLinkAttempt,
  clearLinkAttempts,
} = require('./linkAttempts');
const { bindChannelIdentity, REBIND_POLICY } = require('./channelBind');

const IDENTITY_SELECT = 'id, account_id, channel, external_id, phone_e164, accounts(*)';

/** Postgres SQLSTATE raised by the one-phone-one-account trigger. */
const PHONE_CONFLICT_CODE = 'FZ001';

/** @deprecated Use normalizeExternalId. Kept for existing WhatsApp call sites. */
function normalizeSenderId(raw) {
  return normalizeExternalId(raw);
}

/**
 * Key written to transfers.phone and matched by the site history view.
 * WhatsApp keeps its bare sender id so every historic row still resolves.
 * Other channels are namespaced so a Telegram user id can never collide with
 * somebody's phone digits.
 *
 * @param {string} channel
 * @param {string} externalId
 */
function identityTransferKey(channel, externalId) {
  const ch = assertChannel(channel, 'identityTransferKey');
  const id = normalizeExternalId(externalId);
  return ch === CHANNELS.WHATSAPP ? id : `${ch}:${id}`;
}

function shapeIdentity(row) {
  if (!row) return null;
  return {
    identity: {
      id: row.id,
      channel: row.channel,
      external_id: row.external_id,
      phone_e164: row.phone_e164,
      account_id: row.account_id,
      // Legacy aliases so older call sites keep reading the same values
      wa_sender_id: row.external_id,
      wa_phone_e164: row.phone_e164,
    },
    account: row.accounts,
  };
}

/**
 * Load account by (channel, external id).
 * @param {string} channel
 * @param {string} externalId
 */
async function getAccountByIdentity(channel, externalId) {
  const supabase = getSupabase();
  const ch = assertChannel(channel, 'getAccountByIdentity');
  const id = normalizeExternalId(externalId);
  if (!id) return null;

  const { data, error } = await supabase
    .from('channel_identities')
    .select(IDENTITY_SELECT)
    .eq('channel', ch)
    .eq('external_id', id)
    .maybeSingle();

  if (error) throw new Error(`identity lookup failed: ${error.message}`);
  return shapeIdentity(data);
}

/** @param {string} waSenderId */
async function getAccountByWaSender(waSenderId) {
  return getAccountByIdentity(CHANNELS.WHATSAPP, waSenderId);
}

/**
 * Every identity bound to an account (used for cross-channel notifications).
 * @param {string} accountId
 * @returns {Promise<Array<{ channel: string, external_id: string, phone_e164: string|null }>>}
 */
async function listIdentitiesForAccount(accountId) {
  if (!accountId) return [];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('channel_identities')
    .select('channel, external_id, phone_e164')
    .eq('account_id', accountId);
  if (error) throw new Error(`identity list failed: ${error.message}`);
  return data || [];
}

/**
 * Which account owns this phone, if any. The claim/notify join key.
 * @param {string} phoneRaw
 * @returns {Promise<string|null>} account id
 */
async function findAccountIdByPhone(phoneRaw) {
  const phone = normalizePhoneNumber(phoneRaw);
  if (!phone || !isPlausiblePhone(phone)) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('channel_identities')
    .select('account_id')
    .eq('phone_e164', phone)
    .limit(1);
  if (error) throw new Error(`phone lookup failed: ${error.message}`);
  return data && data.length ? data[0].account_id : null;
}

/**
 * One phone, one account. Call before binding a phone to an account.
 *
 * @param {string} phoneRaw
 * @param {string} accountId
 * @returns {Promise<{ ok: boolean, phone?: string, reason?: 'invalid'|'phone_taken', accountId?: string }>}
 */
async function assertPhoneFreeForAccount(phoneRaw, accountId) {
  const phone = normalizePhoneNumber(phoneRaw);
  if (!phone || !isPlausiblePhone(phone)) {
    return { ok: false, reason: 'invalid' };
  }
  const owner = await findAccountIdByPhone(phone);
  if (owner && owner !== accountId) {
    return { ok: false, reason: 'phone_taken', accountId: owner, phone };
  }
  return { ok: true, phone };
}

function isPhoneConflictError(err) {
  const code = err && err.code ? String(err.code) : '';
  const message = err && err.message ? String(err.message) : '';
  return code === PHONE_CONFLICT_CODE || /already bound to a different flizy account/i.test(message);
}

/**
 * Store a verified phone on an identity (fill or refresh).
 * Never changes which account the identity belongs to.
 *
 * @param {string} channel
 * @param {string} externalId
 * @param {string} phoneRaw verified phone only (WA contact metadata / TG contact share)
 * @returns {Promise<{ ok: boolean, phone?: string, reason?: 'invalid'|'unknown_identity'|'phone_taken' }>}
 */
async function setIdentityPhone(channel, externalId, phoneRaw) {
  const ch = assertChannel(channel, 'setIdentityPhone');
  const id = normalizeExternalId(externalId);
  const phone = normalizePhoneNumber(phoneRaw);
  if (!id || !phone || !isPlausiblePhone(phone)) {
    return { ok: false, reason: 'invalid' };
  }

  const bound = await getAccountByIdentity(ch, id);
  if (!bound?.identity?.account_id) {
    return { ok: false, reason: 'unknown_identity' };
  }

  const free = await assertPhoneFreeForAccount(phone, bound.identity.account_id);
  if (!free.ok) {
    return { ok: false, reason: free.reason === 'invalid' ? 'invalid' : 'phone_taken' };
  }

  const supabase = getSupabase();
  const { error } = await supabase
    .from('channel_identities')
    .update({ phone_e164: phone })
    .eq('channel', ch)
    .eq('external_id', id);

  if (error) {
    if (isPhoneConflictError(error)) return { ok: false, reason: 'phone_taken' };
    throw new Error(`identity phone update failed: ${error.message}`);
  }
  return { ok: true, phone };
}

/**
 * Ensure an account + identity exist for a chat id.
 *
 * WhatsApp additionally bridges the legacy users row (Phase 0 ledger) so old
 * senders keep their credit. Other channels never touch that table here.
 *
 * @param {string} channel
 * @param {string} externalId
 */
async function getOrCreateAccountForIdentity(channel, externalId) {
  const ch = assertChannel(channel, 'getOrCreateAccountForIdentity');
  const id = normalizeExternalId(externalId);
  if (!id) throw new Error('identity create failed: empty external id');

  const existing = await getAccountByIdentity(ch, id);
  if (existing) return { ...existing, isNew: false };

  const supabase = getSupabase();
  let accountId = null;
  let legacy = null;

  if (ch === CHANNELS.WHATSAPP) {
    const { data } = await supabase
      .from('users')
      .select('id, phone, balance_eth, is_admin, account_id, wallet_address')
      .eq('phone', id)
      .maybeSingle();
    legacy = data || null;
    accountId = legacy?.account_id || null;
  }

  if (!accountId) {
    const { data: account, error: accErr } = await supabase
      .from('accounts')
      .insert({
        is_admin: Boolean(legacy?.is_admin),
        balance_eth: legacy?.balance_eth ?? 0,
        agent_wallet_address: legacy?.wallet_address || null,
      })
      .select('*')
      .single();
    if (accErr) throw new Error(`account create failed: ${accErr.message}`);
    accountId = account.id;

    if (legacy?.id) {
      await supabase.from('users').update({ account_id: accountId }).eq('id', legacy.id);
    }
  }

  const { data: identity, error: idErr } = await supabase
    .from('channel_identities')
    .insert({
      account_id: accountId,
      channel: ch,
      external_id: id,
    })
    .select('*')
    .single();

  if (idErr) {
    // Race: another insert won
    if (idErr.code === '23505') {
      const raced = await getAccountByIdentity(ch, id);
      if (raced) return { ...raced, isNew: false };
    }
    throw new Error(`identity create failed: ${idErr.message}`);
  }

  const { data: account, error: fetchErr } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);

  return {
    identity: {
      ...identity,
      wa_sender_id: identity.external_id,
      wa_phone_e164: identity.phone_e164,
    },
    account,
    isNew: true,
  };
}

/** @param {string} waSenderId */
async function getOrCreateAccountForSender(waSenderId) {
  return getOrCreateAccountForIdentity(CHANNELS.WHATSAPP, waSenderId);
}

/**
 * Create a one-time link code for an account (site).
 * The same code works on every channel: identity is proven by the fact that
 * only a logged-in account holder can generate one.
 *
 * @param {string} accountId
 * @returns {Promise<{ code: string, expiresAt: string, waDeepLink: string, telegramDeepLink: string|null }>}
 */
async function createLinkCode(accountId) {
  const supabase = getSupabase();
  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + config.linkCodeTtlMs).toISOString();

  const { error } = await supabase.from('link_codes').insert({
    account_id: accountId,
    code,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`link code create failed: ${error.message}`);

  const bot = config.botWhatsAppNumber || '';
  const prefill = encodeURIComponent(`flizy link ${code}`);
  const waDeepLink = bot
    ? `https://wa.me/${bot}?text=${prefill}`
    : `https://wa.me/?text=${prefill}`;

  const tgBot = config.telegramBotUsername || '';
  const telegramDeepLink = tgBot ? `https://t.me/${tgBot}?start=${code}` : null;

  return { code, expiresAt, waDeepLink, telegramDeepLink };
}

/**
 * Bind a chat identity to the account that owns the code, and burn the code.
 *
 * A valid site code is a deliberate bind or rebind of that one identity. It
 * never merges accounts and never moves another channel's identity.
 *
 * @param {string} channel
 * @param {string} externalId
 * @param {string} codeRaw
 * @param {string} [verifiedPhone] verified phone when the channel supplies one
 * @returns {Promise<{ ok: boolean, reason?: string, account?: object, identity?: object, rebound?: boolean, phone?: string|null }>}
 */
async function consumeLinkCode(channel, externalId, codeRaw, verifiedPhone) {
  const supabase = getSupabase();
  const ch = assertChannel(channel, 'consumeLinkCode');
  const id = normalizeExternalId(externalId);
  const phone =
    verifiedPhone && isPlausiblePhone(verifiedPhone)
      ? normalizePhoneNumber(verifiedPhone)
      : null;
  const code = String(codeRaw || '')
    .trim()
    .toUpperCase();

  if (!id) return { ok: false, reason: 'invalid' };

  // Above the lookup on purpose, exactly like the PIN path: a locked-out guesser
  // must not learn whether the code they tried exists.
  const lock = await linkLockState(ch, id);
  if (lock.locked) {
    console.warn(`[link] refused, locked out channel=${ch} until=${lock.until}`);
    return {
      ok: false,
      reason: 'locked_out',
      lockedUntil: lock.until,
      retryAfterMs: lock.remainingMs,
      retryAfterText: lock.retryAfterText,
    };
  }

  // Deliberately not filtered on used_at. A code that exists but is spent has to
  // be told apart from a code that never existed: the first is a real code the
  // account holder was issued, the second is a guess. Filtering here made them
  // look identical, which meant re-clicking your own stale link counted as brute
  // force. The dashboard renders one single-use code with both a WhatsApp and a
  // Telegram button, so spending it on one and then trying the other is a normal
  // thing to do, not an attack.
  const { data: row, error } = await supabase
    .from('link_codes')
    .select('*')
    .eq('code', code)
    .maybeSingle();

  if (error) throw new Error(error.message);

  // Only a code that does not exist at all counts as a guess. At 50 bits a brute
  // forcer lands here essentially every time, so nothing is lost by being
  // generous to codes we really did issue.
  if (!row) {
    const counted = await recordFailedLinkAttempt(ch, id);
    return {
      ok: false,
      reason: 'invalid',
      attempts: counted.attempts,
      attemptsLeft: counted.attemptsLeft,
      lockedForMs: counted.lockedForMs,
      retryAfterText: counted.retryAfterText,
    };
  }
  if (row.used_at) {
    return { ok: false, reason: 'used', usedByChannel: row.used_by_channel || null };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // One phone, one account. Fail loudly and leave the code unburned so the user
  // can link the right account after resolving it.
  if (phone) {
    const free = await assertPhoneFreeForAccount(phone, row.account_id);
    if (!free.ok && free.reason === 'phone_taken') {
      return { ok: false, reason: 'phone_bound_elsewhere', phone };
    }
  }

  // Read before the write only so the caller can be told whether this was a
  // rebind. The write itself is the shared core's job.
  const existing = await getAccountByIdentity(ch, id);

  // The identity write moved to lib/channelBind.js so the OAuth callback cannot
  // reimplement it and quietly drop a protection. The behaviour here is
  // unchanged: policy "move" is exactly what this path always did, because a
  // link code is a fresh single-use proof of intent for one specific account.
  // OAuth has no equivalent and passes "reject".
  //
  // The phone travels as an extra column rather than through setIdentityPhone,
  // because the one-phone-one-account check already ran above, against the
  // account that issued the code. The database trigger is still the backstop
  // and surfaces here as a phone conflict.
  try {
    await bindChannelIdentity(supabase, {
      accountId: row.account_id,
      channel: ch,
      externalId: id,
      rebindPolicy: REBIND_POLICY.MOVE,
      extraColumns: phone ? { phone_e164: phone } : {},
    });
  } catch (err) {
    if (isPhoneConflictError(err)) {
      return { ok: false, reason: 'phone_bound_elsewhere', phone };
    }
    throw new Error(err.message || String(err));
  }

  // Keep the legacy users row pointing at the site account (WhatsApp ledger)
  if (ch === CHANNELS.WHATSAPP) {
    await supabase.from('users').update({ account_id: row.account_id }).eq('phone', id);
  }

  const { error: burnErr } = await supabase
    .from('link_codes')
    .update({
      used_at: new Date().toISOString(),
      used_by_channel: ch,
      used_by_external_id: id,
    })
    .eq('id', row.id)
    .is('used_at', null);
  if (burnErr) throw new Error(burnErr.message);

  // A correct code is the only thing that clears the counter, same rule as a
  // correct PIN.
  await clearLinkAttempts(ch, id);

  const bound = await getAccountByIdentity(ch, id);
  return {
    ok: true,
    account: bound?.account,
    identity: bound?.identity,
    rebound: Boolean(existing),
    phone: bound?.identity?.phone_e164 || null,
  };
}

/**
 * Create a bare account (site signup stub). No custody yet.
 */
async function createAccountStub(displayName) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .insert({
      display_name: displayName || null,
      agent_wallet_address: null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = {
  CHANNELS,
  normalizeChannel,
  isKnownChannel,
  assertChannel,
  normalizeExternalId,
  normalizeSenderId,
  identityTransferKey,
  getAccountByIdentity,
  getAccountByWaSender,
  getOrCreateAccountForIdentity,
  getOrCreateAccountForSender,
  listIdentitiesForAccount,
  findAccountIdByPhone,
  assertPhoneFreeForAccount,
  setIdentityPhone,
  createLinkCode,
  consumeLinkCode,
  createAccountStub,
};
