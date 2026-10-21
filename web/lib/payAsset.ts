/** Listed assets the public /pay/{name} page may send. Same list as chat pay. */

export const PAY_ASSETS = ['ETH', 'FLZ', 'TUSD'] as const;
export type PayAsset = (typeof PAY_ASSETS)[number];

export const UNKNOWN_PAY_ASSET = 'Unknown token. Listed: ETH, FLZ, tUSD.';

export function normalizePayAsset(raw: unknown): PayAsset {
  const s = String(raw || 'ETH')
    .trim()
    .toUpperCase();
  if (!s || s === 'ETH' || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  if (s === 'FLZ' || s === 'FLIZY') return 'FLZ';
  if (s === 'TUSD' || s === 'USD') return 'TUSD';
  throw new Error(UNKNOWN_PAY_ASSET);
}
