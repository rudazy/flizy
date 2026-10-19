/**
 * Which approval a money action needs: a plain confirm (Tier 0) or the PIN
 * (Tier 1). Account changes take the password (Tier 2) and are not decided
 * here.
 *
 * Tier 0 is narrow on purpose. It covers only:
 *   - an ETH payment to a known recipient, at or under the quick-send amount;
 *   - a swap between ETH and a verified token, either direction, any size,
 *     and a liquidity change on a verified pool, when the price check in
 *     lib/priceReference.js passed. The value stays in the account. Swaps
 *     are held to QUICK_SWAPS_PER_HOUR an hour, chat and site together.
 * Everything else is Tier 1: token and NFT payments (no price to hold against
 * the quick-send amount yet), new recipients, claim holds, Ammora tokens, any
 * payment over the quick-send amount, any swap whose price check failed, and
 * any swap past the hourly count.
 *
 * "Known" has one definition, the SQL function is_known_recipient
 * (supabase/migrations/20261018100000_known_recipients.sql), which the site
 * calls too. The rule itself is mirrored in web/lib/tiers.ts, and
 * test/tiersDrift.test.js keeps the two identical.
 */

const { ethers } = require('ethers');
const { config } = require('./config');

/** Swaps an account may make in a rolling hour, chat and site together, before the PIN applies again. */
const QUICK_SWAPS_PER_HOUR = 4;
const QUICK_SWAP_WINDOW_MS = 60 * 60 * 1000;

/**
 * ETH amount as wei, or null when it is not a usable non-negative amount.
 * @param {number|string|null|undefined} value
 * @returns {bigint|null}
 */
function ethToWei(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  try {
    // A number like 1e-7 prints in exponent form, which parseEther refuses.
    return ethers.parseEther(typeof value === 'number' ? n.toFixed(18) : String(value).trim());
  } catch {
    return null;
  }
}

/**
 * The quick-send amount in wei. The account's own value applies when it is
 * set, but never above the app default: raising past the default comes with a
 * waiting period, which is not built yet.
 *
 * @param {{ quick_send_eth?: number|string|null }|null|undefined} account
 * @param {number} [defaultEth]
 * @returns {bigint}
 */
function quickSendWei(account, defaultEth = config.defaultQuickSendEth) {
  const ceiling = ethToWei(defaultEth) ?? 0n;
  const own = account ? ethToWei(account.quick_send_eth) : null;
  if (own == null) return ceiling;
  return own < ceiling ? own : ceiling;
}

/** The quick-send ceiling in wei: the app default. */
function quickSendCeilingWei() {
  return ethToWei(config.defaultQuickSendEth) ?? 0n;
}

/**
 * @typedef {{
 *   action: 'send' | 'swap' | 'liquidity' | 'other',
 *   native: boolean,
 *   amountWei: bigint,
 *   quickSendWei: bigint,
 *   known?: boolean,
 *   verified?: boolean,
 *   price?: { ok: boolean },
 *   swapsThisHour?: number | null,
 * }} TierInput
 *
 * @typedef {{ tier: 0 | 1, reason: string }} TierResult
 */

/**
 * @param {TierInput} input
 * @returns {TierResult}
 */
function evaluateTier(input) {
  const { action, native, amountWei, quickSendWei: q } = input;
  // A swap between ETH and a verified token, or a liquidity change on a
  // verified pool, keeps the value in the account. What protects it is the
  // price (lib/priceReference.js), not the PIN, so any size needs only a
  // price check that passed.
  if (action === 'swap' || action === 'liquidity') {
    if (action === 'swap' && input.verified !== true) return { tier: 1, reason: 'unverified_token' };
    if (input.price?.ok !== true) return { tier: 1, reason: 'price_check' };
    // Each swap inside the price band can still lose a few percent to someone
    // trading around it, so only a few an hour skip the PIN.
    if (action === 'swap' && !(Number.isInteger(input.swapsThisHour) && input.swapsThisHour < QUICK_SWAPS_PER_HOUR)) {
      return { tier: 1, reason: 'swap_limit' };
    }
    return { tier: 0, reason: 'value_stays' };
  }
  if (action !== 'send') return { tier: 1, reason: 'always_pin' };
  if (typeof amountWei !== 'bigint' || amountWei <= 0n) return { tier: 1, reason: 'bad_amount' };
  if (typeof q !== 'bigint' || q <= 0n) return { tier: 1, reason: 'quick_send_off' };
  if (!native) return { tier: 1, reason: 'unpriced' };
  if (amountWei > q) return { tier: 1, reason: 'over_quick_send' };
  if (input.known !== true) return { tier: 1, reason: 'new_recipient' };
  return { tier: 0, reason: 'quick_send' };
}

/**
 * Is this address one the account already pays? A read that fails throws, and
 * callers treat that as not known: the PIN is asked for, nothing is refused.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} accountId
 * @param {string} address
 * @returns {Promise<boolean>}
 */
async function isKnownRecipient(supabase, accountId, address) {
  if (!accountId || !ethers.isAddress(String(address || ''))) return false;
  const { data, error } = await supabase.rpc('is_known_recipient', {
    p_account_id: accountId,
    p_address: String(address).toLowerCase(),
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * The account's quick-send amount, read fresh. A read that fails gives 0, so
 * the PIN is asked for.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} accountId
 * @returns {Promise<bigint>}
 */
async function accountQuickSendWei(supabase, accountId) {
  const { data, error } = await supabase
    .from('accounts')
    .select('quick_send_eth')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return 0n;
  return quickSendWei(data);
}

/**
 * The tier of a payment to an address, read fresh: the account's quick-send
 * amount and whether the address is known. A failed read of either asks for
 * the PIN.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} accountId
 * @param {string} address
 * @param {boolean} native
 * @param {bigint} amountWei
 * @returns {Promise<TierResult>}
 */
async function sendTier(supabase, accountId, address, native, amountWei) {
  let known = false;
  try {
    known = await isKnownRecipient(supabase, accountId, address);
  } catch {
    known = false;
  }
  const q = await accountQuickSendWei(supabase, accountId);
  return evaluateTier({ action: 'send', native, amountWei, quickSendWei: q, known });
}

/**
 * The tier of a swap on Flizy's pools. The quick-send amount plays no part:
 * the price check (lib/priceReference.js swapPriceCheck) and the hourly count
 * (swapsInLastHour) decide.
 *
 * @param {boolean} verified both sides are ETH or a verified token
 * @param {{ ok: boolean }|null} price
 * @param {number|null} [swapsThisHour]
 * @returns {TierResult}
 */
function swapTier(verified, price, swapsThisHour) {
  // Amount and quick send are ignored for a swap; they are filled only for the type.
  return evaluateTier({
    action: 'swap',
    native: true,
    amountWei: 0n,
    quickSendWei: 0n,
    verified,
    price: price || undefined,
    swapsThisHour,
  });
}

/**
 * Swaps this account made in the last hour, in chat and on the site, any
 * status: every swap writes a transfers row of kind 'swap'. A read that fails
 * gives null, which asks for the PIN.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} accountId
 * @param {number} [now]
 * @returns {Promise<number|null>}
 */
async function swapsInLastHour(supabase, accountId, now = Date.now()) {
  if (!accountId) return null;
  const { data, error } = await supabase
    .from('transfers')
    .select('id')
    .eq('account_id', accountId)
    .eq('kind', 'swap')
    .gte('created_at', new Date(now - QUICK_SWAP_WINDOW_MS).toISOString());
  if (error || !Array.isArray(data)) return null;
  return data.length;
}

/**
 * The line chat adds under a plan that takes the PIN, saying why. Chat only:
 * the site shows its own copy.
 *
 * @param {string} reason from evaluateTier, or 'claim_hold'
 * @returns {string}
 */
function tierApprovalNote(reason) {
  const after = 'After CONFIRM you approve it with your PIN on Flizy.';
  if (reason === 'new_recipient') return `You have not paid this address before. ${after}`;
  if (reason === 'over_quick_send') return `This is above your quick send amount. ${after}`;
  if (reason === 'unpriced') return `Tokens and NFTs always take the PIN. ${after}`;
  if (reason === 'unverified_token') return `Flizy has not verified this token. ${after}`;
  if (reason === 'swap_limit') return `That is ${QUICK_SWAPS_PER_HOUR} swaps in the last hour, so this one takes the PIN. ${after}`;
  if (reason === 'price_check') return `The pool price is away from its recent level, or could not be checked. ${after}`;
  if (reason === 'claim_hold') return `The person is not on Flizy yet. ${after}`;
  return after;
}

module.exports = {
  ethToWei,
  tierApprovalNote,
  sendTier,
  swapTier,
  swapsInLastHour,
  QUICK_SWAPS_PER_HOUR,
  quickSendWei,
  quickSendCeilingWei,
  evaluateTier,
  isKnownRecipient,
  accountQuickSendWei,
};
