/**
 * Top holders for the FLZ page.
 *
 * The explorer only chooses which addresses to ask about. Balances and the
 * share are applied by the caller from the chain, so a bad explorer figure
 * cannot become the amount on screen.
 */

const UNIT = 10n ** 18n;

export type HolderBalance = {
  address: string;
  balance: bigint;
};

export type HolderView = {
  address: string;
  label: string | null;
  amount: string;
};

function grouped(whole: bigint): string {
  return whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 18-decimal token amount. Large balances keep 4 places. Dust keeps 8. */
function formatTokenAmount(value: bigint): string {
  if (value <= 0n) return '0';
  const places = value >= UNIT / 10000n ? 4 : 8;
  const scale = 10n ** BigInt(18 - places);
  const half = scale / 2n;
  let scaled = (value + half) / scale;
  const base = 10n ** BigInt(places);
  let whole = scaled / base;
  let digits = scaled % base;
  if (digits === base) {
    whole += 1n;
    digits = 0n;
  }
  if (digits === 0n) return grouped(whole);
  const frac = digits.toString().padStart(places, '0').replace(/0+$/, '');
  return `${grouped(whole)}.${frac}`;
}

/** One decimal, half up. Null when the supply cannot be a denominator. */
export function percentOf(part: bigint, whole: bigint): string | null {
  if (whole <= 0n || part < 0n) return null;
  const capped = part > whole ? whole : part;
  const tenths = (capped * 1000n + whole / 2n) / whole;
  const shown = tenths > 1000n ? 1000n : tenths;
  return `${shown / 10n}.${shown % 10n}%`;
}

export function holderAddresses(body: unknown, limit = 15): string[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { items?: unknown }).items)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of (body as { items: unknown[] }).items) {
    if (!item || typeof item !== 'object') continue;
    const hash = (item as { address?: { hash?: unknown } }).address?.hash;
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(hash)) continue;
    const key = hash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hash);
    if (out.length >= limit) break;
  }
  return out;
}

export function holderCount(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as { holders_count?: unknown }).holders_count;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw);
  if (!/^[0-9]+$/.test(text)) return null;
  const count = Number(text);
  if (!Number.isInteger(count) || count < 0 || count > 10_000_000) return null;
  return count;
}

export function presentHolders(
  rows: HolderBalance[],
  supply: bigint,
  pair: string | null
): { holders: HolderView[]; topShare: string | null } {
  const pairKey = pair ? pair.toLowerCase() : '';
  const ranked = rows
    .filter((row) => /^0x[0-9a-fA-F]{40}$/.test(row.address) && row.balance > 0n)
    .sort((left, right) => (left.balance === right.balance ? 0 : left.balance > right.balance ? -1 : 1))
    .slice(0, 10);
  const held = ranked.reduce((sum, row) => sum + row.balance, 0n);
  return {
    holders: ranked.map((row) => ({
      address: row.address,
      label: pairKey && row.address.toLowerCase() === pairKey ? 'Pool' : null,
      amount: formatTokenAmount(row.balance),
    })),
    topShare: percentOf(held, supply),
  };
}
