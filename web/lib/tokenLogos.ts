import { listedByAddress, listedBySymbol } from './listedTokens.ts';

/** FLZ's mark, the same F as the Flizy logo. */
export const FLZ_LOGO = '/tokens/flz.svg';

/** Same literal the swap config falls back to when the chain env is unset. */
const FLZ_ADDRESS = '0x308be8f71da695f18e70d2243a446e1fd1566ba6';

/**
 * The logo for FLZ or a listed token, or null.
 *
 * With a contract address the match is by address only: anyone can deploy a
 * token called IZY, and it must not borrow IZY's logo in a wallet. Without one,
 * the symbol is trusted, so pass a bare symbol only where it came from Flizy's
 * own lists (the token API, the swap picker).
 */
export function tokenLogo(symbol: string | null | undefined, address?: string | null): string | null {
  if (address) {
    if (address.toLowerCase() === FLZ_ADDRESS) return FLZ_LOGO;
    return listedByAddress(address)?.logo ?? null;
  }
  const upper = String(symbol || '').trim().toUpperCase();
  if (upper === 'FLZ') return FLZ_LOGO;
  return listedBySymbol(upper)?.logo ?? null;
}
