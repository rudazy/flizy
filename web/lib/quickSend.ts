/**
 * Quick send on the money screens: whether the page can leave the PIN out.
 * Display only. The server decides again (web/lib/tiers.ts). Plain TypeScript
 * with no React, so client components and node --test can both load it.
 */

/** A plain decimal ETH amount as wei, or null. No floats, so 0.005 is exact. */
function decimalWei(value: string): bigint | null {
  const m = /^(\d*)(?:\.(\d{0,18}))?$/.exec(String(value || '').trim());
  if (!m || (m[1] === '' && !m[2])) return null;
  return BigInt(m[1] || '0') * 10n ** 18n + BigInt((m[2] || '').padEnd(18, '0') || '0');
}

/**
 * Whether the page can leave the PIN out: a positive amount at or under the
 * quick-send amount. Display only. The server decides again from what it will
 * actually send, and answers PIN_REQUIRED when the PIN is needed after all.
 */
export function withinQuickSend(amount: string, quickSendEth: string | null | undefined): boolean {
  const a = decimalWei(amount);
  const q = decimalWei(String(quickSendEth ?? ''));
  return a != null && q != null && a > 0n && q > 0n && a <= q;
}
