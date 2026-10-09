/**
 * The figures on the Account card and the first-steps guide: how many swaps
 * and sends went through, and how much ETH the account moved in them.
 *
 * Only confirmed rows count. A swap's ETH side is whichever leg was ETH: the
 * amount paid when buying, the amount received when selling. A send in a token
 * other than ETH adds nothing to an ETH volume rather than being guessed at.
 *
 * No imports on purpose, so node --test can load this file directly.
 */

export type StatsRow = {
  kind?: string | null;
  status?: string | null;
  asset?: string | null;
  amount_eth?: string | number | null;
  amount_secondary?: string | number | null;
  asset_secondary?: string | null;
};

export type AccountStats = { swaps: number; sends: number; volumeEth: number };

function positive(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function summarizeAccountStats(rows: StatsRow[]): AccountStats {
  let swaps = 0;
  let sends = 0;
  let volumeEth = 0;
  for (const row of rows) {
    if (String(row.status || '').toLowerCase() !== 'confirmed') continue;
    const kind = String(row.kind || 'transfer').toLowerCase();
    const asset = String(row.asset || 'ETH').toUpperCase();
    if (kind === 'swap') {
      swaps += 1;
      if (asset === 'ETH') volumeEth += positive(row.amount_eth);
      else if (String(row.asset_secondary || '').toUpperCase() === 'ETH') volumeEth += positive(row.amount_secondary);
    } else if (kind === 'transfer') {
      sends += 1;
      if (asset === 'ETH') volumeEth += positive(row.amount_eth);
    }
  }
  return { swaps, sends, volumeEth };
}
