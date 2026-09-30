/** Display helpers for pool figures. ETH only. No dollar conversion. */

export function formatPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

/** Fixed point wide enough for any token's decimals (the add flow allows 0 to 36). */
const SPEND_SCALE = 36;
const GAS_RESERVE = '0.00008';

function toScaled(raw: string): bigint | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(raw.trim());
  if (!m) return null;
  const frac = (m[2] || '').slice(0, SPEND_SCALE).padEnd(SPEND_SCALE, '0');
  return BigInt(m[1]) * 10n ** BigInt(SPEND_SCALE) + BigInt(frac);
}

/**
 * The largest amount the Max button may fill in: never more than the balance.
 * Exact decimal arithmetic, truncated, never rounded: a rounded-up figure is
 * one the chain refuses. Six decimals from 1 up, six significant digits below.
 * ETH spends leave 0.00008 ETH for gas, the same remainder as the swap screen.
 */
export function maxSpend(balance: string | null, payingWithEth: boolean): string | null {
  if (balance == null) return null;
  let value = toScaled(balance);
  if (value == null || value <= 0n) return null;
  if (payingWithEth) value -= toScaled(GAS_RESERVE) as bigint;
  if (value <= 0n) return null;
  const digits = value.toString().padStart(SPEND_SCALE + 1, '0');
  const whole = digits.slice(0, -SPEND_SCALE);
  const frac = digits.slice(-SPEND_SCALE);
  const keep = whole !== '0' ? 6 : frac.search(/[1-9]/) + 6;
  const out = `${whole}.${frac.slice(0, keep)}`.replace(/\.?0+$/, '');
  return out === '0' || out === '' ? null : out;
}

export function formatEthDisplay(raw: string | number | null, digits = 6): string | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return '0';
  const abs = Math.abs(n);
  const places = abs >= 1000 ? 2 : abs >= 1 ? 4 : digits;
  return n.toLocaleString('en-US', { maximumFractionDigits: places });
}
