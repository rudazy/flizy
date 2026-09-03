/**
 * Who is on this chat: the site account, the legacy users row, a display name.
 *
 * Every handler that moves money or names a person needs the same answers:
 * is this identity linked, which site account is it, which users row holds
 * its credit, and what should the other party see as the sender. Those
 * answers lived in router.js, so a handler group could not leave without
 * importing the router back and closing a cycle. This module is that layer.
 *
 * Nothing here is a command. requireLinkedSite may send a "link first"
 * reply, because that refusal is part of resolving the account rather than
 * part of any one handler's job.
 *
 * Dependencies go one way. This imports identity, session, the chat layer
 * and the wallet; nothing here imports router.
 */

const { config } = require('../config');
const { supabase } = require('../runtime');
const { publicErrorMessage } = require('../sanitize');
const { formatUsernameLabel } = require('../username');
const {
  CHANNELS,
  normalizeChannel,
  getAccountByIdentity,
  setIdentityPhone,
  listIdentitiesForAccount,
} = require('../identity');
const {
  normalizePhoneNumber,
  isPlausiblePhone,
  maskPhone,
} = require('../phone');
const { listClaimableEmailsForAccount } = require('../accountEmails');
const { isSessionUnlocked } = require('../session');
const { ensureAgentWallet } = require('../agentWallet');
const { reply, cmd, transferKey, isAdminUser } = require('./chat');

/** Phones granted admin by configuration rather than by a database flag. */
const ADMIN_PHONES = config.adminPhones;

/** Columns the legacy users row is always read with. Shared with admin credit so the two cannot select different shapes. */
const USER_COLS =
  'id, phone, wallet_address, balance_eth, is_admin, display_name, created_at, account_id';

/**
 * Legacy users row key for a channel identity.
 * WhatsApp keeps its bare sender id so every historic row still matches.
 */
function legacyUserKey(ctx) {
  return transferKey(ctx);
}

/**
 * The legacy users row backing this identity.
 *
 * When the account is already linked, every channel shares the one row bound to
 * that account, so credit and admin never diverge between WhatsApp and Telegram.
 *
 * @param {object} ctx
 * @param {string|null} accountId
 */
async function resolveLegacyUser(ctx, accountId) {
  if (accountId) {
    const { data, error } = await supabase
      .from('users')
      .select(USER_COLS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1);
    if (!error && data && data.length) {
      return { user: data[0], isNew: false };
    }
  }

  const key = legacyUserKey(ctx);
  const { data: existing, error: selectError } = await supabase
    .from('users')
    .select(USER_COLS)
    .eq('phone', key)
    .maybeSingle();
  if (selectError) throw new Error(`Supabase select users failed: ${selectError.message}`);

  if (existing) {
    if (ADMIN_PHONES.has(normalizePhoneNumber(key)) && !existing.is_admin) {
      const { data: promoted, error: promoErr } = await supabase
        .from('users')
        .update({ is_admin: true })
        .eq('id', existing.id)
        .select(USER_COLS)
        .single();
      if (!promoErr && promoted) return { user: promoted, isNew: false };
    }
    return { user: existing, isNew: false };
  }

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({
      phone: key,
      account_id: accountId || null,
      is_admin: ADMIN_PHONES.has(normalizePhoneNumber(key)),
      balance_eth: 0,
    })
    .select(USER_COLS)
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      const { data: raced, error: raceError } = await supabase
        .from('users')
        .select(USER_COLS)
        .eq('phone', key)
        .single();
      if (raceError) throw new Error(`Supabase reselect users failed: ${raceError.message}`);
      return { user: raced, isNew: false };
    }
    throw new Error(`Supabase insert users failed: ${insertError.message}`);
  }

  return { user: created, isNew: true };
}

/**
 * Always show the permanent site agent wallet after link.
 * An unlinked identity must not invent a second address.
 */
async function resolveLinkedSiteAccount(ctx, account) {
  const linked = await getAccountByIdentity(ctx.channel, ctx.externalId);
  if (linked?.account?.email) {
    return ensureAgentWallet(linked.account.id);
  }
  if (account?.email) {
    return ensureAgentWallet(account.id);
  }
  return null;
}

async function requireLinkedSite(ctx, account) {
  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(
      ctx,
      [
        'Link your site account first.',
        `Open ${config.siteUrl}/dashboard`,
        'Generate a code, then send:',
        cmd(ctx, 'link CODE'),
      ].join('\n')
    );
    return null;
  }
  return siteAcc;
}

async function actorSessionFlags(ctx, user, siteAcc) {
  let sessionUnlocked = true;
  if (config.requireUnlock && siteAcc.unlock_pin_hash && !isAdminUser(user)) {
    sessionUnlocked = await isSessionUnlocked(siteAcc.id, ctx.channel, ctx.externalId);
  }
  return {
    accountId: siteAcc.id,
    userId: user.id,
    waSenderId: transferKey(ctx),
    isAdmin: isAdminUser(user),
    creditEth: Number(user.balance_eth || 0),
    sessionUnlocked,
    hasPin: Boolean(siteAcc.unlock_pin_hash),
  };
}

/**
 * Phone join key for claims/requests on this identity.
 * Uses only channel-verified numbers, and stores what it learns.
 *
 * waSenderId is the LEGACY claim key, not the transfer key. It is only ever the
 * bare WhatsApp sender id, because in the @c.us era that id really was the
 * user's phone. A Telegram user id must never be treated as a phone: strip its
 * namespace and a 10-digit Telegram id would match a stranger's claim.
 *
 * @returns {Promise<{ waSenderId: string, waPhone: string|null }>}
 */
async function resolveClaimIdentity(ctx) {
  let phone = null;

  if (typeof ctx.resolveVerifiedPhone === 'function') {
    try {
      phone = await ctx.resolveVerifiedPhone();
    } catch (err) {
      console.warn('resolveVerifiedPhone:', publicErrorMessage(err));
    }
  }

  if (phone && isPlausiblePhone(phone)) {
    try {
      const res = await setIdentityPhone(ctx.channel, ctx.externalId, phone);
      if (!res.ok && res.reason === 'phone_taken') {
        console.warn(`[identity] phone ${maskPhone(phone)} belongs to another account`);
        phone = null;
      }
    } catch (err) {
      console.warn('setIdentityPhone:', publicErrorMessage(err));
    }
  } else {
    phone = null;
  }

  // Every identity this account has proven, which is what makes a platform
  // claim findable: such a claim is addressed to one of these rows, and a row
  // only exists because the recipient completed a link. Emails come from the
  // registration address (and verified secondaries), not from chat link alone.
  let identities = [];
  let emails = [];
  try {
    const bound = await getAccountByIdentity(ctx.channel, ctx.externalId);
    if (!phone && bound?.identity?.phone_e164) {
      phone = normalizePhoneNumber(bound.identity.phone_e164);
    }
    if (bound?.account?.id) {
      identities = (await listIdentitiesForAccount(bound.account.id)).map((i) => ({
        ...i,
        displayHandle: i.display_handle,
      }));
      emails = await listClaimableEmailsForAccount(bound.account.id);
    }
  } catch (err) {
    console.warn('resolveClaimIdentity lookup:', publicErrorMessage(err));
  }

  return {
    // Allowlist, not "everything except Telegram": the legacy key is only
    // meaningful on WhatsApp, and a new channel must not inherit it by default.
    waSenderId: normalizeChannel(ctx.channel) === CHANNELS.WHATSAPP ? ctx.externalId : '',
    waPhone: phone || null,
    identities,
    emails,
  };
}

/**
 * How to name a person on money notifications.
 *
 * Prefer Flizy @username, then display name, then phone. Never email.
 * Username is recognition only — never a payment routing key.
 *
 * @param {object} ctx
 * @param {string|null} accountId
 * @param {object|null} [identity]
 * @param {{ preferPhone?: boolean }} [opts] preferPhone restores old order for
 *   recipient-facing "from" lines where a number is more familiar
 * @returns {Promise<string>}
 */
async function senderLabel(ctx, accountId, identity, opts = {}) {
  const preferPhone = Boolean(opts.preferPhone);
  const phoneLabel = async () => {
    try {
      const mine = identity || (await resolveClaimIdentity(ctx));
      if (mine.waPhone) return `+${mine.waPhone}`;
    } catch (err) {
      console.warn('senderLabel identity:', publicErrorMessage(err));
    }
    return null;
  };

  const accountLabels = async () => {
    if (!accountId) return { username: null, displayName: null };
    try {
      const { data } = await supabase
        .from('accounts')
        .select('username, display_name')
        .eq('id', accountId)
        .maybeSingle();
      return {
        username: formatUsernameLabel(data?.username),
        displayName: data?.display_name ? String(data.display_name).trim() || null : null,
      };
    } catch (err) {
      console.warn('senderLabel account:', publicErrorMessage(err));
      return { username: null, displayName: null };
    }
  };

  const { username, displayName } = await accountLabels();

  if (preferPhone) {
    return (await phoneLabel()) || username || displayName || 'another Flizy user';
  }
  // Claimed-by and similar: @username first, then display name, then phone
  return username || displayName || (await phoneLabel()) || 'another Flizy user';
}

module.exports = {
  USER_COLS,
  legacyUserKey,
  resolveLegacyUser,
  resolveLinkedSiteAccount,
  requireLinkedSite,
  actorSessionFlags,
  resolveClaimIdentity,
  senderLabel,
};
