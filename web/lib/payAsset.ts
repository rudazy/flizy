/** Listed assets the public /pay/{name} page may send. Same list as chat pay. */

export const PAY_ASSETS = ['ETH', 'FLZ'] as const;
export type PayAsset = (typeof PAY_ASSETS)[number];

export function normalizePayAsset(raw: unknown): PayAsset {
  const s = String(raw || 'ETH')
    .trim()
    .toUpperCase();
  if (!s || s === 'ETH' || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  if (s === 'FLZ' || s === 'FLIZY') return 'FLZ';
  throw new Error('Unknown token. Listed: ETH, FLZ.');
}
