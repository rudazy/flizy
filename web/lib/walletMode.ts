/**
 * Wallet mode: the parts of the app a visitor can use with their own wallet,
 * without a Flizy account.
 *
 * Browsing and trading only, where the wallet signs its own transaction:
 * Explore (tokens and NFTs), a token's page, a collection and its items, My
 * NFTs, and Swap. Everything that needs a Flizy account stays behind one: chat
 * payments, pay by username, requests, claims, the faucet, the Flizy wallet,
 * mint creation, limit orders (the bot fills them from a Flizy wallet),
 * declining an offer, and theses. NFT likes are kept in the visitor's browser
 * (lib/guestLikes.ts). Nothing about a wallet-mode visitor is stored on the
 * server.
 *
 * Pure, so node --test loads it directly.
 */

const WALLET_MODE_PATHS: readonly RegExp[] = [
  /^\/dashboard\/swap\/?$/,
  /^\/dashboard\/explore\/?$/,
  /^\/dashboard\/explore\/tokens\/[^/]+\/?$/,
  /^\/dashboard\/explore\/nfts\/?$/,
  // A collection and an item, but not the creation studio or the mint pages.
  /^\/dashboard\/explore\/nfts\/(?!create\/?$|mint\/|mints\/?|me\/?$)[^/]+\/?$/,
  /^\/dashboard\/explore\/nfts\/(?!mint\/|mints\/)[^/]+\/[^/]+\/?$/,
  // My NFTs: what the wallet holds and its offers, read from the chain by
  // address, and the NFTs it hearted, kept in this browser (lib/guestLikes.ts).
  /^\/dashboard\/explore\/nfts\/me\/?$/,
];

/** Whether this dashboard path works with a connected wallet and no Flizy account. */
export function isWalletModePath(pathname: string | null | undefined): boolean {
  const path = String(pathname || '').split('?')[0];
  return WALLET_MODE_PATHS.some((re) => re.test(path));
}

/** Where "Continue with a wallet" lands. */
export const WALLET_MODE_HOME = '/dashboard/explore';
