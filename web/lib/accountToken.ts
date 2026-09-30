/**
 * Shape checks for a token contract someone wants on their wallet.
 *
 * Adding a contract does not verify it. Verification is what allows a social
 * send, and that set is decided elsewhere. This file does not talk to a chain
 * or a database, so the wallet screen can share the same refusals later.
 */

const ZERO = '0x0000000000000000000000000000000000000000';
const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

export const MAX_ACCOUNT_TOKENS = 50;

export function parseTokenContract(raw: string): { address: string } | { error: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { error: 'Paste a token contract.' };
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
    return { error: 'That looked like a key. Paste a token contract.' };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(text) || text.toLowerCase() === ZERO) {
    return { error: 'That is not a token contract.' };
  }
  return { address: text };
}

/** A chain symbol is stored only when it is a short ticker. Otherwise a label from the address. */
export function tokenSymbolFromChain(raw: unknown, address: string): string {
  const text = String(raw ?? '').trim();
  if (SYMBOL.test(text)) return text;
  const suffix = String(address).replace(/^0x/i, '').slice(0, 4).toUpperCase();
  const fallback = `T${suffix || 'TOKEN'}`.slice(0, 32);
  return SYMBOL.test(fallback) ? fallback : 'TOKEN';
}

export function tokenDecimalsFromChain(raw: unknown): number | null {
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 36) return null;
  return n;
}
