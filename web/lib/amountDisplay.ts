/**
 * How an amount is written, everywhere (site half).
 *
 * Deliberate mirror of lib/amountDisplay.js -- client components cannot reach
 * into the bot package, so the rule is written twice and pinned by
 * test/amountDisplay.test.js, which loads both and compares them on the same
 * vectors. Change one side, change the other, or that test fails.
 *
 * No imports on purpose, so node --test can load this file directly.
 *
 * Why the rule is what it is, and why there is no fiat in it: see the header of
 * lib/amountDisplay.js.
 */

/** Below this a six-decimal rendering would read as plain zero. */
export const EXPONENTIAL_BELOW = 0.000001;

/** Display cap. Not a statement about how much precision the value has. */
export const MAX_DECIMALS = 6;

export function formatAmount(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  if (Math.abs(n) < EXPONENTIAL_BELOW) return n.toExponential(4);

  const fixed = n.toFixed(MAX_DECIMALS).replace(/\.?0+$/, '');
  const dot = fixed.indexOf('.');
  const whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const fraction = dot === -1 ? '' : fixed.slice(dot + 1);

  // Pinned locale: grouping must not depend on who is reading.
  const grouped = Number(whole).toLocaleString('en-US');
  return fraction ? `${grouped}.${fraction}` : grouped;
}
