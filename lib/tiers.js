/**
 * Which approval a money action needs: a plain confirm (Tier 0) or the PIN
 * (Tier 1). Account changes take the password (Tier 2) and are not decided
 * here.
 *
 * This decides payments, which send value to someone else. Tier 0 is narrow
 * on purpose: an ETH payment to a known recipient, at or under the quick-send
 * amount. Everything else is Tier 1: token and NFT payments (no price to hold
 * against the quick-send amount yet), new recipients, claim holds, and any
 * payment over the quick-send amount.
 *
 * Trades are not decided here. A swap or a liquidity change keeps the value in
 * the account, so on testnet it is a plain confirm, with no PIN, on the site
 * and in chat (web/app/api/swap/execute/route.ts, lib/router.js).
 *
 * "Known" has one definition, the SQL function is_known_recipient
 * (supabase/migrations/20261018100000_known_recipients.sql), which the site
 * calls too. The rule itself is mirrored in web/lib/tiers.ts, and
 * test/tiersDrift.test.js keeps the two identical.
 */

const { ethers } = require('ethers');
const { config } = require('./config');

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
 *   action: 'send' | 'other',
 *   native: boolean,
 *   amountWei: bigint,
 *   quickSendWei: bigint,
 *   known?: boolean,
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
  if (reason === 'claim_hold') return `The person is not on Flizy yet. ${after}`;
  return after;
}

module.exports = {
  ethToWei,
  tierApprovalNote,
  sendTier,
  quickSendWei,
  quickSendCeilingWei,
  evaluateTier,
  isKnownRecipient,
  accountQuickSendWei,
};
