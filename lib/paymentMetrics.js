/**
 * Whether people pay each other on Flizy, as numbers.
 *
 * Swaps and sign-ups say people arrived. These say they came back to pay:
 *   - weeklyActivePayers: accounts with a confirmed payment in the last 7 days
 *   - monthlyActivePayers: the same over 30 days
 *   - repeatPairs: payer and payee pairs with two or more confirmed payments
 *     in the last 30 days, the clearest sign a payment habit has formed
 *   - payments7d / payments30d: confirmed payments in each window
 *
 * A payment is an outgoing confirmed transfers row of kind 'transfer' from a
 * Flizy account: sends, pay links, request payments, pot contributions, pay
 * with ETH. Payments from outside wallets have no payer account, so they are
 * counted apart (externalPayments30d) and never inflate the payer numbers.
 *
 * Pure: takes rows, returns counts. scripts/payment-metrics.js does the read.
 */

const DAY_MS = 86400e3;

/**
 * @param {Array<{ account_id: string|null, to_address: string|null, created_at: string, phone?: string|null }>} rows
 *   confirmed outgoing payments from the last 30 days or more
 * @param {number} [now]
 */
function paymentMetrics(rows, now = Date.now()) {
  const since7 = now - 7 * DAY_MS;
  const since30 = now - 30 * DAY_MS;
  const payers7 = new Set();
  const payers30 = new Set();
  const pairs = new Map();
  let payments7d = 0;
  let payments30d = 0;
  let externalPayments30d = 0;

  for (const row of rows || []) {
    const at = new Date(row.created_at).getTime();
    if (!Number.isFinite(at) || at < since30 || at > now) continue;
    if (!row.account_id) {
      if (row.phone === 'external') externalPayments30d += 1;
      continue;
    }
    const payer = String(row.account_id);
    payments30d += 1;
    payers30.add(payer);
    if (at >= since7) {
      payments7d += 1;
      payers7.add(payer);
    }
    const payee = String(row.to_address || '').toLowerCase();
    if (payee) {
      const key = `${payer}|${payee}`;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
  }

  let repeatPairs = 0;
  for (const count of pairs.values()) if (count >= 2) repeatPairs += 1;

  return {
    weeklyActivePayers: payers7.size,
    monthlyActivePayers: payers30.size,
    repeatPairs,
    payments7d,
    payments30d,
    externalPayments30d,
  };
}

module.exports = { paymentMetrics };
