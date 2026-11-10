/**
 * Paused features. Flizy is payments-first; these are hidden from the app and
 * take no new activity unless their switch is set to "on" in the environment.
 * Payments, swapping, every listed token, liquidity, limit orders, Ammora and
 * Copy Trade are not here: they are never switched off by this file.
 *
 * What people already own stays reachable whatever these say: owned NFTs show
 * in the wallet and can be sent in chat, listings and offers can be cancelled,
 * sale and mint credits can be withdrawn, open tasks can be cancelled and their
 * winners published.
 *
 * Read on the server. The values are only on or off, so the root layout also
 * hands them to the browser (components/FeaturesProvider.tsx) to hide entries.
 * The bots read the same switches (lib/features.js).
 *
 * No imports, so node --test loads this file directly.
 */

export const FEATURE_ENV = {
  /** NFT marketplace: listing, buying, offers, accepting offers. */
  nftMarket: 'FEATURE_NFT_MARKET',
  /** NFT minting and collections, including Copy Mint. */
  nftMint: 'FEATURE_NFT_MINT',
  /** Tasks and campaigns. */
  tasks: 'FEATURE_TASKS',
  /** Projects and the XP leaderboard. */
  projects: 'FEATURE_PROJECTS',
  /** Token theses, comments, likes and the watchlist. */
  tokenSocial: 'FEATURE_TOKEN_SOCIAL',
  /** Following people and the people directory. /u/<username> stays a pay page. */
  follows: 'FEATURE_FOLLOWS',
} as const;

export type Feature = keyof typeof FEATURE_ENV;
export type FeatureFlags = Record<Feature, boolean>;

export const FEATURES = Object.keys(FEATURE_ENV) as Feature[];

/** The answer when a request asks a paused feature for something new. */
export const PAUSED_MESSAGE = 'This is paused on Flizy for now. Anything you already have still works.';

export function featureOn(feature: Feature, env: Record<string, string | undefined> = process.env): boolean {
  return String(env[FEATURE_ENV[feature]] || '').trim().toLowerCase() === 'on';
}

export function featureFlags(env: Record<string, string | undefined> = process.env): FeatureFlags {
  return Object.fromEntries(FEATURES.map((f) => [f, featureOn(f, env)])) as FeatureFlags;
}

/** A 403 body for a route asked to start something a paused feature does. */
export function pausedBody(): { error: string; code: 'feature_paused' } {
  return { error: PAUSED_MESSAGE, code: 'feature_paused' };
}
