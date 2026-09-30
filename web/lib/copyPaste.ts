/**
 * Split a pasted wallet list for the screen.
 *
 * The server checks the same shapes again before anything is stored. This
 * file stays free of the database client so the page can use it.
 */

const ZERO = '0x0000000000000000000000000000000000000000';

export function walletLabel(index: number): string {
  if (index >= 0 && index < 26) return `Wallet ${String.fromCharCode(65 + index)}`;
  return `Wallet ${index + 1}`;
}

export function splitWalletPaste(
  raw: string,
  existing: string[]
): { addresses: string[]; skipped: number; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { addresses: [], skipped: 0, error: 'Paste wallet addresses.' };
  }
  if (raw.length > 8000) {
    return { addresses: [], skipped: 0, error: 'That paste is too long.' };
  }
  const taken = new Set(existing.map((address) => address.toLowerCase()));
  const addresses: string[] = [];
  let skipped = 0;
  for (const part of raw.split(/[\s,;]+/).filter(Boolean)) {
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(part)) {
      return {
        addresses: [],
        skipped: 0,
        error: 'Paste addresses only. A line looked like a key, so nothing was added.',
      };
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(part) || part.toLowerCase() === ZERO) {
      skipped += 1;
      continue;
    }
    const key = part.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    addresses.push(part);
  }
  if (existing.length + addresses.length > 100) {
    return { addresses: [], skipped: 0, error: '100 wallets is the limit.' };
  }
  if (!addresses.length) {
    return { addresses: [], skipped, error: skipped ? 'None of those lines were wallet addresses.' : '' };
  }
  return { addresses, skipped, error: '' };
}
