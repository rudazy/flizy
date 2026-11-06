/**
 * Flizy Pay API payouts spend only through the platform's allowance.
 *
 * A platform's passkey signs a period allowance per asset (api_allowances,
 * signed on the Developers page), delegated to the API relayer
 * (API_RELAYER_KEY). Each payout redeems it through the DelegationManager, so
 * the chain enforces the daily amount however the server behaves. This is the
 * send function the engine's executors take in place of the account's daily
 * permission (lib/engine/executeTransfer.js, `permission`); with ownerKey
 * false they refuse every other path. The owner key is never used and a
 * payout over what is left today never waits for a person: it fails.
 *
 * The API relayer is its own key, never PRIVATE_KEY (which submits UserOps) or
 * CUSTODY_RELAYER_KEY (chat sends): each relayer keeps its own nonces, and the
 * relayer lock (lib/custody/relayerLock.js) is held under its address.
 */

const { ethers } = require('ethers');
const { planPermissionSend, sendWithPermission, PermissionNotUsed } = require('../custody/redeem');

/** A stored allowance this close to its expiry is left alone: the payout could land after it. */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;

/** The API relayer from API_RELAYER_KEY, or null when it is not set. Refuses a key shared with another role. */
function apiRelayerWallet(provider, env = process.env) {
  const raw = String(env.API_RELAYER_KEY || '').trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error('API_RELAYER_KEY must be a 0x-prefixed 32-byte private key');
  for (const other of ['PRIVATE_KEY', 'CUSTODY_RELAYER_KEY', 'ESCROW_PRIVATE_KEY']) {
    if (String(env[other] || '').trim().toLowerCase() === raw.toLowerCase()) {
      throw new Error(`API_RELAYER_KEY must not be the same key as ${other}`);
    }
  }
  return new ethers.Wallet(raw, provider);
}

/** The loader planPermissionSend takes: this platform's live allowance for one asset. */
function allowanceLoader(platformId) {
  return async function loadAllowance(supabase, accountId, symbol, now) {
    const { data, error } = await supabase
      .from('api_allowances')
      .select('symbol, gator, delegate, salt, caveats, digest, signature, expires_at, account_id')
      .eq('platform_id', platformId)
      .eq('symbol', symbol)
      .eq('status', 'active')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data || !data.signature) return null;
    if (String(data.account_id) !== String(accountId)) return null;
    if (new Date(data.expires_at).getTime() - now.getTime() < EXPIRY_MARGIN_MS) return null;
    return data;
  };
}

/**
 * Why the last attempt did not go through the allowance, as an API error code:
 * no_allowance, allowance_exceeded, relayer_unavailable or relayer_busy.
 */
const DECISION_CODES = Object.freeze({
  noAllowance: 'no_allowance',
  exceeded: 'allowance_exceeded',
  relayer: 'relayer_unavailable',
  busy: 'relayer_busy',
});

/**
 * A send function for one payout. `onHash` runs with the transaction hash
 * before the broadcast, after the engine's own record, so the payout row holds
 * the hash before anything can reach the chain. `decision` says why the
 * allowance was not used when it was not.
 */
function apiAllowanceSender({ platformId, relayer, onHash, log = console }) {
  const decision = { code: null, reason: null };
  const refuse = (code, reason) => {
    decision.code = code;
    decision.reason = reason;
    log.warn(`[api-payout] not sent through the allowance: ${reason}`);
    return null;
  };
  async function send({ supabase, provider, accountId, wallet, symbol, amount, to, onBroadcast, beforeSend }) {
    if (!relayer) return refuse(DECISION_CODES.relayer, 'API relayer key unset');
    let plan;
    try {
      plan = await planPermissionSend({ supabase, provider, accountId, wallet, symbol, amount, relayer, load: allowanceLoader(platformId) });
    } catch (err) {
      return refuse(DECISION_CODES.noAllowance, `could not read the allowance (${String(err && err.message ? err.message : err).slice(0, 120)})`);
    }
    if (plan.route === 'owner') return refuse(DECISION_CODES.noAllowance, plan.reason);
    if (plan.route === 'over_cap') {
      refuse(DECISION_CODES.exceeded, `over what is left today (${plan.available})`);
      return { route: 'over_cap', available: plan.available };
    }
    try {
      if (beforeSend) await beforeSend();
      const sent = await sendWithPermission({
        supabase,
        provider,
        relayer,
        signed: plan.signed,
        to,
        amount,
        onBroadcast: async (hash) => {
          if (onBroadcast) await onBroadcast(hash);
          if (onHash) await onHash(hash);
        },
      });
      return { ...sent, route: 'permission' };
    } catch (err) {
      if (err instanceof PermissionNotUsed) return refuse(err.busy ? DECISION_CODES.busy : DECISION_CODES.relayer, err.reason);
      throw err;
    }
  }
  return { send, decision };
}

module.exports = { apiRelayerWallet, allowanceLoader, apiAllowanceSender, DECISION_CODES };
