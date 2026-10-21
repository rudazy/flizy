/**
 * Print Flizy's payment metrics: weekly and monthly active payers, repeat
 * payer and payee pairs, and payment counts (lib/paymentMetrics.js).
 *
 * Read only, aggregates only: no row, address, id or username is printed. It
 * reads whatever database the environment points at, through the same service
 * role client the bot uses, so check which one that is before running it.
 *
 * Usage (Windows CMD):
 *   node scripts\payment-metrics.js
 */

const { getSupabase } = require('../lib/supabase');
const { paymentMetrics } = require('../lib/paymentMetrics');

const PAGE = 1000;
const MAX_ROWS = 50000;

async function main() {
  const supabase = getSupabase();
  const since = new Date(Date.now() - 30 * 86400e3).toISOString();
  const rows = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await supabase
      .from('transfers')
      .select('account_id, to_address, created_at, phone')
      .eq('status', 'confirmed')
      .eq('kind', 'transfer')
      .eq('direction', 'out')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }

  const m = paymentMetrics(rows);
  const lines = [
    `Payment metrics at ${new Date().toISOString()}`,
    `  Weekly active payers:   ${m.weeklyActivePayers}`,
    `  Monthly active payers:  ${m.monthlyActivePayers}`,
    `  Repeat pairs (30 days): ${m.repeatPairs}`,
    `  Payments, 7 days:       ${m.payments7d}`,
    `  Payments, 30 days:      ${m.payments30d}`,
    `  From outside wallets:   ${m.externalPayments30d} (30 days)`,
  ];
  if (rows.length >= MAX_ROWS) lines.push(`  Read stopped at ${MAX_ROWS} rows; the counts are a floor.`);
  console.log(lines.join('\n'));
}

main().catch((err) => {
  console.error(`payment-metrics: ${String(err && err.message ? err.message : err).slice(0, 200)}`);
  process.exit(1);
});
