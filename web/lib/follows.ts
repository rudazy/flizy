/**
 * Follow rules and the public profile shape.
 *
 * A follow is a pair of accounts. The database primary key is what makes a
 * second follow of the same person impossible. This module decides whether a
 * write should be attempted, and it builds the object a browser is allowed to
 * see. It does not talk to the database. No imports that open a connection.
 */

import { displaySafeLabel } from './sanitize.ts';
import { validateUsername } from './username.ts';

/** Matches the cap enforced by account_follows_before_insert. */
export const FOLLOW_CAP = 1000;

export type PublicPerson = {
  username: string;
  displayName: string | null;
};

export type ProfileActivity = {
  title: string;
  detail: string;
  at: string;
};

export type ProfilePayload = {
  username: string;
  displayName: string | null;
  isSelf: boolean;
  signedIn: boolean;
  following: boolean;
  alerts: boolean;
  /** This viewer's choice. False unless they follow this profile and turned it on. */
  copyTrade: boolean;
  showSocial: boolean;
  showStats: boolean;
  /** Owner's switch. Other people see activity only when this is true. */
  showActivity: boolean;
  /** Owner's switch. Other people see the wallet address only when this is true. */
  showWallet: boolean;
  /** Owner's switch. Other people see the ETH balance only when this is true. */
  showPortfolio: boolean;
  /** False hides the profile from search. The direct link still opens. */
  profilePublic: boolean;
  /** Checksummed address, or null when this viewer must not see it. */
  wallet: string | null;
  /** Wallet ETH balance, or null when this viewer must not see it or the read failed. */
  portfolioEth: number | null;
  followers: number | null;
  followingCount: number | null;
  swaps: number | null;
  volumeEth: number | null;
  activity: ProfileActivity[];
  followedBy: PublicPerson[];
  followedByMore: number;
  followedByCapped: boolean;
};

export type FollowWrite = 'insert' | 'keep' | 'delete' | 'alerts' | 'copy';

export type FollowDecision =
  | { ok: true; write: FollowWrite }
  | { ok: false; status: 400 | 404 | 409; error: string };

/** Whether this follow action may be written. The route still checks the session. */
export function decideFollow(input: {
  viewerId: string;
  targetId: string | null;
  targetOpen: boolean;
  already: boolean;
  action: 'follow' | 'unfollow' | 'alerts' | 'copy';
}): FollowDecision {
  if (!input.targetId || !input.targetOpen) {
    return { ok: false, status: 404, error: 'No profile with that username.' };
  }
  if (input.viewerId === input.targetId) {
    return { ok: false, status: 400, error: 'You cannot follow yourself.' };
  }
  if ((input.action === 'alerts' || input.action === 'copy') && !input.already) {
    return { ok: false, status: 409, error: 'Follow them first.' };
  }
  // A second follow of the same person must not insert. The cap trigger runs
  // before the duplicate is ignored, so an account already at 1000 would be refused.
  if (input.action === 'follow' && input.already) return { ok: true, write: 'keep' };
  if (input.action === 'unfollow') return { ok: true, write: 'delete' };
  if (input.action === 'alerts') return { ok: true, write: 'alerts' };
  if (input.action === 'copy') return { ok: true, write: 'copy' };
  return { ok: true, write: 'insert' };
}

/** A leading slice of a Flizy username. Empty means the list is not filtered. */
export function listPrefix(raw: unknown): { ok: true; prefix: string } | { ok: false } {
  const q = String(raw ?? '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
  if (!q) return { ok: true, prefix: '' };
  if (!/^[a-z][a-z0-9]{0,23}$/.test(q)) return { ok: false };
  return { ok: true, prefix: q };
}

/**
 * Directory search. Two characters minimum, so one letter cannot walk the
 * accounts. An empty box is not a search: the page shows suggestions instead.
 */
export function searchPrefix(raw: unknown): { ok: true; prefix: string } | { ok: false; empty: boolean } {
  const parsed = listPrefix(raw);
  if (!parsed.ok) return { ok: false, empty: false };
  if (parsed.prefix.length < 2) return { ok: false, empty: parsed.prefix.length === 0 };
  return { ok: true, prefix: parsed.prefix };
}

/** Public profile path. Username is already the canonical lowercase form. */
export function profilePath(username: string): string {
  return `/u/${encodeURIComponent(username)}`;
}

/** A label safe to print, or null when the account has no public name. */
export function publicPerson(row: { username?: string | null; display_name?: string | null } | null | undefined): PublicPerson | null {
  const checked = validateUsername(row?.username);
  if (!checked.ok) return null;
  const displayName = displaySafeLabel(row?.display_name, 64);
  return { username: checked.username, displayName: displayName || null };
}

/** ETH volume, short enough for a stat tile. Same cuts as the account card. */
export function formatVolumeEth(eth: number): string {
  if (!(eth > 0)) return '0';
  if (eth < 0.001) return '<0.001';
  return eth.toLocaleString('en-US', { maximumFractionDigits: eth < 1 ? 3 : 2 });
}

/** A confirmed swap the profile may show. Addresses and other people's names are dropped. */
export function publicSwap(
  row: {
    kind?: string | null;
    status?: string | null;
    asset?: string | null;
    asset_secondary?: string | null;
    created_at?: string | null;
  },
  now = Date.now()
): ProfileActivity | null {
  if (String(row.status || '').toLowerCase() !== 'confirmed') return null;
  if (String(row.kind || '').toLowerCase() !== 'swap') return null;
  const from = tradeSymbol(row.asset);
  const to = tradeSymbol(row.asset_secondary);
  const detail = from && to ? `${from} for ${to}` : from || to || 'On GIWA';
  return { title: 'Swapped', detail, at: row.created_at ? relativeTime(row.created_at, now) : '' };
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const seconds = Math.max(0, Math.round((now - t) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** Columns written when the account picks Public or Private. */
export function visibilityPatch(mode: 'public' | 'private'): {
  profile_public: boolean;
  profile_show_social: boolean;
  profile_show_stats: boolean;
  profile_show_activity: boolean;
  profile_show_wallet: boolean;
  profile_show_portfolio: boolean;
  scan_show_username: boolean;
} {
  const on = mode === 'public';
  return {
    profile_public: on,
    profile_show_social: on,
    profile_show_stats: on,
    profile_show_activity: on,
    profile_show_wallet: on,
    profile_show_portfolio: on,
    scan_show_username: on,
  };
}

/**
 * The profile a browser receives.
 *
 * The owner always sees their own counts, trading figures, activity, wallet
 * address, and ETH balance. Everyone else sees each of those only while that
 * switch is on. Follower counts do not follow the activity switch. Account
 * ids never enter this object. copyTrade is this viewer's saved choice, not
 * a trade.
 */
export function publicProfile(input: {
  username: string;
  displayName: string | null;
  isSelf: boolean;
  signedIn: boolean;
  following: boolean;
  alerts: boolean;
  copyTrade: boolean;
  showSocial: boolean;
  showStats: boolean;
  showActivity: boolean;
  showWallet?: boolean;
  showPortfolio?: boolean;
  profilePublic?: boolean;
  wallet?: string | null;
  portfolioEth?: number | null;
  followers: number;
  followingCount: number;
  swaps: number;
  volumeEth: number;
  activity: ProfileActivity[];
  followedBy: PublicPerson[];
  followedByCapped: boolean;
}): ProfilePayload {
  const social = input.isSelf || input.showSocial;
  const stats = input.isSelf || input.showStats;
  const activityOpen = input.isSelf || input.showActivity === true;
  const showWallet = input.showWallet === true;
  const showPortfolio = input.showPortfolio === true;
  const followedBy = social ? input.followedBy.slice(0, 3) : [];
  return {
    username: input.username,
    displayName: input.displayName,
    isSelf: input.isSelf,
    signedIn: input.signedIn,
    following: input.isSelf ? false : input.following,
    alerts: input.alerts === true,
    copyTrade: input.isSelf ? false : input.copyTrade === true,
    showSocial: input.showSocial,
    showStats: input.showStats,
    showActivity: input.showActivity === true,
    showWallet,
    showPortfolio,
    profilePublic: input.profilePublic !== false,
    wallet: input.isSelf || showWallet ? publicWallet(input.wallet) : null,
    portfolioEth: input.isSelf || showPortfolio ? publicEth(input.portfolioEth) : null,
    followers: social ? input.followers : null,
    followingCount: social ? input.followingCount : null,
    swaps: stats ? input.swaps : null,
    volumeEth: stats ? input.volumeEth : null,
    activity: activityOpen ? input.activity : [],
    followedBy,
    followedByMore: social ? Math.max(0, input.followedBy.length - followedBy.length) : 0,
    followedByCapped: social ? input.followedByCapped : false,
  };
}

function publicWallet(raw: string | null | undefined): string | null {
  const text = String(raw || '');
  return /^0x[a-fA-F0-9]{40}$/.test(text) ? text : null;
}

function publicEth(raw: number | null | undefined): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

function tradeSymbol(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(s)) return '';
  if (/^tusd$/i.test(s)) return 'tUSD';
  return s.toUpperCase();
}
