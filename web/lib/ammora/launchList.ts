/**
 * How the Ammora launches slide groups a catalog row.
 *
 * Active means Ammora would route it right now. Upcoming is a launch that is
 * ready to migrate and is not tradable yet. Everything else is not tradable.
 * There is no dollar price and no market cap in this catalog, so the slide
 * does not invent either.
 */

export type LaunchRow = {
  address: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
};

export type LaunchPhase = 'active' | 'upcoming' | 'not_tradable';

export type LaunchFilter = 'all' | LaunchPhase;

export type LaunchSort = 'active' | 'name' | 'name_desc';

export function launchPhase(row: { status: string; tradable: boolean }): LaunchPhase {
  if (row.tradable) return 'active';
  if (row.status === 'ready to migrate') return 'upcoming';
  return 'not_tradable';
}

/**
 * The launches one chip, one search and one sort are allowed to show.
 * Search matches the symbol, the name or the contract. Sort never uses a
 * price, because the catalog has none.
 */
export function filterLaunches<T extends LaunchRow>(
  rows: T[],
  opts: { phase: LaunchFilter; query: string; sort: LaunchSort }
): T[] {
  const q = opts.query.trim().toLowerCase();
  const matched = rows.filter((row) => {
    if (opts.phase !== 'all' && launchPhase(row) !== opts.phase) return false;
    if (!q) return true;
    return (
      row.symbol.toLowerCase().includes(q) ||
      row.name.toLowerCase().includes(q) ||
      row.address.toLowerCase().includes(q)
    );
  });
  const rank = (row: T) => (launchPhase(row) === 'active' ? 0 : launchPhase(row) === 'upcoming' ? 1 : 2);
  const bySymbol = (a: T, b: T) => a.symbol.localeCompare(b.symbol);
  const out = matched.slice();
  if (opts.sort === 'name') out.sort(bySymbol);
  else if (opts.sort === 'name_desc') out.sort((a, b) => bySymbol(b, a));
  else out.sort((a, b) => rank(a) - rank(b) || bySymbol(a, b));
  return out;
}
