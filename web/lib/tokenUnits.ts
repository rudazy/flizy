/**
 * Decimal amounts and on-chain units, in bigint, for the deposit dialog
 * (web/components/DepositSheet.tsx). Exact: no floating point between what
 * the person sees and what the wallet signs.
 */

/** "1.5" in units of `decimals`, or null when it is not a plain amount or has too many decimals. */
export function toUnits(value: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(value) || value === '' || value === '.') return null;
  const [whole, frac = ''] = value.split('.');
  if (frac.length > decimals) return null;
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Units as a decimal string, rounded down to `dp` places, trailing zeros dropped. */
export function fromUnits(units: bigint, decimals: number, dp: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (units % base).toString().padStart(decimals, '0').slice(0, dp).replace(/0+$/, '');
  return frac ? `${units / base}.${frac}` : `${units / base}`;
}

/** `share` percent (0 to 100, two decimals kept) of `max`, rounded down. */
export function shareOf(max: bigint, share: number): bigint {
  const basisPoints = BigInt(Math.round(Math.min(100, Math.max(0, share)) * 100));
  return (max * basisPoints) / 10000n;
}
