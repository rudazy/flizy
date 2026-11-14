/**
 * A secured account's payments that go on Flizy's owner key while its daily
 * permission is live: checkout payments (on the site or in chat) and payments
 * on the site's pay page. The permission's own period never counts them, so
 * the daily passkey limit is what the period reports less these, over the last
 * 24 hours (one period is a day, so 24 hours back covers whichever window is
 * current).
 *
 * Read by chat sends and holds (./redeem.js, trySendWithPermission) and by chat
 * checkout payments (lib/api/checkoutPay.js). Mirror of the site's count:
 * web/lib/custody/allowanceLeft.ts. test/passkeyCapPaths.test.js runs both on
 * the same rows.
 */

const { listedBySymbol } = require('../listedTokens');

const DAY_MS = 24 * 3600 * 1000;
const LIVE_STATUSES = ['pending', 'submitted', 'confirmed'];

/** A numeric column's text as base units, rounded up so a sum never comes out short. */
function textToUnits(text, decimals) {
  const [whole, frac = ''] = String(text ?? '0').trim().split('.');
  const units = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '0').padEnd(decimals, '0'));
  return /[1-9]/.test(frac.slice(decimals)) ? units + 1n : units;
}

/** Decimals of an asset a daily permission covers: ETH and FLZ 18, tUSD as listed. */
function permissionDecimals(symbol) {
  if (symbol === 'TUSD') return Number(listedBySymbol('TUSD').decimals);
  return 18;
}

/**
 * This account's owner-key payments in this asset over the last 24 hours, not
 * failed, each row once. Throws when the rows cannot be read.
 */
async function ownerKeyUnitsToday(supabase, accountId, asset, decimals, now = Date.now()) {
  const since = new Date(now - DAY_MS).toISOString();
  const base = () =>
    supabase
      .from('transfers')
      .select('id, amount_eth')
      .eq('account_id', accountId)
      .eq('asset', asset)
      .in('status', LIVE_STATUSES)
      .gte('created_at', since);
  const [checkouts, sitePays] = await Promise.all([base().eq('note', 'Checkout'), base().eq('phone', 'site').eq('kind', 'transfer')]);
  if (checkouts.error) throw new Error(checkouts.error.message);
  if (sitePays.error) throw new Error(sitePays.error.message);
  const seen = new Map();
  // A site checkout payment is in both lists: once by its id.
  for (const row of [...(checkouts.data || []), ...(sitePays.data || [])]) seen.set(row.id != null ? String(row.id) : row, row.amount_eth);
  let sum = 0n;
  for (const amount of seen.values()) sum += textToUnits(amount, decimals);
  return sum;
}

module.exports = { textToUnits, permissionDecimals, ownerKeyUnitsToday };
