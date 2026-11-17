/**
 * Dollars for the admin dashboards: cents from $1, and up to four decimals
 * below it, where fees and rewards are small.
 */
export function usdText(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1 || abs === 0) return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${sign}$${Number(abs.toFixed(4))}`;
}
