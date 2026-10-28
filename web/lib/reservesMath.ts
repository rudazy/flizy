/**
 * Available is the chain balance minus Savings, in base units.
 * Mirror of the math in lib/reserves.js. No imports, so a test can load it.
 * Display does not subtract gas. A spend of ETH does, in the caller.
 */

export const SAVINGS_HELPER =
  'Funds here are not available for normal spending. This is not a bank account and it does not earn yield.';

function asBase(value: bigint | string | number): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('negative base');
    return value;
  }
  const text = String(value ?? '0').trim();
  if (!/^[0-9]+$/.test(text)) throw new Error('bad base');
  return BigInt(text);
}

/** What is left after Savings and, when the caller passes it, gas. Never negative. */
export function availableBase(holding: bigint | string | number, reserved: bigint | string | number, gas: bigint | string | number = 0n): bigint {
  const left = asBase(holding) - asBase(reserved) - asBase(gas);
  return left > 0n ? left : 0n;
}

/** An amount that lands exactly on the line is allowed. One unit over is not. */
export function covers(
  holding: bigint | string | number,
  reserved: bigint | string | number,
  amount: bigint | string | number,
  gas: bigint | string | number = 0n
): boolean {
  return asBase(holding) - asBase(reserved) - asBase(gas) >= asBase(amount);
}

/** ETH gas stays in Available only when ETH is moving into Savings. */
export function reserveMoveGas(asset: string, direction: string, gasBuffer: bigint): bigint {
  if (asset === 'ETH' && direction === 'to_savings') {
    if (gasBuffer < 0n) throw new Error('negative base');
    return gasBuffer;
  }
  return 0n;
}

/** Integer base units. A fraction longer than `decimals` is refused. */
export function parseUnits(value: string, decimals: number): bigint {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('bad amount');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 78) throw new Error('bad decimals');
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) throw new Error('too many decimals');
  const digits = `${whole}${frac.padEnd(decimals, '0')}`.replace(/^0+/, '') || '0';
  return BigInt(digits);
}

export function formatUnits(value: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('bad decimals');
  const neg = value < 0n;
  const raw = (neg ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = decimals === 0 ? raw : raw.slice(0, raw.length - decimals);
  const frac = decimals === 0 ? '' : raw.slice(raw.length - decimals).replace(/0+$/, '');
  const out = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

/** Chain figure minus a Savings row. A bad figure is left alone. */
export function subtractHolding(balance: string, decimals: number, reservedBase: string): string {
  try {
    const have = parseUnits(balance, decimals);
    const keep = asBase(reservedBase || '0');
    const left = have > keep ? have - keep : 0n;
    return formatUnits(left, decimals);
  } catch {
    return balance;
  }
}
